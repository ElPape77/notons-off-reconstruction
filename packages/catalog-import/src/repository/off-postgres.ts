import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import type {
  OffCatalogReconstructionRepository,
  OffReconstructionBatch,
  OffReconstructionMetadata,
  OffReconstructionSourceContract,
  OffReconstructionSeal,
  OffReconstructionSession,
  OffDatasetStatus,
} from '../off-reconstruction.js';
import type { OffMigrationLedgerEntry } from '../migration-ledger.js';
import type { ImportProduct } from '../types.js';

interface DatasetRow extends QueryResultRow {
  dataset_id: string;
  job_id: string;
  status: string;
  source_offset: string | number;
  processed_rows: string | number;
  staged_rows: string | number;
  rejected_rows: string | number;
  filtered_rows: string | number;
  source_fingerprint: string | null;
}

interface SealRow extends QueryResultRow {
  staged_rows: string | number;
  source_fingerprint: string;
}

const safeCount = (value: string | number): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Compteur PostgreSQL invalide.');
  return count;
};

const statusValue = (value: string): OffDatasetStatus => {
  if (value === 'copying' || value === 'staged' || value === 'activating' || value === 'active') {
    return value;
  }
  throw new Error(`État de reconstruction OFF non pris en charge : ${value}.`);
};

const toSession = (row: DatasetRow): OffReconstructionSession => ({
  datasetId: row.dataset_id,
  jobId: row.job_id,
  status: statusValue(row.status),
  currentOffset: safeCount(row.source_offset),
  processedRows: safeCount(row.processed_rows),
  insertedRows: safeCount(row.staged_rows),
  updatedRows: 0,
  rejectedRows: safeCount(row.rejected_rows),
  filteredRows: safeCount(row.filtered_rows),
  stagedRows: safeCount(row.staged_rows),
  sourceFingerprint: row.source_fingerprint,
});

const stagingRecord = (product: ImportProduct): Record<string, unknown> => ({
  barcode: product.barcode,
  canonical_gtin: product.canonicalGtin,
  name: product.name,
  generic_name: product.genericName,
  brand: product.brand,
  quantity: product.quantity,
  packaging: product.packaging,
  category_slug: product.categorySlug,
  source_product_id: product.sourceProductId,
  source_updated_at: product.offLastModifiedAt,
  source_image_url: product.sourceImageUrl,
  off_categories: product.offCategories,
  off_category_tags: product.offCategoryTags,
  countries: product.countries,
  country_tags: product.countryTags,
  stores: product.stores,
  purchase_places: product.purchasePlaces,
  nutriscore_grade: product.nutriscoreGrade,
  nutriscore_score: product.nutriscoreScore,
  environmental_score_grade: product.environmentalScoreGrade,
  environmental_score_score: product.environmentalScoreScore,
  serving_size: product.servingSize,
  nutriments: product.nutriments,
  energy_kj_100g: product.nutrition.energyKj100g,
  energy_kcal_100g: product.nutrition.energyKcal100g,
  fat_100g: product.nutrition.fat100g,
  saturated_fat_100g: product.nutrition.saturatedFat100g,
  carbohydrates_100g: product.nutrition.carbohydrates100g,
  sugars_100g: product.nutrition.sugars100g,
  fiber_100g: product.nutrition.fiber100g,
  proteins_100g: product.nutrition.proteins100g,
  salt_100g: product.nutrition.salt100g,
  sodium_100g: product.nutrition.sodium100g,
  energy_kj_serving: product.nutrition.energyKjServing,
  energy_kcal_serving: product.nutrition.energyKcalServing,
  fat_serving: product.nutrition.fatServing,
  saturated_fat_serving: product.nutrition.saturatedFatServing,
  carbohydrates_serving: product.nutrition.carbohydratesServing,
  sugars_serving: product.nutrition.sugarsServing,
  fiber_serving: product.nutrition.fiberServing,
  proteins_serving: product.nutrition.proteinsServing,
  salt_serving: product.nutrition.saltServing,
  sodium_serving: product.nutrition.sodiumServing,
  open_food_facts_url: product.openFoodFactsUrl,
  image_front_thumb_url: product.imageFrontThumbUrl,
  image_front_small_url: product.imageFrontSmallUrl,
  image_front_url: product.imageFrontUrl,
  image_front_original_url: product.imageFrontOriginalUrl,
  off_last_modified_at: product.offLastModifiedAt,
  off_last_updated_at: product.offLastUpdatedAt,
});

