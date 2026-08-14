import type { CatalogSyncStatus, ProductNutriments, ProductNutrition } from '@notons/shared';

export type RawCatalogRow = Record<string, unknown>;

export const EMPTY_PRODUCT_NUTRITION: Readonly<ProductNutrition> = Object.freeze({
  energyKj100g: null,
  energyKcal100g: null,
  fat100g: null,
  saturatedFat100g: null,
  carbohydrates100g: null,
  sugars100g: null,
  fiber100g: null,
  proteins100g: null,
  salt100g: null,
  sodium100g: null,
  energyKjServing: null,
  energyKcalServing: null,
  fatServing: null,
  saturatedFatServing: null,
  carbohydratesServing: null,
  sugarsServing: null,
  fiberServing: null,
  proteinsServing: null,
  saltServing: null,
  sodiumServing: null,
});

export interface OpenFoodFactsProductMetadata {
  genericName: string | null;
  offCategories: string[] | null;
  offCategoryTags: string[] | null;
  countries: string[] | null;
  countryTags: string[] | null;
  stores: string[] | null;
  purchasePlaces: string[] | null;
  nutriscoreGrade: string | null;
  nutriscoreScore: number | null;
  environmentalScoreGrade: string | null;
  environmentalScoreScore: number | null;
  servingSize: string | null;
  nutrition: ProductNutrition;
  nutriments: ProductNutriments | null;
  openFoodFactsUrl: string | null;
  imageFrontThumbUrl: string | null;
  imageFrontSmallUrl: string | null;
  imageFrontUrl: string | null;
  imageFrontOriginalUrl: string | null;
  offLastModifiedAt: string | null;
  offLastUpdatedAt: string | null;
}

export interface MappedCatalogProduct extends OpenFoodFactsProductMetadata {
  barcode: string;
  name: string;
  brand: string | null;
  quantity: string | null;
  packaging: string | null;
  categorySlug: string | null;
  sourceProductId: string | null;
  sourceImageUrl: string | null;
  imageStoragePath: string | null;
  isDemo: boolean;
}

export interface ImportProduct extends MappedCatalogProduct {
  canonicalGtin: string;
}

export type MappingResult =
  { kind: 'product'; product: MappedCatalogProduct } | { kind: 'filtered'; reason: string };

export interface DelimitedSourceOptions {
  /** Disable quote interpretation for providers whose TSV contract treats `"` literally. */
  readonly quote?: string | false;
  readonly relaxColumnCount?: boolean;
  readonly relaxQuotes?: boolean;
  readonly skipRecordsWithError?: boolean;
  readonly trim?: boolean;
}

export interface CatalogMapper {
  readonly id: string;
  readonly defaultDelimiter?: string;
  /** Provider-specific parsing contract; generic CSV/TSV semantics remain the default. */
  readonly delimitedSourceOptions?: Readonly<DelimitedSourceOptions>;
  /**
   * Fail fast when a declared full snapshot does not expose the provider's
   * required columns. Delimited sources expose their header through row keys.
   */
  validateFullSnapshotHeader?(columns: readonly string[]): void;
  map(row: RawCatalogRow): MappingResult;
}

export interface SnapshotActivationPolicy {
  /** Absolute floor used when no prior successful full generation exists. */
  minimumRows: number;
  /** Minimum staged-row coverage compared with the previous full generation. */
  minimumPreviousCoverage: number;
  /** Maximum rejected/processed row ratio accepted before activation. */
  maximumRejectedRatio: number;
}

export interface SourceCatalogMetadata {
  name: string;
  version: string;
  licenseName: string;
  licenseUrl?: string | null;
  /** Version of the streaming/parser/normalization pipeline. */
  importerVersion: string;
  /** Version of the provider-to-Notons field projection. */
  projectionVersion: string;
  /** JSON-safe parsing and scope options that affect the staged generation. */
  importOptions: Record<string, unknown>;
  /** Provider publication timestamp used to prevent snapshot rollback. */
  sourcePublishedAt?: string | null;
  /** True only for an unfiltered, complete provider generation. */
  isFullSnapshot?: boolean;
  /** Server-enforced safety policy for an explicitly complete generation. */
  snapshotActivationPolicy?: SnapshotActivationPolicy;
}

