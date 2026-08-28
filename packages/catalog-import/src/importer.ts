import { basename, resolve } from 'node:path';
import { Buffer } from 'node:buffer';

import { GtinValidationError, normalizeGtin } from '@notons/shared';

import {
  CatalogImportErrorBase,
  DuplicateImportError,
  ImportInterruptedError,
  ResumableImportExistsError,
} from './errors.js';
import { calculateFileChecksum, readCatalogRows } from './source.js';
import type {
  CatalogImportError,
  CatalogImportOptions,
  CatalogImportResult,
  ImportCounters,
  ImportProduct,
  ImportProgress,
  ImportSession,
  MappedCatalogProduct,
  RawCatalogRow,
  CatalogActivationResult,
} from './types.js';

const DEFAULT_BATCH_SIZE = 500;
// Enriched OFF rows use fewer than 60 SQL parameters. This ceiling keeps the
// generated statement below PostgreSQL's 65,535-parameter protocol limit.
const MAX_BATCH_SIZE = 1_000;
const MAX_ERROR_SAMPLES = 20;
const MAX_INGREDIENTS_TEXT_LENGTH = 10_000;

const emptyCounters = (): ImportCounters => ({
  currentOffset: 0,
  processedRows: 0,
  insertedRows: 0,
  updatedRows: 0,
  rejectedRows: 0,
  filteredRows: 0,
});

const summarizeRawRow = (row: RawCatalogRow): RawCatalogRow =>
  Object.fromEntries(
    Object.entries(row)
      .slice(0, 30)
      .map(([key, value]) => {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
          return [key.slice(0, 100), typeof value === 'string' ? value.slice(0, 500) : value];
        }
        try {
          return [key.slice(0, 100), JSON.stringify(value).slice(0, 500)];
        } catch {
          return [key.slice(0, 100), '[valeur non sérialisable]'];
        }
      }),
  );

const rawBarcode = (row: RawCatalogRow): string | null => {
  const value = row.code ?? row.barcode ?? row.gtin;
  return value === undefined || value === null ? null : String(value).slice(0, 100);
};

const truncateCodePoints = (value: string, maximum: number): string => {
  let result = '';
  let count = 0;
  for (const character of value) {
    if (count >= maximum) break;
    result += character;
    count += 1;
  }
  return result;
};

const countCodePoints = (value: string): number => Array.from(value).length;

const cleanText = (value: string | null, maximum: number): string | null => {
  if (value === null) return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? truncateCodePoints(cleaned, maximum) : null;
};

const cleanList = (
  value: string[] | null,
  maximumItems = 256,
  maximumBytes = 32_768,
): string[] | null => {
  if (!value) return null;
  const cleaned = value
    .map((item) => cleanText(item, 120))
    .filter((item): item is string => Boolean(item));
  const result: string[] = [];
  let usedBytes = 0;
  for (const item of new Set(cleaned)) {
    const addedBytes = Buffer.byteLength(item, 'utf8') + (result.length > 0 ? 1 : 0);
    if (usedBytes + addedBytes > maximumBytes) break;
    result.push(item);
    usedBytes += addedBytes;
    if (result.length >= maximumItems) break;
  }
  return result.length > 0 ? result : null;
};

const cleanFiniteNumber = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) ? value : null;

const cleanNutrient = (value: number | null): number | null => {
  const finite = cleanFiniteNumber(value);
  return finite !== null && finite >= 0 && finite <= 1_000_000_000 ? finite : null;
};

const cleanInteger = (value: number | null, minimum: number, maximum: number): number | null =>
  value !== null && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;

const cleanHttpsUrl = (value: string | null, requireOpenFoodFacts = false): string | null => {
  const cleaned = cleanText(value, 2_000);
  if (!cleaned) return null;
  const candidate = cleaned.startsWith('http://') ? `https://${cleaned.slice(7)}` : cleaned;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLocaleLowerCase('en');
    const isOpenFoodFacts =
      host === 'openfoodfacts.org' ||
      host.endsWith('.openfoodfacts.org') ||
      host === 'openfoodfacts.net' ||
      host.endsWith('.openfoodfacts.net');
    return parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      (!requireOpenFoodFacts || isOpenFoodFacts)
      ? candidate
      : null;
  } catch {
    return null;
  }
};

