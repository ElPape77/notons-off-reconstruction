import { randomUUID } from 'node:crypto';

import {
  catalogImportContractsMatch,
  DEFAULT_SNAPSHOT_ACTIVATION_POLICY,
} from '../catalog-scope.js';
import { ImportContractMismatchError } from '../errors.js';
import type {
  CatalogImportBatch,
  CatalogActivationResult,
  CatalogImportError,
  CatalogRepository,
  CommitBatchResult,
  ImportCounters,
  ImportProduct,
  ImportSession,
  SourceCatalogMetadata,
  StoredProduct,
  UpsertResult,
} from '../types.js';

interface MemoryJob extends ImportSession {
  checksum: string;
  filename: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  error: string | null;
}

const normalizeSearch = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('fr');

export class MemoryCatalogRepository implements CatalogRepository {
  readonly products = new Map<string, StoredProduct>();
  /** Rows remain private until completeImport atomically activates the job. */
  readonly stagingProducts = new Map<string, Map<string, StoredProduct>>();
  readonly errors: Array<CatalogImportError & { jobId: string }> = [];
  readonly jobs = new Map<string, MemoryJob>();
  readonly sourceCatalogs = new Map<
    string,
    {
      id: string;
      checksum: string;
      metadata: SourceCatalogMetadata;
      status: string;
      importedRows: number;
      importedAt: number | null;
    }
  >();
  async hasCompletedImport(checksum: string): Promise<boolean> {
    return [...this.sourceCatalogs.values()].some(
      (source) => source.checksum === checksum && source.status === 'completed',
    );
  }

  async findResumableImport(
    checksum: string,
    _filename: string,
    metadata: SourceCatalogMetadata,
  ): Promise<ImportSession | null> {
    const job = [...this.jobs.values()]
      .reverse()
      .find(
        (candidate) =>
          candidate.checksum === checksum &&
          ['running', 'paused', 'failed'].includes(candidate.status),
      );
    if (job) {
      const source = this.sourceCatalogs.get(job.sourceCatalogId);
      if (!source || !catalogImportContractsMatch(source.metadata, metadata)) {
        throw new ImportContractMismatchError();
      }
    }
    return job ? this.toSession(job) : null;
  }

  async createImport(input: {
    checksum: string;
    filename: string;
    metadata: SourceCatalogMetadata;
  }): Promise<ImportSession> {
    let source = [...this.sourceCatalogs.values()].find(
      (candidate) => candidate.checksum === input.checksum,
    );
    if (!source) {
      source = {
        id: randomUUID(),
        checksum: input.checksum,
        metadata: input.metadata,
        status: 'importing',
        importedRows: 0,
        importedAt: null,
      };
      this.sourceCatalogs.set(source.id, source);
    } else {
      source.status = 'importing';
      source.metadata = input.metadata;
    }

    const job: MemoryJob = {
      jobId: randomUUID(),
      sourceCatalogId: source.id,
      checksum: input.checksum,
      filename: input.filename,
      status: 'running',
      error: null,
      currentOffset: 0,
      processedRows: 0,
      insertedRows: 0,
      updatedRows: 0,
      rejectedRows: 0,
      filteredRows: 0,
    };
    this.jobs.set(job.jobId, job);
    return this.toSession(job);
  }

  async resumeImport(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
    job.status = 'running';
    job.error = null;
  }

  async commitBatch(batch: CatalogImportBatch): Promise<CommitBatchResult> {
    const currentJob = this.requireJob(batch.jobId);
    if (currentJob.sourceCatalogId !== batch.sourceCatalogId) {
      throw new Error("Le travail d'import n'appartient pas au catalogue source indiqu\u00e9.");
    }

    // Stage every write away from the public in-memory state. This mirrors the
    // PostgreSQL transaction and makes the repository useful for failure tests.
    const stagedProducts = new Map(this.stagingProducts.get(batch.jobId) ?? []);
    const upsert = this.stageProducts(
      stagedProducts,
      batch.jobId,
      batch.sourceCatalogId,
      batch.products,
      batch.updateExisting,
    );
    await this.afterBatchUpsert(batch, upsert);

    const stagedErrors = batch.errors.map((error) => ({ ...error, jobId: batch.jobId }));
    const counters: ImportCounters = {
      ...batch.counters,
      insertedRows: batch.counters.insertedRows + upsert.inserted,
      updatedRows: batch.counters.updatedRows + upsert.updated,
    };
    const stagedJob: MemoryJob = { ...currentJob, ...counters };

    // Publishing is synchronous, so observers cannot see a partially applied
    // batch between the product/error/checkpoint writes.
    this.stagingProducts.set(batch.jobId, stagedProducts);
    for (const error of stagedErrors) this.errors.push(error);
    this.jobs.set(batch.jobId, stagedJob);

    return { upsert, counters };
  }

