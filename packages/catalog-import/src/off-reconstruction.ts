import { Buffer } from 'node:buffer';
import { basename, resolve } from 'node:path';

import { GtinValidationError } from '@notons/shared';

import { CatalogImportErrorBase } from './errors.js';
import { prepareCatalogProduct } from './importer.js';
import {
  OPEN_FOOD_FACTS_PROJECTION_VERSION,
  OpenFoodFactsMapper,
} from './mappers/open-food-facts.js';
import { CATALOG_IMPORTER_VERSION } from './catalog-scope.js';
import type { OffMigrationLedgerEntry } from './migration-ledger.js';
import { readCatalogRows, type ParsedSourceRow } from './source.js';
import type { CatalogImportError, ImportCounters, ImportProduct, RawCatalogRow } from './types.js';
import {
  createVerifiedArchiveSnapshot,
  type VerifiedArchiveSnapshot,
} from './verified-archive-snapshot.js';

export const OFF_RECONSTRUCTION_CONTRACT_VERSION = 'notons-off-reconstruction/1';
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_ACTIVATION_BATCH_SIZE = 100_000;
const MAX_IMPORT_BATCH_SIZE = 1_000;
const MAX_ACTIVATION_BATCH_SIZE = 100_000;
const MAX_ERROR_SAMPLES = 20;

export type OffDatasetStatus = 'copying' | 'staged' | 'activating' | 'active';

export interface OffReconstructionMetadata {
  archiveFilename: string;
  archiveSha256: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  sourceRetrievedAt: string;
  immutableCodeUrl: string;
  codeRevision: string;
  importerVersion: string;
  projectionVersion: string;
  contractVersion: string;
}

export interface OffReconstructionSourceContract {
  sourceHeader: readonly string[];
}

export interface OffReconstructionSession extends ImportCounters {
  datasetId: string;
  jobId: string;
  status: OffDatasetStatus;
  stagedRows: number;
  sourceFingerprint: string | null;
}

export interface OffReconstructionSeal {
  stagedRows: number;
  sourceFingerprint: string;
}

export interface OffReconstructionBatch {
  session: OffReconstructionSession;
  products: readonly ImportProduct[];
  counters: ImportCounters;
}

export interface OffCatalogReconstructionRepository {
  assertMigrationLedger(expected: readonly OffMigrationLedgerEntry[]): Promise<void>;
  /**
   * Returns an already sealed generation for this exact immutable contract.
   *
   * This probe is intentionally unable to return a `copying` generation: a
   * partial projection must still verify and reopen the official archive.
   */
  findSealedReconstruction?(
    metadata: OffReconstructionMetadata,
  ): Promise<OffReconstructionSession | null>;
  beginReconstruction(
    metadata: OffReconstructionMetadata,
    resume: boolean,
    sourceContract?: OffReconstructionSourceContract,
  ): Promise<OffReconstructionSession>;
  commitReconstructionBatch(batch: OffReconstructionBatch): Promise<number>;
  sealReconstruction(
    session: OffReconstructionSession,
    counters: ImportCounters,
  ): Promise<OffReconstructionSeal>;
  beginActivation(datasetId: string): Promise<number>;
  activateBatch(datasetId: string, batchSize: number): Promise<number>;
  finalizeActivation(datasetId: string): Promise<number>;
  close?(): Promise<void>;
}

export interface OffReconstructionProgress extends ImportCounters {
  phase: 'projection' | 'activation';
  stagedRows: number;
  activatedRows: number;
}

export interface OffReconstructionOptions {
  filePath: string;
  expectedSha256: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  sourceRetrievedAt: string;
  immutableCodeUrl: string;
  codeRevision: string;
  repository: OffCatalogReconstructionRepository;
  expectedMigrationLedger: readonly OffMigrationLedgerEntry[];
  batchSize?: number;
  activationBatchSize?: number;
  resume?: boolean;
  activate?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: OffReconstructionProgress) => void | Promise<void>;
}

export interface OffReconstructionResult extends ImportCounters {
  formatVersion: 1;
  documentKind: 'notons-off-reconstruction-result';
  status: 'staged' | 'active' | 'already-active';
  archiveFilename: string;
  archiveSha256: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  sourceRetrievedAt: string;
  immutableCodeUrl: string;
  codeRevision: string;
  importerVersion: string;
  projectionVersion: string;
  contractVersion: string;
  stagedRows: number;
  sourceFingerprint: string;
  errorSamples: CatalogImportError[];
  elapsedMs: number;
}

const officialSourceUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname !== '/' &&
      (url.hostname === 'static.openfoodfacts.org' || url.hostname === 'world.openfoodfacts.org')
    );
  } catch {
    return false;
  }
};

