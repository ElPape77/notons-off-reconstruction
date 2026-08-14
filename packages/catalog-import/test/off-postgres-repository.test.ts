import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_PRODUCT_NUTRITION,
  OffCatalogPostgresRepository,
  type ImportProduct,
  type OffReconstructionMetadata,
  type OffReconstructionSession,
} from '../src/index.js';

const pg = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  query: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: class {
    connect = pg.connect;
    end = pg.end;
    on = pg.on;
    query = pg.query;
  },
}));

const metadata: OffReconstructionMetadata = {
  sourceUrl: 'https://static.openfoodfacts.org/data/openfoodfacts-products.csv.gz',
  archiveFilename: 'openfoodfacts-products.csv.gz',
  archiveSha256: 'a'.repeat(64),
  sourcePublishedAt: '2026-08-12T00:00:00.000Z',
  sourceRetrievedAt: '2026-08-12T01:00:00.000Z',
  importerVersion: 'notons-catalog-import/fixture',
  projectionVersion: 'notons-off-projection/fixture',
  immutableCodeUrl: 'https://example.invalid/notons/tree/fixture',
  codeRevision: 'b'.repeat(40),
  contractVersion: 'notons-off-reconstruction/v1',
};

const datasetRow = {
  dataset_id: '10000000-0000-4000-8000-000000000001',
  job_id: '20000000-0000-4000-8000-000000000001',
  status: 'copying',
  source_offset: '12',
  processed_rows: '11',
  staged_rows: '9',
  rejected_rows: '1',
  filtered_rows: '1',
  source_fingerprint: null,
};

const session: OffReconstructionSession = {
  datasetId: datasetRow.dataset_id,
  jobId: datasetRow.job_id,
  status: 'copying',
  currentOffset: 12,
  processedRows: 11,
  insertedRows: 9,
  updatedRows: 0,
  rejectedRows: 1,
  filteredRows: 1,
  stagedRows: 9,
  sourceFingerprint: null,
};

const product: ImportProduct = {
  barcode: '3017620422003',
  canonicalGtin: '03017620422003',
  name: 'Produit test',
  genericName: 'Pâte à tartiner',
  brand: 'Notons',
  quantity: '400 g',
  packaging: 'Pot',
  categorySlug: null,
  sourceProductId: '3017620422003',
  sourceImageUrl: null,
  offCategories: ['Pâtes à tartiner'],
  offCategoryTags: ['en:spreads'],
  countries: ['France'],
  countryTags: ['en:france'],
  stores: ['Épicerie'],
  purchasePlaces: ['Paris'],
  nutriscoreGrade: 'e',
  nutriscoreScore: 26,
  environmentalScoreGrade: 'd',
  environmentalScoreScore: 31,
  servingSize: '15 g',
  nutriments: { cocoa: 13 },
  nutrition: { ...EMPTY_PRODUCT_NUTRITION, sugars100g: 56.3, proteins100g: 6.3 },
  openFoodFactsUrl: 'https://world.openfoodfacts.org/product/3017620422003',
  imageFrontThumbUrl:
    'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_fr.4.100.jpg',
  imageFrontSmallUrl: null,
  imageFrontUrl: null,
  imageFrontOriginalUrl: null,
  offLastModifiedAt: '2026-08-11T10:00:00.000Z',
  offLastUpdatedAt: '2026-08-11T11:00:00.000Z',
  imageStoragePath: null,
  isDemo: false,
};

beforeEach(() => {
  for (const mock of Object.values(pg)) mock.mockReset();
});