  /** Test seam for simulating a database failure after the staged upsert. */
  protected async afterBatchUpsert(
    _batch: CatalogImportBatch,
    _result: UpsertResult,
  ): Promise<void> {}

  private stageProducts(
    productsByGtin: Map<string, StoredProduct>,
    _jobId: string,
    sourceCatalogId: string,
    products: readonly ImportProduct[],
    updateExisting: boolean,
  ): UpsertResult {
    let inserted = 0;
    let updated = 0;
    for (const product of products) {
      const staged = productsByGtin.get(product.canonicalGtin);
      const existsInCatalogue = this.products.has(product.canonicalGtin);
      if ((staged || existsInCatalogue) && !updateExisting) continue;
      if (!staged) {
        productsByGtin.set(product.canonicalGtin, {
          ...product,
          sourceCatalogId,
          dataQualityStatus: 'imported',
          sourceKind: product.isDemo ? 'demo' : 'catalog_import',
        });
        if (existsInCatalogue) updated += updateExisting ? 1 : 0;
        else inserted += 1;
      } else if (updateExisting) {
        productsByGtin.set(product.canonicalGtin, {
          ...staged,
          ...product,
          sourceCatalogId,
        });
        updated += 1;
      }
    }
    return { inserted, updated };
  }

  async completeImport(
    session: ImportSession,
    counters: ImportCounters,
  ): Promise<CatalogActivationResult> {
    const stagedRows = this.stagingProducts.get(session.jobId)?.size ?? 0;
    if (stagedRows === 0) {
      throw new Error('catalog_staging_empty');
    }
    const source = this.sourceCatalogs.get(session.sourceCatalogId);
    if (!source) throw new Error('source_catalog_not_found');
    if (source.metadata.isFullSnapshot) {
      const policy = source.metadata.snapshotActivationPolicy ?? DEFAULT_SNAPSHOT_ACTIVATION_POLICY;
      if (
        !Number.isSafeInteger(policy.minimumRows) ||
        policy.minimumRows < 1 ||
        !Number.isFinite(policy.minimumPreviousCoverage) ||
        policy.minimumPreviousCoverage < 0 ||
        policy.minimumPreviousCoverage > 1 ||
        !Number.isFinite(policy.maximumRejectedRatio) ||
        policy.maximumRejectedRatio < 0 ||
        policy.maximumRejectedRatio > 1
      ) {
        throw new Error('catalog_snapshot_policy_invalid');
      }
      if (counters.rejectedRows + counters.filteredRows > counters.processedRows) {
        throw new Error('catalog_snapshot_counters_inconsistent');
      }
      if (counters.filteredRows > 0) {
        throw new Error('catalog_snapshot_contains_filtered_rows');
      }
      if (stagedRows < policy.minimumRows) {
        throw new Error('catalog_snapshot_below_minimum');
      }
      const rejectedRatio =
        counters.processedRows > 0 ? counters.rejectedRows / counters.processedRows : 1;
      if (rejectedRatio > policy.maximumRejectedRatio) {
        throw new Error('catalog_snapshot_rejected_ratio_exceeded');
      }
      const previous = [...this.sourceCatalogs.values()]
        .filter(
          (candidate) =>
            candidate.id !== source.id &&
            candidate.status === 'completed' &&
            candidate.metadata.isFullSnapshot &&
            candidate.metadata.name.toLocaleLowerCase('en') ===
              source.metadata.name.toLocaleLowerCase('en') &&
            candidate.importedRows > 0,
        )
        .sort((left, right) => (right.importedAt ?? 0) - (left.importedAt ?? 0))[0];
      const publishedAt = source.metadata.sourcePublishedAt
        ? Date.parse(source.metadata.sourcePublishedAt)
        : Number.NaN;
      if (!Number.isFinite(publishedAt)) {
        throw new Error('catalog_snapshot_published_at_required');
      }
      const previousPublishedAt = previous?.metadata.sourcePublishedAt
        ? Date.parse(previous.metadata.sourcePublishedAt)
        : Number.NaN;
      if (
        previous &&
        (!Number.isFinite(previousPublishedAt) || publishedAt <= previousPublishedAt)
      ) {
        throw new Error('catalog_snapshot_not_newer_than_previous');
      }
      if (previous && stagedRows / previous.importedRows < policy.minimumPreviousCoverage) {
        throw new Error('catalog_snapshot_coverage_below_minimum');
      }
    }
    const activatedProducts = new Map(this.products);
    let insertedRows = 0;
    let updatedRows = 0;
    let unchangedRows = 0;
    const activatedAt = new Date().toISOString();
    for (const product of this.stagingProducts.get(session.jobId)?.values() ?? []) {
      const existing = activatedProducts.get(product.canonicalGtin);
      const protectedProduct =
        existing?.dataQualityStatus === 'verified' || existing?.sourceKind === 'moderator';
      if (!existing) {
        activatedProducts.set(product.canonicalGtin, {
          ...product,
          offSyncedAt: activatedAt,
          catalogSyncStatus: 'synced',
        });
        insertedRows += 1;
      } else {
        const incomingTimestamp = product.offLastModifiedAt ?? product.offLastUpdatedAt;
        const existingTimestamp = existing.offLastModifiedAt ?? existing.offLastUpdatedAt;
        const incomingTime = incomingTimestamp ? Date.parse(incomingTimestamp) : Number.NaN;
        const existingTime = existingTimestamp ? Date.parse(existingTimestamp) : Number.NaN;
        const sourceDidNotAdvance =
          Number.isFinite(incomingTime) &&
          Number.isFinite(existingTime) &&
          incomingTime <= existingTime;
        const timestampFreePayloadIsEqual =
          !incomingTimestamp && !existingTimestamp && this.sameImportedPayload(existing, product);
        if (sourceDidNotAdvance || timestampFreePayloadIsEqual) {
          unchangedRows += 1;
          continue;
        }
        const merged = this.mergeImportedProduct(existing, product);
        activatedProducts.set(product.canonicalGtin, {
          ...merged,
          ...(protectedProduct
            ? {
                name: existing.name,
                genericName: existing.genericName,
                ingredientsText: existing.ingredientsText,
                allergens: existing.allergens,
                brand: existing.brand,
                quantity: existing.quantity,
                packaging: existing.packaging,
                categorySlug: existing.categorySlug,
                imageStoragePath: existing.imageStoragePath,
                sourceCatalogId: existing.sourceCatalogId,
                sourceProductId: existing.sourceProductId,
                sourceKind: existing.sourceKind,
                dataQualityStatus: existing.dataQualityStatus,
              }
            : {}),
          offSyncedAt: activatedAt,
          catalogSyncStatus: 'synced',
        });
        updatedRows += 1;
      }
    }

    this.products.clear();
    for (const [gtin, product] of activatedProducts) this.products.set(gtin, product);
    this.stagingProducts.delete(session.jobId);
    const job = this.requireJob(session.jobId);
    Object.assign(job, counters, {
      insertedRows,
      updatedRows,
      status: 'completed',
      error: null,
    });
    source.status = 'completed';
    source.importedRows = stagedRows;
    source.importedAt = Date.now();
    return {
      insertedRows,
      updatedRows,
      unchangedRows,
      staleRows: 0,
      aliasRowsSkipped: 0,
      affectedRows: insertedRows + updatedRows,
    };
  }