const utcTimestamp = (value: string): boolean => {
  const timestamp = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().replace('.000Z', 'Z') === value
  );
};

const immutableRevision = (value: string): boolean => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);

const containsExactRevision = (value: string, revision: string): boolean =>
  new RegExp(`(?:^|[^0-9a-f])${revision}(?:[^0-9a-f]|$)`, 'i').test(value);

const immutableCodeUrl = (value: string, revision: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === `/ElPape77/notons-off-reconstruction/tree/${revision}` &&
      containsExactRevision(url.href, revision)
    );
  } catch {
    return false;
  }
};

const validateSourceHeader = (columns: readonly string[]): void => {
  const normalized = columns.map((column) => column.toLocaleLowerCase('en'));
  if (
    columns.length < 2 ||
    columns.length > 1_000 ||
    columns.some((column) => !column || column.length > 200) ||
    Buffer.byteLength(columns.join('\n'), 'utf8') > 131_072 ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error('En-tête OFF vide, dupliqué ou hors des limites reproductibles.');
  }
};

const rawBarcode = (row: RawCatalogRow): string | null => {
  const value = row.code ?? row.barcode ?? row.gtin;
  return value === undefined || value === null ? null : String(value).slice(0, 100);
};

const summarizeRawRow = (row: RawCatalogRow): RawCatalogRow =>
  Object.fromEntries(
    Object.entries(row)
      .slice(0, 30)
      .map(([key, value]) => [key.slice(0, 100), String(value ?? '').slice(0, 500)]),
  );

const validateOptions = (options: OffReconstructionOptions): void => {
  if (!/\.tsv\.gz$/.test(options.filePath)) {
    throw new Error('La reconstruction OFF exige une archive locale .tsv.gz.');
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectedSha256)) {
    throw new Error(
      'Le SHA-256 attendu de l’archive OFF doit contenir 64 caractères hexadécimaux.',
    );
  }
  if (!officialSourceUrl(options.sourceUrl)) {
    throw new Error(
      'La source doit être une URL HTTPS officielle static.openfoodfacts.org ou world.openfoodfacts.org.',
    );
  }
  if (!utcTimestamp(options.sourcePublishedAt) || !utcTimestamp(options.sourceRetrievedAt)) {
    throw new Error('Les dates source doivent être des horodatages UTC ISO-8601 terminés par Z.');
  }
  if (Date.parse(options.sourceRetrievedAt) < Date.parse(options.sourcePublishedAt)) {
    throw new Error('La date de récupération ne peut pas précéder la publication de la source.');
  }
  if (!immutableRevision(options.codeRevision)) {
    throw new Error(
      'La révision du code doit être un identifiant hexadécimal immuable de 40 ou 64 caractères.',
    );
  }
  if (!immutableCodeUrl(options.immutableCodeUrl, options.codeRevision)) {
    throw new Error(
      'L’URL HTTPS du code de transformation doit contenir la révision immuable exacte.',
    );
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const activationBatchSize = options.activationBatchSize ?? DEFAULT_ACTIVATION_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_IMPORT_BATCH_SIZE) {
    throw new Error(
      `La taille de lot d’import doit être comprise entre 1 et ${MAX_IMPORT_BATCH_SIZE}.`,
    );
  }
  if (
    !Number.isInteger(activationBatchSize) ||
    activationBatchSize < 1 ||
    activationBatchSize > MAX_ACTIVATION_BATCH_SIZE
  ) {
    throw new Error(
      `La taille de lot d’activation doit être comprise entre 1 et ${MAX_ACTIVATION_BATCH_SIZE}.`,
    );
  }
  if (
    !Array.isArray(options.expectedMigrationLedger) ||
    options.expectedMigrationLedger.length < 1 ||
    options.expectedMigrationLedger.length > 1000 ||
    options.expectedMigrationLedger.some(
      (entry) =>
        !entry ||
        !/^\d{3}_[a-z0-9_-]+\.sql$/.test(entry.filename) ||
        !/^[0-9a-f]{64}$/.test(entry.sha256),
    ) ||
    new Set(options.expectedMigrationLedger.map((entry) => entry.filename)).size !==
      options.expectedMigrationLedger.length
  ) {
    throw new Error('L’inventaire attendu des migrations OFF est invalide.');
  }
};

const countersFromSession = (session: OffReconstructionSession): ImportCounters => ({
  currentOffset: session.currentOffset,
  processedRows: session.processedRows,
  insertedRows: session.insertedRows,
  updatedRows: session.updatedRows,
  rejectedRows: session.rejectedRows,
  filteredRows: session.filteredRows,
});