describe('OffCatalogPostgresRepository', () => {
  it('fait attester le registre exact des migrations par PostgreSQL', async () => {
    const ledger = [
      { filename: '001_catalog_foundation.sql', sha256: 'a'.repeat(64) },
      { filename: '012_attested_migration_ledger.sql', sha256: 'b'.repeat(64) },
    ];
    const repository = new OffCatalogPostgresRepository('postgresql://off-importer.invalid/db');
    pg.query.mockResolvedValueOnce({ rows: [{ verified: true }] });

    await expect(repository.assertMigrationLedger(ledger)).resolves.toBeUndefined();
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('attest_schema_migration_ledger'),
      [ledger.map((entry) => entry.filename), ledger.map((entry) => entry.sha256)],
    );

    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(repository.assertMigrationLedger(ledger)).rejects.toThrow(
      'registre exact des migrations OFF',
    );
  });

  it('maps a sealed session and sends every provenance field to PostgreSQL', async () => {
    pg.query.mockResolvedValue({ rows: [{ ...datasetRow, status: 'staged' }] });
    const repository = new OffCatalogPostgresRepository('postgresql://off-reader.invalid/db');

    await expect(repository.findSealedReconstruction(metadata)).resolves.toEqual({
      ...session,
      status: 'staged',
    });
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('find_sealed_native_reconstruction'),
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
  });

  it('creates a reconstruction atomically and rolls back an incomplete response', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    pg.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [datasetRow] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = new OffCatalogPostgresRepository('postgresql://off-importer.invalid/db');

    await expect(
      repository.beginReconstruction(metadata, true, { sourceHeader: ['code', 'product_name'] }),
    ).resolves.toEqual(session);
    expect(client.query.mock.calls.map(([statement]) => String(statement).trim())).toEqual([
      'begin',
      expect.stringContaining('begin_native_reconstruction'),
      'commit',
    ]);
    const contract = JSON.parse(String(client.query.mock.calls[1]?.[1]?.[7]));
    expect(contract).toMatchObject({
      pipeline: metadata.contractVersion,
      mapper: 'open-food-facts',
      sourceHeader: ['code', 'product_name'],
      codeRevision: metadata.codeRevision,
      scope: { allCountries: true, allCategories: true, fullSnapshot: true },
    });
    expect(client.release).toHaveBeenCalledOnce();

    client.query.mockReset();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(repository.beginReconstruction(metadata, false)).rejects.toThrow(
      'session de reconstruction OFF',
    );
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('rollback');
  });

  it('serializes the complete product projection in one checkpoint call', async () => {
    pg.query.mockResolvedValue({ rows: [{ staged_rows: '10' }] });
    const repository = new OffCatalogPostgresRepository('postgresql://off-importer.invalid/db');

    await expect(
      repository.commitReconstructionBatch({
        session,
        products: [product],
        counters: {
          currentOffset: 13,
          processedRows: 12,
          insertedRows: 10,
          updatedRows: 0,
          rejectedRows: 1,
          filteredRows: 1,
        },
      }),
    ).resolves.toBe(10);
    const parameters = pg.query.mock.calls[0]?.[1] as unknown[];
    const payload = JSON.parse(String(parameters[6]));
    expect(parameters.slice(0, 6)).toEqual([session.datasetId, session.jobId, 13, 12, 1, 1]);
    expect(payload).toEqual([
      expect.objectContaining({
        barcode: product.barcode,
        canonical_gtin: product.canonicalGtin,
        off_category_tags: product.offCategoryTags,
        sugars_100g: 56.3,
        proteins_100g: 6.3,
        open_food_facts_url: product.openFoodFactsUrl,
      }),
    ]);
  });

  it('validates seals and activation checkpoints before returning counts', async () => {
    const repository = new OffCatalogPostgresRepository('postgresql://off-importer.invalid/db');
    pg.query
      .mockResolvedValueOnce({ rows: [{ staged_rows: '9', source_fingerprint: '9|123|-456' }] })
      .mockResolvedValueOnce({ rows: [{ activated_rows: '2' }] })
      .mockResolvedValueOnce({ rows: [{ activated_rows: '7' }] })
      .mockResolvedValueOnce({ rows: [{ published_rows: '9' }] });

    await expect(
      repository.sealReconstruction(session, {
        currentOffset: 12,
        processedRows: 11,
        insertedRows: 9,
        updatedRows: 0,
        rejectedRows: 1,
        filteredRows: 1,
      }),
    ).resolves.toEqual({ stagedRows: 9, sourceFingerprint: '9|123|-456' });
    await expect(repository.beginActivation(session.datasetId)).resolves.toBe(2);
    await expect(repository.activateBatch(session.datasetId, 1_000)).resolves.toBe(7);
    await expect(repository.finalizeActivation(session.datasetId)).resolves.toBe(9);
    await repository.close();
    expect(pg.end).toHaveBeenCalledOnce();

    pg.query.mockResolvedValueOnce({ rows: [{ staged_rows: 'NaN' }] });
    await expect(
      repository.commitReconstructionBatch({
        session,
        products: [],
        counters: {
          currentOffset: 12,
          processedRows: 11,
          insertedRows: 9,
          updatedRows: 0,
          rejectedRows: 1,
          filteredRows: 1,
        },
      }),
    ).rejects.toThrow('Compteur PostgreSQL invalide');
  });
});