  private mergeImportedProduct(existing: StoredProduct, product: StoredProduct): StoredProduct {
    return {
      ...existing,
      ...product,
      brand: product.brand ?? existing.brand,
      quantity: product.quantity ?? existing.quantity,
      packaging: product.packaging ?? existing.packaging,
      genericName: product.genericName ?? existing.genericName,
      ingredientsText: product.ingredientsText ?? existing.ingredientsText,
      allergens: product.allergens ?? existing.allergens,
      categorySlug: product.categorySlug ?? existing.categorySlug,
      offCategories: product.offCategories ?? existing.offCategories,
      offCategoryTags: product.offCategoryTags ?? existing.offCategoryTags,
      countries: product.countries ?? existing.countries,
      countryTags: product.countryTags ?? existing.countryTags,
      stores: product.stores ?? existing.stores,
      purchasePlaces: product.purchasePlaces ?? existing.purchasePlaces,
      nutriscoreGrade: product.nutriscoreGrade ?? existing.nutriscoreGrade,
      nutriscoreScore: product.nutriscoreScore ?? existing.nutriscoreScore,
      environmentalScoreGrade: product.environmentalScoreGrade ?? existing.environmentalScoreGrade,
      environmentalScoreScore: product.environmentalScoreScore ?? existing.environmentalScoreScore,
      servingSize: product.servingSize ?? existing.servingSize,
      nutrition: Object.fromEntries(
        Object.entries(product.nutrition).map(([key, value]) => [
          key,
          value ?? existing.nutrition[key as keyof typeof existing.nutrition],
        ]),
      ) as StoredProduct['nutrition'],
      nutriments: product.nutriments ?? existing.nutriments,
      openFoodFactsUrl: product.openFoodFactsUrl ?? existing.openFoodFactsUrl,
      imageFrontThumbUrl: product.imageFrontThumbUrl ?? existing.imageFrontThumbUrl,
      imageFrontSmallUrl: product.imageFrontSmallUrl ?? existing.imageFrontSmallUrl,
      imageFrontUrl: product.imageFrontUrl ?? existing.imageFrontUrl,
      imageFrontOriginalUrl: product.imageFrontOriginalUrl ?? existing.imageFrontOriginalUrl,
      imageStoragePath: product.imageStoragePath ?? existing.imageStoragePath,
      sourceImageUrl: product.sourceImageUrl ?? existing.sourceImageUrl,
      sourceProductId: product.sourceProductId ?? existing.sourceProductId,
      offLastModifiedAt: product.offLastModifiedAt ?? existing.offLastModifiedAt,
      offLastUpdatedAt: product.offLastUpdatedAt ?? existing.offLastUpdatedAt,
    };
  }