/**
 * Verifies an official archive, then streams one projection pass into the
 * isolated OFF schema. A resume may reuse an exact database-owned seal after
 * projection; an unsealed copy always re-verifies the archive. The repository
 * contract deliberately has no operation capable of addressing a Notons Core
 * table.
 */
export async function reconstructOffCatalog(
  options: OffReconstructionOptions,
): Promise<OffReconstructionResult> {
  validateOptions(options);
  await options.repository.assertMigrationLedger(options.expectedMigrationLedger);
  const startedAt = Date.now();
  const filePath = resolve(options.filePath);
  const archiveSha256 = options.expectedSha256;
  const metadata: OffReconstructionMetadata = {
    archiveFilename: basename(filePath),
    archiveSha256,
    sourceUrl: options.sourceUrl,
    sourcePublishedAt: options.sourcePublishedAt,
    sourceRetrievedAt: options.sourceRetrievedAt,
    immutableCodeUrl: options.immutableCodeUrl,
    codeRevision: options.codeRevision,
    importerVersion: CATALOG_IMPORTER_VERSION,
    projectionVersion: OPEN_FOOD_FACTS_PROJECTION_VERSION,
    contractVersion: OFF_RECONSTRUCTION_CONTRACT_VERSION,
  };
  const mapper = new OpenFoodFactsMapper({ requireCountry: false, requireCategory: false });
  let sourceIterator: AsyncIterator<ParsedSourceRow> | undefined;
  let first: IteratorResult<ParsedSourceRow> | undefined;
  let archiveSnapshot: VerifiedArchiveSnapshot | undefined;

  try {
    let session =
      options.resume && options.repository.findSealedReconstruction
        ? await options.repository.findSealedReconstruction(metadata)
        : null;

    if (session) {
      if (session.status === 'copying' || !session.sourceFingerprint) {
        throw new Error('Le raccourci de reprise OFF a retourné une génération non scellée.');
      }
    } else {
      archiveSnapshot = await createVerifiedArchiveSnapshot(
        filePath,
        archiveSha256,
        options.signal,
      );

      let sourceHeader: readonly string[] | undefined;
      sourceIterator = readCatalogRows(archiveSnapshot.filePath, {
        ...mapper.delimitedSourceOptions,
        delimiter: '\t',
        onHeader: (columns) => {
          sourceHeader = columns;
        },
      })[Symbol.asyncIterator]();
      first = await sourceIterator.next();
      if (first.done || !sourceHeader) {
        await sourceIterator.return?.(undefined);
        throw new Error('En-tête ou ligne de données introuvable dans le snapshot OFF complet.');
      }
      try {
        validateSourceHeader(sourceHeader);
        mapper.validateFullSnapshotHeader(sourceHeader);
        session = await options.repository.beginReconstruction(metadata, options.resume ?? false, {
          sourceHeader,
        });
      } catch (error) {
        await sourceIterator.return?.(undefined);
        throw error;
      }
      if (session.status !== 'copying') await sourceIterator.return?.(undefined);
    }
    const wasAlreadyActive = session.status === 'active';
    let status = session.status;
    let counters = countersFromSession(session);
    let stagedRows = session.stagedRows;
    let sourceFingerprint = session.sourceFingerprint;
    const errorSamples: CatalogImportError[] = [];

    if (status === 'copying') {
      if (!sourceIterator || !first || first.done) {
        throw new Error('Le flux source OFF vérifié est absent pour une reconstruction partielle.');
      }
      const verifiedSourceIterator = sourceIterator;
      const verifiedFirst = first;
      const products = new Map<string, ImportProduct>();
      let pendingRows = 0;

      const report = async (): Promise<void> =>
        options.onProgress?.({
          ...counters,
          phase: 'projection',
          stagedRows,
          activatedRows: 0,
        });

      const flush = async (): Promise<void> => {
        if (pendingRows === 0) return;
        stagedRows = await options.repository.commitReconstructionBatch({
          session,
          products: [...products.values()],
          counters: { ...counters },
        });
        products.clear();
        pendingRows = 0;
        await report();
      };

      const parsedRows = (async function* () {
        try {
          yield verifiedFirst.value;
          while (true) {
            const next = await verifiedSourceIterator.next();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          await verifiedSourceIterator.return?.(undefined);
        }
      })();
      for await (const parsed of parsedRows) {
        const rowNumber = parsed.kind === 'row' ? parsed.rowNumber : parsed.error.rowNumber;
        if (rowNumber > 0 && rowNumber <= session.currentOffset) continue;

        pendingRows += 1;
        counters.processedRows += 1;
        counters.currentOffset = Math.max(
          counters.currentOffset,
          rowNumber || counters.currentOffset + 1,
        );

        if (parsed.kind === 'error') {
          counters.rejectedRows += 1;
          if (errorSamples.length < MAX_ERROR_SAMPLES) errorSamples.push(parsed.error);
        } else {
          try {
            const mapped = mapper.map(parsed.data);
            if (mapped.kind === 'filtered') {
              // Full reconstruction config makes this unreachable; retaining the
              // counter makes any future projection-contract change observable.
              counters.filteredRows += 1;
            } else {
              const product = prepareCatalogProduct(mapped.product);
              if (Array.from(product.name).length < 2) {
                throw new CatalogImportErrorBase(
                  'INVALID_PRODUCT_NAME',
                  'Le nom nettoyé du produit doit contenir au moins deux caractères.',
                );
              }
              products.set(product.canonicalGtin, product);
            }
          } catch (error) {
            counters.rejectedRows += 1;
            if (errorSamples.length < MAX_ERROR_SAMPLES) {
              errorSamples.push({
                rowNumber: parsed.rowNumber,
                rawBarcode: rawBarcode(parsed.data),
                errorCode:
                  error instanceof GtinValidationError || error instanceof CatalogImportErrorBase
                    ? error.code
                    : 'ROW_TRANSFORMATION_ERROR',
                errorMessage:
                  error instanceof Error
                    ? error.message.slice(0, 1_000)
                    : 'Transformation impossible.',
                rawData: summarizeRawRow(parsed.data),
              });
            }
          }
        }

        if (pendingRows >= (options.batchSize ?? DEFAULT_BATCH_SIZE)) await flush();
        if (options.signal?.aborted) {
          await flush();
          throw new Error('Reconstruction OFF interrompue après le dernier checkpoint confirmé.');
        }
      }

      await flush();
      if (counters.processedRows < 1 || counters.filteredRows > 0) {
        throw new Error(
          'Le snapshot OFF complet est vide ou a été filtré contrairement au contrat.',
        );
      }
      const seal = await options.repository.sealReconstruction(session, counters);
      stagedRows = seal.stagedRows;
      sourceFingerprint = seal.sourceFingerprint;
      status = 'staged';
    }

    if (status === 'activating' && !options.activate) {
      throw new Error('Une activation OFF commencée doit être reprise avec --resume --activate.');
    }

    if (options.activate && status !== 'active') {
      if (options.signal?.aborted) {
        throw new Error('Reconstruction OFF interrompue avant le premier lot d’activation.');
      }
      let activatedRows = await options.repository.beginActivation(session.datasetId);
      status = 'activating';
      while (activatedRows < stagedRows) {
        if (options.signal?.aborted) {
          throw new Error('Reconstruction OFF interrompue au dernier checkpoint d’activation.');
        }
        const previous = activatedRows;
        activatedRows = await options.repository.activateBatch(
          session.datasetId,
          options.activationBatchSize ?? DEFAULT_ACTIVATION_BATCH_SIZE,
        );
        if (activatedRows <= previous || activatedRows > stagedRows) {
          throw new Error(`Checkpoint d’activation OFF invalide : ${previous} → ${activatedRows}.`);
        }
        await options.onProgress?.({
          ...counters,
          phase: 'activation',
          stagedRows,
          activatedRows,
        });
      }
      const publishedRows = await options.repository.finalizeActivation(session.datasetId);
      if (publishedRows !== stagedRows) {
        throw new Error(`Activation OFF incomplète : ${publishedRows}/${stagedRows}.`);
      }
      status = 'active';
    }

    if (!sourceFingerprint) {
      throw new Error('La génération OFF ne possède pas d’empreinte de projection vérifiée.');
    }
    counters = { ...counters, insertedRows: stagedRows, updatedRows: 0 };
    return {
      formatVersion: 1,
      documentKind: 'notons-off-reconstruction-result',
      status: status === 'active' ? (wasAlreadyActive ? 'already-active' : 'active') : 'staged',
      ...counters,
      archiveFilename: metadata.archiveFilename,
      archiveSha256,
      sourceUrl: metadata.sourceUrl,
      sourcePublishedAt: metadata.sourcePublishedAt,
      sourceRetrievedAt: metadata.sourceRetrievedAt,
      immutableCodeUrl: metadata.immutableCodeUrl,
      codeRevision: metadata.codeRevision,
      importerVersion: metadata.importerVersion,
      projectionVersion: metadata.projectionVersion,
      contractVersion: metadata.contractVersion,
      stagedRows,
      sourceFingerprint,
      errorSamples,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    try {
      await sourceIterator?.return?.(undefined);
    } finally {
      await archiveSnapshot?.cleanup();
    }
  }
}