export interface ImportCounters {
  currentOffset: number;
  processedRows: number;
  insertedRows: number;
  updatedRows: number;
  rejectedRows: number;
  filteredRows: number;
}

export interface ImportSession extends ImportCounters {
  jobId: string;
  sourceCatalogId: string;
}

export interface CatalogImportError {
  rowNumber: number;
  rawBarcode: string | null;
  errorCode: string;
  errorMessage: string;
  rawData?: RawCatalogRow | null;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

export interface CatalogImportBatch {
  jobId: string;
  sourceCatalogId: string;
  products: readonly ImportProduct[];
  errors: readonly CatalogImportError[];
  /**
   * Parsed-row counters for the batch. `insertedRows` and `updatedRows` still
   * contain the totals from the last committed batch; the repository adds the
   * upsert result before persisting the checkpoint.
   */
  counters: ImportCounters;
  updateExisting: boolean;
}

export interface CommitBatchResult {
  upsert: UpsertResult;
  counters: ImportCounters;
}

export interface CatalogActivationResult {
  insertedRows: number;
  updatedRows: number;
  unchangedRows: number;
  staleRows: number;
  aliasRowsSkipped: number;
  affectedRows?: number;
}

export interface StoredProduct extends ImportProduct {
  sourceCatalogId: string | null;
  dataQualityStatus?: 'unverified' | 'imported' | 'verified' | 'rejected' | 'disabled';
  sourceKind?:
    'catalog_import' | 'open_food_facts_api' | 'community_submission' | 'moderator' | 'demo';
  offSyncedAt?: string | null;
  catalogSyncStatus?: CatalogSyncStatus;
}

export interface CatalogRepository {
  hasCompletedImport(checksum: string): Promise<boolean>;
  findResumableImport(
    checksum: string,
    filename: string,
    metadata: SourceCatalogMetadata,
  ): Promise<ImportSession | null>;
  createImport(input: {
    checksum: string;
    filename: string;
    metadata: SourceCatalogMetadata;
  }): Promise<ImportSession>;
  resumeImport(jobId: string): Promise<void>;
  /** Commits products, row errors and the resumable checkpoint atomically. */
  commitBatch(batch: CatalogImportBatch): Promise<CommitBatchResult>;
  completeImport(
    session: ImportSession,
    counters: ImportCounters,
  ): Promise<CatalogActivationResult>;
  pauseImport(jobId: string, counters: ImportCounters, reason: string): Promise<void>;
  failImport(jobId: string, counters: ImportCounters, error: string): Promise<void>;
  findProductByGtin(canonicalGtin: string): Promise<StoredProduct | null>;
  searchProducts(query: string, limit?: number): Promise<StoredProduct[]>;
  close?(): Promise<void>;
}

export interface ImportProgress extends ImportCounters {
  checksum: string;
  filename: string;
  dryRun: boolean;
}

export interface CatalogImportOptions {
  filePath: string;
  mapper: CatalogMapper;
  repository: CatalogRepository;
  metadata: SourceCatalogMetadata;
  /** Also validates full-snapshot columns during a dry run/check. */
  validateFullSnapshotHeader?: boolean;
  batchSize?: number;
  delimiter?: string;
  dryRun?: boolean;
  forceReimport?: boolean;
  limit?: number;
  resume?: boolean;
  updateExisting?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void | Promise<void>;
}

export interface CatalogImportResult extends ImportProgress {
  status: 'completed' | 'already-completed' | 'paused' | 'dry-run';
  sourceCatalogId: string | null;
  jobId: string | null;
  resumedFromOffset: number;
  errorSamples: CatalogImportError[];
  elapsedMs: number;
  activation: CatalogActivationResult | null;
}