  private sameImportedPayload(existing: StoredProduct, product: StoredProduct): boolean {
    const payload = (value: StoredProduct): unknown => ({
      name: value.name,
      genericName: value.genericName,
      ingredientsText: value.ingredientsText,
      allergens: value.allergens,
      brand: value.brand,
      quantity: value.quantity,
      packaging: value.packaging,
      categorySlug: value.categorySlug,
      offCategories: value.offCategories,
      offCategoryTags: value.offCategoryTags,
      countries: value.countries,
      countryTags: value.countryTags,
      stores: value.stores,
      purchasePlaces: value.purchasePlaces,
      nutriscoreGrade: value.nutriscoreGrade,
      nutriscoreScore: value.nutriscoreScore,
      environmentalScoreGrade: value.environmentalScoreGrade,
      environmentalScoreScore: value.environmentalScoreScore,
      servingSize: value.servingSize,
      nutrition: value.nutrition,
      nutriments: value.nutriments,
      openFoodFactsUrl: value.openFoodFactsUrl,
      imageFrontThumbUrl: value.imageFrontThumbUrl,
      imageFrontSmallUrl: value.imageFrontSmallUrl,
      imageFrontUrl: value.imageFrontUrl,
      imageFrontOriginalUrl: value.imageFrontOriginalUrl,
    });
    return JSON.stringify(payload(existing)) === JSON.stringify(payload(product));
  }

  async pauseImport(jobId: string, counters: ImportCounters, reason: string): Promise<void> {
    Object.assign(this.requireJob(jobId), counters, { status: 'paused', error: reason });
  }

  async failImport(jobId: string, counters: ImportCounters, error: string): Promise<void> {
    const job = this.requireJob(jobId);
    Object.assign(job, counters, { status: 'failed', error });
    const source = this.sourceCatalogs.get(job.sourceCatalogId);
    if (source) source.status = 'failed';
  }

  async findProductByGtin(canonicalGtin: string): Promise<StoredProduct | null> {
    return this.products.get(canonicalGtin) ?? null;
  }

  async searchProducts(query: string, limit = 20): Promise<StoredProduct[]> {
    const needle = normalizeSearch(query.trim());
    if (!needle) return [];
    return [...this.products.values()]
      .filter((product) =>
        normalizeSearch(
          `${product.name} ${product.brand ?? ''} ${product.categorySlug ?? ''}`,
        ).includes(needle),
      )
      .slice(0, limit);
  }

  private requireJob(jobId: string): MemoryJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job d'import introuvable : ${jobId}`);
    return job;
  }

  private toSession(job: MemoryJob): ImportSession {
    return {
      jobId: job.jobId,
      sourceCatalogId: job.sourceCatalogId,
      currentOffset: job.currentOffset,
      processedRows: job.processedRows,
      insertedRows: job.insertedRows,
      updatedRows: job.updatedRows,
      rejectedRows: job.rejectedRows,
      filteredRows: job.filteredRows,
    };
  }
}