const cleanTimestamp = (value: string | null): string | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const cleanNutrition = (nutrition: ImportProduct['nutrition']): ImportProduct['nutrition'] => ({
  energyKj100g: cleanNutrient(nutrition.energyKj100g),
  energyKcal100g: cleanNutrient(nutrition.energyKcal100g),
  fat100g: cleanNutrient(nutrition.fat100g),
  saturatedFat100g: cleanNutrient(nutrition.saturatedFat100g),
  carbohydrates100g: cleanNutrient(nutrition.carbohydrates100g),
  sugars100g: cleanNutrient(nutrition.sugars100g),
  fiber100g: cleanNutrient(nutrition.fiber100g),
  proteins100g: cleanNutrient(nutrition.proteins100g),
  salt100g: cleanNutrient(nutrition.salt100g),
  sodium100g: cleanNutrient(nutrition.sodium100g),
  energyKjServing: cleanNutrient(nutrition.energyKjServing),
  energyKcalServing: cleanNutrient(nutrition.energyKcalServing),
  fatServing: cleanNutrient(nutrition.fatServing),
  saturatedFatServing: cleanNutrient(nutrition.saturatedFatServing),
  carbohydratesServing: cleanNutrient(nutrition.carbohydratesServing),
  sugarsServing: cleanNutrient(nutrition.sugarsServing),
  fiberServing: cleanNutrient(nutrition.fiberServing),
  proteinsServing: cleanNutrient(nutrition.proteinsServing),
  saltServing: cleanNutrient(nutrition.saltServing),
  sodiumServing: cleanNutrient(nutrition.sodiumServing),
});

const cleanNutriments = (nutriments: ImportProduct['nutriments']): ImportProduct['nutriments'] => {
  if (!nutriments) return null;
  const result: NonNullable<ImportProduct['nutriments']> = {};
  let usedBytes = 2;
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(nutriments)) {
    if (count >= 400) break;
    const key = rawKey.trim().slice(0, 100);
    if (!key || Object.hasOwn(result, key)) continue;
    const value = (() => {
      if (typeof rawValue !== 'string') return cleanFiniteNumber(rawValue);
      const normalized = rawValue.trim();
      return normalized ? normalized.slice(0, 500) : undefined;
    })();
    if (value === undefined) continue;
    const entryBytes =
      Buffer.byteLength(JSON.stringify(key), 'utf8') +
      Buffer.byteLength(JSON.stringify(value), 'utf8') +
      1 +
      (count > 0 ? 1 : 0);
    if (usedBytes + entryBytes > 250_000) break;
    result[key] = value;
    usedBytes += entryBytes;
    count += 1;
  }
  return count > 0 ? result : null;
};

const normalizeProduct = (product: ImportProduct): ImportProduct => ({
  ...product,
  name: cleanText(product.name, 160) ?? '',
  brand: cleanText(product.brand, 120),
  quantity: cleanText(product.quantity, 80),
  packaging: cleanText(product.packaging, 160),
  genericName: cleanText(product.genericName, 160),
  ingredientsText: cleanText(product.ingredientsText, MAX_INGREDIENTS_TEXT_LENGTH),
  allergens: cleanList(product.allergens, 64, 16_384),
  categorySlug: cleanText(product.categorySlug, 100),
  offCategories: cleanList(product.offCategories),
  offCategoryTags: cleanList(product.offCategoryTags),
  countries: cleanList(product.countries, 128, 16_384),
  countryTags: cleanList(product.countryTags, 128, 16_384),
  stores: cleanList(product.stores, 128, 16_384),
  purchasePlaces: cleanList(product.purchasePlaces, 128, 16_384),
  nutriscoreGrade: (() => {
    const grade = cleanText(product.nutriscoreGrade, 32)?.toLocaleLowerCase('en') ?? null;
    return grade && ['a', 'b', 'c', 'd', 'e'].includes(grade) ? grade : null;
  })(),
  nutriscoreScore: cleanInteger(product.nutriscoreScore, -100, 100),
  environmentalScoreGrade: (() => {
    const grade = cleanText(product.environmentalScoreGrade, 32)?.toLocaleLowerCase('en') ?? null;
    return grade && ['a-plus', 'a', 'b', 'c', 'd', 'e', 'f'].includes(grade) ? grade : null;
  })(),
  environmentalScoreScore: cleanInteger(product.environmentalScoreScore, 0, 100),
  servingSize: cleanText(product.servingSize, 80),
  nutrition: cleanNutrition(product.nutrition),
  nutriments: cleanNutriments(product.nutriments),
  openFoodFactsUrl: cleanHttpsUrl(product.openFoodFactsUrl, true),
  imageFrontThumbUrl: cleanHttpsUrl(product.imageFrontThumbUrl, true),
  imageFrontSmallUrl: cleanHttpsUrl(product.imageFrontSmallUrl, true),
  imageFrontUrl: cleanHttpsUrl(product.imageFrontUrl, true),
  imageFrontOriginalUrl: cleanHttpsUrl(product.imageFrontOriginalUrl, true),
  offLastModifiedAt: cleanTimestamp(product.offLastModifiedAt),
  offLastUpdatedAt: cleanTimestamp(product.offLastUpdatedAt),
  sourceProductId: cleanText(product.sourceProductId, 200),
  sourceImageUrl: cleanHttpsUrl(product.sourceImageUrl),
  imageStoragePath: (() => {
    const value = cleanText(product.imageStoragePath, 500);
    return value && !/^https?:\/\//i.test(value) ? value : null;
  })(),
});