export class OffCatalogPostgresRepository implements OffCatalogReconstructionRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      application_name: 'notons-off-reconstruction',
      max: 2,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on('connect', (client) => {
      void client.query("set application_name = 'notons-off-reconstruction'");
    });
  }

  async assertMigrationLedger(expected: readonly OffMigrationLedgerEntry[]): Promise<void> {
    const result = await this.pool.query<{ verified: boolean }>(
      `select off_catalog.attest_schema_migration_ledger(
         $1::text[], $2::text[]
       ) as verified`,
      [expected.map((entry) => entry.filename), expected.map((entry) => entry.sha256)],
    );
    if (result.rows[0]?.verified !== true) {
      throw new Error('PostgreSQL n’a pas attesté le registre exact des migrations OFF.');
    }
  }

  async findSealedReconstruction(
    metadata: OffReconstructionMetadata,
  ): Promise<OffReconstructionSession | null> {
    const result = await this.pool.query<DatasetRow>(
      `select * from off_catalog.find_sealed_native_reconstruction(
         $1::text, $2::text, $3::text, $4::timestamptz, $5::timestamptz,
         $6::text, $7::text, $8::text, $9::text
       )`,
      [
        metadata.sourceUrl,
        metadata.archiveFilename,
        metadata.archiveSha256,
        metadata.sourcePublishedAt,
        metadata.sourceRetrievedAt,
        metadata.importerVersion,
        metadata.projectionVersion,
        metadata.immutableCodeUrl,
        metadata.codeRevision,
      ],
    );
    const row = result.rows[0];
    return row ? toSession(row) : null;
  }

  async beginReconstruction(
    metadata: OffReconstructionMetadata,
    resume: boolean,
    sourceContract?: OffReconstructionSourceContract,
  ): Promise<OffReconstructionSession> {
    return this.transaction(async (client) => {
      const contract = {
        pipeline: metadata.contractVersion,
        mapper: 'open-food-facts',
        scope: { allCountries: true, allCategories: true, fullSnapshot: true },
        sourceHeader: sourceContract?.sourceHeader ?? [],
        immutableCodeUrl: metadata.immutableCodeUrl,
        codeRevision: metadata.codeRevision,
      };
      const result = await client.query<DatasetRow>(
        `select * from off_catalog.begin_native_reconstruction(
           $1::text, $2::text, $3::text, $4::timestamptz, $5::timestamptz,
           $6::text, $7::text, $8::jsonb, $9::boolean
         )`,
        [
          metadata.sourceUrl,
          metadata.archiveFilename,
          metadata.archiveSha256,
          metadata.sourcePublishedAt,
          metadata.sourceRetrievedAt,
          metadata.importerVersion,
          metadata.projectionVersion,
          JSON.stringify(contract),
          resume,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('PostgreSQL n’a pas créé de session de reconstruction OFF.');
      return toSession(row);
    });
  }

  async commitReconstructionBatch(batch: OffReconstructionBatch): Promise<number> {
    const result = await this.pool.query<{ staged_rows: string | number }>(
      `select off_catalog.commit_native_reconstruction_batch(
         $1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::bigint, $6::bigint, $7::jsonb
       ) as staged_rows`,
      [
        batch.session.datasetId,
        batch.session.jobId,
        batch.counters.currentOffset,
        batch.counters.processedRows,
        batch.counters.rejectedRows,
        batch.counters.filteredRows,
        JSON.stringify(batch.products.map(stagingRecord)),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Checkpoint de reconstruction OFF absent.');
    return safeCount(row.staged_rows);
  }

  async sealReconstruction(
    session: OffReconstructionSession,
    counters: OffReconstructionBatch['counters'],
  ): Promise<OffReconstructionSeal> {
    const result = await this.pool.query<SealRow>(
      `select * from off_catalog.seal_native_reconstruction(
         $1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::bigint, $6::bigint
       )`,
      [
        session.datasetId,
        session.jobId,
        counters.currentOffset,
        counters.processedRows,
        counters.rejectedRows,
        counters.filteredRows,
      ],
    );
    const row = result.rows[0];
    if (!row || !/^\d+\|-?\d+\|-?\d+$/.test(row.source_fingerprint)) {
      throw new Error('Empreinte de projection OFF absente ou invalide.');
    }
    return { stagedRows: safeCount(row.staged_rows), sourceFingerprint: row.source_fingerprint };
  }

  async beginActivation(datasetId: string): Promise<number> {
    const result = await this.pool.query<{ activated_rows: string | number }>(
      'select off_catalog.begin_native_reconstruction_activation($1::uuid) as activated_rows',
      [datasetId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Checkpoint initial d’activation OFF absent.');
    return safeCount(row.activated_rows);
  }

  async activateBatch(datasetId: string, batchSize: number): Promise<number> {
    const result = await this.pool.query<{ activated_rows: string | number }>(
      'select off_catalog.activate_initial_dataset_batch($1::uuid, $2::integer) as activated_rows',
      [datasetId, batchSize],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Checkpoint de lot d’activation OFF absent.');
    return safeCount(row.activated_rows);
  }

  async finalizeActivation(datasetId: string): Promise<number> {
    const result = await this.pool.query<{ published_rows: string | number }>(
      'select off_catalog.finalize_native_reconstruction($1::uuid) as published_rows',
      [datasetId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Résultat final d’activation OFF absent.');
    return safeCount(row.published_rows);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