/**
 * Provider-neutral boundary shared by the legacy importer and the isolated
 * OFF reconstruction pipeline. It performs GTIN validation and the exact
 * field sanitisation before a row can reach either PostgreSQL repository.
 */
export const prepareCatalogProduct = (product: MappedCatalogProduct): ImportProduct => {
  const gtin = normalizeGtin(product.barcode);
  return normalizeProduct({
    ...product,
    barcode: gtin.original,
    canonicalGtin: gtin.canonicalGtin,
  });
};

const progressFrom = (
  counters: ImportCounters,
  checksum: string,
  filename: string,
  dryRun: boolean,
): ImportProgress => ({ ...counters, checksum, filename, dryRun });

export async function importCatalog(options: CatalogImportOptions): Promise<CatalogImportResult> {
  const startedAt = Date.now();
  const filePath = resolve(options.filePath);
  const filename = basename(filePath);
  const checksum = await calculateFileChecksum(filePath);
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const updateExisting = options.updateExisting ?? true;
  const validateFullSnapshotHeader =
    options.validateFullSnapshotHeader ?? Boolean(options.metadata.isFullSnapshot);

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`batchSize doit être un entier compris entre 1 et ${MAX_BATCH_SIZE}.`);
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new RangeError('limit doit être un entier strictement positif.');
  }
  if (dryRun && options.resume)
    throw new Error('--dry-run et --resume ne peuvent pas être combinés.');
  if (!options.metadata.importerVersion.trim() || !options.metadata.projectionVersion.trim()) {
    throw new Error("Les versions de l'importeur et de la projection sont obligatoires.");
  }
  if (options.metadata.importOptions.mapper !== options.mapper.id) {
    throw new Error("Le contrat d'import ne correspond pas au mapper execute.");
  }
  if (options.metadata.importOptions.updateExisting !== updateExisting) {
    throw new Error("Le contrat d'import ne correspond pas a l'option updateExisting executee.");
  }
  if (
    options.metadata.isFullSnapshot &&
    (!options.metadata.sourcePublishedAt ||
      !Number.isFinite(Date.parse(options.metadata.sourcePublishedAt)))
  ) {
    throw new Error('Un snapshot complet exige un horodatage source publié valide.');
  }
  if (validateFullSnapshotHeader && !options.mapper.validateFullSnapshotHeader) {
    throw new Error('Un snapshot complet exige un validateur explicite des colonnes de la source.');
  }

  if (!dryRun && (await options.repository.hasCompletedImport(checksum))) {
    if (options.resume && !options.forceReimport) {
      return {
        ...progressFrom(emptyCounters(), checksum, filename, false),
        status: 'already-completed',
        sourceCatalogId: null,
        jobId: null,
        resumedFromOffset: 0,
        errorSamples: [],
        elapsedMs: Date.now() - startedAt,
        activation: null,
      };
    }
    if (!options.forceReimport) throw new DuplicateImportError(checksum);
  }

  const resumable = dryRun
    ? null
    : await options.repository.findResumableImport(checksum, filename, options.metadata);
  if (resumable && !options.resume) throw new ResumableImportExistsError();

  let session: ImportSession | null = null;
  if (!dryRun) {
    if (resumable && options.resume) {
      session = resumable;
      await options.repository.resumeImport(session.jobId);
    } else {
      session = await options.repository.createImport({
        checksum,
        filename,
        metadata: options.metadata,
      });
    }
  }

  const resumedFromOffset = session?.currentOffset ?? 0;
  const counters: ImportCounters = session ? { ...session } : emptyCounters();
  let committedCounters: ImportCounters = { ...counters };
  const productBatch = new Map<string, ImportProduct>();
  const errorBatch: CatalogImportError[] = [];
  const errorSamples: CatalogImportError[] = [];
  let rowsThisRun = 0;
  let reachedLimit = false;
  let pendingRows = 0;
  let batchCommitFailed = false;
  let activation: CatalogActivationResult | null = null;
  let fullSnapshotHeaderValidated = !validateFullSnapshotHeader;

  const report = async (): Promise<void> => {
    await options.onProgress?.(progressFrom(counters, checksum, filename, dryRun));
  };

  const flush = async (): Promise<void> => {
    if (pendingRows === 0) return;
    if (dryRun) {
      // Keep simulations O(batch) in memory. The database-backed import performs
      // exact global deduplication; dry-run counts valid candidates deduplicated
      // only inside each batch.
      counters.insertedRows += productBatch.size;
    } else if (session) {
      try {
        const committed = await options.repository.commitBatch({
          jobId: session.jobId,
          sourceCatalogId: session.sourceCatalogId,
          products: [...productBatch.values()],
          errors: [...errorBatch],
          counters: { ...counters },
          updateExisting,
        });
        Object.assign(counters, committed.counters);
        committedCounters = { ...counters };
      } catch (error) {
        batchCommitFailed = true;
        throw error;
      }
    }
    productBatch.clear();
    errorBatch.length = 0;
    pendingRows = 0;
    await report();
  };

  const recordError = (error: CatalogImportError): void => {
    const safeError: CatalogImportError = {
      ...error,
      rawBarcode: error.rawBarcode?.slice(0, 100) ?? null,
      errorCode: (error.errorCode || 'UNKNOWN_ERROR').slice(0, 80),
      errorMessage: (error.errorMessage || "Erreur d'import inconnue.").slice(0, 1_000),
    };
    counters.rejectedRows += 1;
    errorBatch.push(safeError);
    if (errorSamples.length < MAX_ERROR_SAMPLES) errorSamples.push(safeError);
  };

  try {
    for await (const parsed of readCatalogRows(filePath, {
      ...options.mapper.delimitedSourceOptions,
      delimiter: options.delimiter,
      fallbackDelimiter: options.mapper.defaultDelimiter,
    })) {
      if (!fullSnapshotHeaderValidated && parsed.kind === 'row') {
        options.mapper.validateFullSnapshotHeader?.(Object.keys(parsed.data));
        fullSnapshotHeaderValidated = true;
      }
      const rowNumber = parsed.kind === 'row' ? parsed.rowNumber : parsed.error.rowNumber;
      if (rowNumber > 0 && rowNumber <= resumedFromOffset) continue;
      if (options.limit !== undefined && rowsThisRun >= options.limit) {
        reachedLimit = true;
        break;
      }

      rowsThisRun += 1;
      pendingRows += 1;
      counters.processedRows += 1;
      counters.currentOffset = Math.max(
        counters.currentOffset,
        rowNumber || counters.currentOffset + 1,
      );

      if (parsed.kind === 'error') {
        recordError({ ...parsed.error, rowNumber: counters.currentOffset });
      } else {
        try {
          const mapped = options.mapper.map(parsed.data);
          if (mapped.kind === 'filtered') {
            counters.filteredRows += 1;
          } else {
            const product = prepareCatalogProduct(mapped.product);
            if (countCodePoints(product.name) < 2) {
              throw new CatalogImportErrorBase(
                'INVALID_PRODUCT_NAME',
                'Le nom nettoyé du produit doit contenir au moins deux caractères.',
              );
            }
            productBatch.set(product.canonicalGtin, product);
          }
        } catch (error) {
          const code =
            error instanceof GtinValidationError || error instanceof CatalogImportErrorBase
              ? error.code
              : 'ROW_TRANSFORMATION_ERROR';
          recordError({
            rowNumber: parsed.rowNumber,
            rawBarcode: rawBarcode(parsed.data),
            errorCode: code,
            errorMessage: error instanceof Error ? error.message : 'Transformation impossible.',
            rawData: summarizeRawRow(parsed.data),
          });
        }
      }

      if (pendingRows >= batchSize) await flush();
      if (options.signal?.aborted) {
        await flush();
        throw new ImportInterruptedError();
      }
    }

    await flush();
    if (!fullSnapshotHeaderValidated) {
      throw new Error('En-tête introuvable dans le snapshot complet.');
    }
    if (session) {
      if (reachedLimit) {
        await options.repository.pauseImport(
          session.jobId,
          counters,
          'Limite de lignes atteinte ; utilisez --resume pour poursuivre.',
        );
      } else {
        activation = await options.repository.completeImport(session, counters);
        counters.insertedRows = activation.insertedRows;
        counters.updatedRows = activation.updatedRows;
        await report();
      }
    }

    return {
      ...progressFrom(counters, checksum, filename, dryRun),
      status: dryRun ? 'dry-run' : reachedLimit ? 'paused' : 'completed',
      sourceCatalogId: session?.sourceCatalogId ?? null,
      jobId: session?.jobId ?? null,
      resumedFromOffset,
      errorSamples,
      elapsedMs: Date.now() - startedAt,
      activation,
    };
  } catch (error) {
    if (session) {
      if (!batchCommitFailed && pendingRows > 0) {
        try {
          await flush();
        } catch {
          // Preserve the original failure while retaining the last confirmed offset.
        }
      }
      if (error instanceof ImportInterruptedError || options.signal?.aborted) {
        await options.repository.pauseImport(
          session.jobId,
          committedCounters,
          error instanceof Error ? error.message : 'Interrompu',
        );
      } else {
        await options.repository.failImport(
          session.jobId,
          committedCounters,
          error instanceof Error ? error.message : "Erreur d'import inconnue.",
        );
      }
    }
    throw error;
  }
}
