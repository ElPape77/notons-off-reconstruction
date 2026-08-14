import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ColumnMapper,
  DuplicateImportError,
  ImportInterruptedError,
  MemoryCatalogRepository,
  OpenFoodFactsMapper,
  importCatalog,
  type CatalogImportBatch,
  type CatalogImportOptions,
  type CatalogMapper,
  type ImportProduct,
  type UpsertResult,
} from '../src/index.js';

const HEADER = 'ean,label,brand,category,is_demo\n';
const metadata = {
  name: 'Fixture locale',
  version: 'test-1',
  licenseName: 'Données de test',
  licenseUrl: null,
  importerVersion: 'fixture-importer-v1',
  projectionVersion: 'fixture-columns-v1',
  importOptions: { mapper: 'columns', updateExisting: true },
  sourcePublishedAt: null,
};

const mapper = new ColumnMapper({
  barcode: 'ean',
  name: 'label',
  brand: 'brand',
  categorySlug: 'category',
  isDemo: 'is_demo',
});

describe("pipeline d'import", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'notons-import-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const fixture = async (name: string, body: string): Promise<string> => {
    const path = join(directory, name);
    await writeFile(path, body, 'utf8');
    return path;
  };

  const options = (
    filePath: string,
    repository: MemoryCatalogRepository,
    extra: Partial<CatalogImportOptions> = {},
  ): CatalogImportOptions => {
    const selectedMapper = extra.mapper ?? mapper;
    const updateExisting = extra.updateExisting ?? true;
    return {
      filePath,
      repository,
      mapper: selectedMapper,
      metadata: {
        ...metadata,
        importOptions: { mapper: selectedMapper.id, updateExisting },
      },
      batchSize: 2,
      ...extra,
      updateExisting,
    };
  };

  it('importe un CSV valide par lots et retrouve le produit', async () => {
    const file = await fixture(
      'valid.csv',
      `${HEADER}4006381333931,Chips Épicées,Démo,chips-aromatisees,true\n96385074,Mini chips,Démo,chips-nature,true\n`,
    );
    const repository = new MemoryCatalogRepository();
    const progress = vi.fn();

    const result = await importCatalog(options(file, repository, { onProgress: progress }));

    expect(result).toMatchObject({ status: 'completed', insertedRows: 2, rejectedRows: 0 });
    expect(repository.products).toHaveLength(2);
    expect(await repository.findProductByGtin('04006381333931')).toMatchObject({
      name: 'Chips Épicées',
      categorySlug: 'chips-aromatisees',
    });
    expect(progress).toHaveBeenCalled();
  });

  it('applique le contrat TSV littéral du mapper Open Food Facts', async () => {
    const file = await fixture(
      'off-literal-quotes.csv',
      [
        'code\tproduct_name',
        '4006381333931\t  "mezzelune" semi circular stuffed pasta, ravioli',
        '96385074\tProduit suivant',
        '',
      ].join('\n'),
    );
    const repository = new MemoryCatalogRepository();
    const offMapper = new OpenFoodFactsMapper();

    const result = await importCatalog(options(file, repository, { mapper: offMapper }));

    expect(result).toMatchObject({ processedRows: 2, insertedRows: 2, rejectedRows: 0 });
    expect(repository.products.get('04006381333931')?.name).toBe(
      '"mezzelune" semi circular stuffed pasta, ravioli',
    );
    expect(repository.products.get('00000096385074')?.name).toBe('Produit suivant');
  });

  it('borne les lots sous la limite de paramètres PostgreSQL', async () => {
    const file = await fixture(
      'batch-limit.csv',
      `${HEADER}4006381333931,Produit,Démo,chips-nature,true\n`,
    );
    await expect(
      importCatalog(options(file, new MemoryCatalogRepository(), { batchSize: 1_001 })),
    ).rejects.toThrow(/1000/);
  });

  it('journalise les lignes invalides et poursuit', async () => {
    const file = await fixture(
      'invalid.csv',
      `${HEADER}4006381333932,Mauvaise clé,Démo,chips-nature,true\n96385074,,Démo,chips-nature,true\n4006381333931,Valide,Démo,chips-nature,true\n`,
    );
    const repository = new MemoryCatalogRepository();

    const result = await importCatalog(options(file, repository));

    expect(result).toMatchObject({ insertedRows: 1, rejectedRows: 2 });
    expect(repository.errors.map((error) => error.errorCode)).toEqual([
      'INVALID_GTIN_CHECK_DIGIT',
      'MISSING_PRODUCT_NAME',
    ]);
  });

  it("rejette un nom composé d'un seul caractère Unicode sans faire échouer le lot", async () => {
    const file = await fixture(
      'single-astral-name.csv',
      `${HEADER}4006381333931,🍿,Démo,chips-nature,true\n96385074,Produit valide,Démo,chips-nature,true\n`,
    );
    const repository = new MemoryCatalogRepository();

    const result = await importCatalog(options(file, repository));

    expect(result).toMatchObject({
      status: 'completed',
      processedRows: 2,
      insertedRows: 1,
      rejectedRows: 1,
    });
    expect(repository.errors).toHaveLength(1);
    expect(repository.errors[0]).toMatchObject({ errorCode: 'INVALID_PRODUCT_NAME' });
    expect(repository.products).toHaveLength(1);
    expect(repository.products.get('00000096385074')?.name).toBe('Produit valide');
  });

  it('tronque les textes longs par points de code sans couper un caractère astral', async () => {
    const longName = '🍿'.repeat(161);
    const file = await fixture(
      'long-astral-name.csv',
      `${HEADER}4006381333931,${longName},Démo,chips-nature,true\n`,
    );
    const repository = new MemoryCatalogRepository();

    const result = await importCatalog(options(file, repository));
    const importedName = repository.products.get('04006381333931')?.name;

    expect(result).toMatchObject({ status: 'completed', insertedRows: 1, rejectedRows: 0 });
    expect(importedName).toBe('🍿'.repeat(160));
    expect(Array.from(importedName ?? '')).toHaveLength(160);
  });

  it('refuse le même checksum puis reste idempotent en réimport forcé', async () => {
    const file = await fixture(
      'same.csv',
      `${HEADER}4006381333931,Produit,Démo,chips-nature,true\n`,
    );
    const repository = new MemoryCatalogRepository();
    await importCatalog(options(file, repository));

    await expect(importCatalog(options(file, repository))).rejects.toBeInstanceOf(
      DuplicateImportError,
    );
    const jobCount = repository.jobs.size;
    await expect(importCatalog(options(file, repository, { resume: true }))).resolves.toMatchObject(
      {
        status: 'already-completed',
        jobId: null,
        activation: null,
      },
    );
    expect(repository.jobs).toHaveLength(jobCount);
    const forced = await importCatalog(options(file, repository, { forceReimport: true }));
    expect(forced).toMatchObject({
      insertedRows: 0,
      updatedRows: 0,
      activation: { unchangedRows: 1 },
    });
    expect(repository.products).toHaveLength(1);
    expect(repository.stagingProducts).toHaveLength(0);
  });

  it('met à jour un produit importé mais préserve une correction vérifiée', async () => {
    const first = await fixture(
      'first.csv',
      `${HEADER}4006381333931,Ancien nom,Démo,chips-nature,true\n`,
    );
    const second = await fixture(
      'second.csv',
      `${HEADER}4006381333931,Nouveau nom,Démo,chips-aromatisees,true\n`,
    );
    const third = await fixture(
      'third.csv',
      `${HEADER}4006381333931,Nom fournisseur,Démo,tortillas,true\n`,
    );
    const repository = new MemoryCatalogRepository();
    await importCatalog(options(first, repository));
    await importCatalog(options(second, repository));
    expect(repository.products.get('04006381333931')?.name).toBe('Nouveau nom');

    const corrected = repository.products.get('04006381333931') as ImportProduct & {
      sourceCatalogId: string;
      dataQualityStatus: 'verified';
      sourceKind: 'moderator';
    };
    repository.products.set('04006381333931', {
      ...corrected,
      name: 'Nom corrigé par la modération',
      categorySlug: 'chips-nature',
      dataQualityStatus: 'verified',
      sourceKind: 'moderator',
    });
    await importCatalog(options(third, repository));
    expect(repository.products.get('04006381333931')).toMatchObject({
      name: 'Nom corrigé par la modération',
      categorySlug: 'chips-nature',
      dataQualityStatus: 'verified',
    });
  });

  it('ignore une generation OFF dont le timestamp produit est inchange', async () => {
    const first = await fixture(
      'off-first.jsonl',
      `${JSON.stringify({
        code: '4006381333931',
        product_name: 'Nom initial',
        last_modified_t: 1_786_365_296,
      })}\n`,
    );
    const unchanged = await fixture(
      'off-unchanged.jsonl',
      `${JSON.stringify({
        code: '4006381333931',
        product_name: 'Nom qui ne doit pas remplacer le cache',
        last_modified_t: 1_786_365_296,
      })}\n`,
    );
    const repository = new MemoryCatalogRepository();
    const offMapper = new OpenFoodFactsMapper();
    const offOptions = (filePath: string): CatalogImportOptions =>
      options(filePath, repository, { mapper: offMapper });

    await importCatalog(offOptions(first));
    const result = await importCatalog(offOptions(unchanged));

    expect(result).toMatchObject({
      insertedRows: 0,
      updatedRows: 0,
      activation: { unchangedRows: 1 },
    });
    expect(repository.products.get('04006381333931')?.name).toBe('Nom initial');
  });

  it('ne stocke aucun nutriment flexible vide ni champ nutritionnel standard duplique', async () => {
    const file = await fixture(
      'off-nutriments.jsonl',
      `${JSON.stringify({
        code: '4006381333931',
        product_name: 'Nutrition propre',
        nutriments: {
          fat_100g: 12,
          sugars_serving: '3',
          'vitamin-d_100g': '   ',
          zinc_unit: ' mg ',
        },
      })}\n`,
    );
    const repository = new MemoryCatalogRepository();
    const offMapper = new OpenFoodFactsMapper();
    const importOptions = options(file, repository, { mapper: offMapper });

    await importCatalog(importOptions);

    expect(repository.products.get('04006381333931')).toMatchObject({
      nutrition: { fat100g: 12, sugarsServing: 3 },
      nutriments: { zinc_unit: 'mg' },
    });
    expect(repository.products.get('04006381333931')?.nutriments).toEqual({ zinc_unit: 'mg' });
  });

  it('reprend après une limite sans relire les lignes déjà validées', async () => {
    const file = await fixture(
      'resume.csv',
      `${HEADER}4006381333931,Un,Démo,chips-nature,true\n96385074,Deux,Démo,chips-nature,true\n036000291452,Trois,Démo,tortillas,true\n`,
    );
    const repository = new MemoryCatalogRepository();
    const partial = await importCatalog(options(file, repository, { limit: 1 }));
    expect(partial).toMatchObject({ status: 'paused', currentOffset: 1, insertedRows: 1 });
    expect(repository.products).toHaveLength(0);
    expect([...repository.stagingProducts.values()][0]).toHaveLength(1);

    const completed = await importCatalog(options(file, repository, { resume: true }));
    expect(completed).toMatchObject({
      status: 'completed',
      resumedFromOffset: 1,
      insertedRows: 3,
      processedRows: 3,
    });
    expect(repository.products).toHaveLength(3);
  });

  it('refuse une reprise avec une autre version de projection ou un autre scope', async () => {
    const file = await fixture(
      'resume-contract.csv',
      `${HEADER}4006381333931,Un,Demo,chips-nature,true\n96385074,Deux,Demo,chips-nature,true\n`,
    );
    const repository = new MemoryCatalogRepository();
    await importCatalog(options(file, repository, { limit: 1 }));

    const changedMetadata = {
      ...metadata,
      projectionVersion: 'fixture-columns-v2',
      importOptions: { mapper: 'columns', updateExisting: true },
    };
    await expect(
      importCatalog(options(file, repository, { resume: true, metadata: changedMetadata })),
    ).rejects.toMatchObject({ code: 'IMPORT_CONTRACT_MISMATCH' });

    await expect(
      importCatalog(
        options(file, repository, {
          resume: true,
          metadata: { ...metadata, importerVersion: 'fixture-importer-v2' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_CONTRACT_MISMATCH' });
    expect([...repository.jobs.values()][0]).toMatchObject({ status: 'paused' });
  });

  it('valide aussi le header full-snapshot en dry-run sans autoriser une activation', async () => {
    const invalid = await fixture(
      'invalid-off-header.csv',
      'wrong,columns\n4006381333931,Produit\n',
    );
    const repository = new MemoryCatalogRepository();
    const offMapper = new OpenFoodFactsMapper();
    const fullCheck = options(invalid, repository, {
      mapper: offMapper,
      dryRun: true,
      validateFullSnapshotHeader: true,
    });
    fullCheck.metadata = {
      ...fullCheck.metadata,
      sourcePublishedAt: '2026-08-11T00:00:00.000Z',
      importOptions: { mapper: offMapper.id, updateExisting: true, validateFullSnapshot: true },
    };

    await expect(importCatalog(fullCheck)).rejects.toMatchObject({
      code: 'INVALID_FULL_SNAPSHOT_HEADER',
    });
    expect(repository.jobs).toHaveLength(0);
    expect(repository.products).toHaveLength(0);
  });

  it('conserve le compteur des lignes filtrees lors de la reprise', async () => {
    const file = await fixture(
      'resume-filtered.csv',
      `${HEADER}4006381333931,Ignorer,Demo,chips-nature,true\n96385074,Deux,Demo,chips-nature,true\n036000291452,Trois,Demo,tortillas,true\n`,
    );
    const filteringMapper: CatalogMapper = {
      id: 'fixture-with-filter',
      defaultDelimiter: ',',
      map: (row) =>
        row.label === 'Ignorer'
          ? { kind: 'filtered', reason: 'hors perimetre de la fixture' }
          : mapper.map(row),
    };
    const repository = new MemoryCatalogRepository();

    const partial = await importCatalog(
      options(file, repository, { limit: 1, mapper: filteringMapper }),
    );
    expect(partial).toMatchObject({
      status: 'paused',
      currentOffset: 1,
      processedRows: 1,
      filteredRows: 1,
    });
    expect([...repository.jobs.values()][0]).toMatchObject({ filteredRows: 1 });

    const completed = await importCatalog(
      options(file, repository, { resume: true, mapper: filteringMapper }),
    );
    expect(completed).toMatchObject({
      status: 'completed',
      resumedFromOffset: 1,
      processedRows: 3,
      insertedRows: 2,
      filteredRows: 1,
    });
  });

  it('enregistre un arrêt inattendu puis reprend le même job', async () => {
    const file = await fixture(
      'interrupted.csv',
      `${HEADER}4006381333931,Un,Démo,chips-nature,true\n96385074,Deux,Démo,chips-nature,true\n`,
    );
    const repository = new MemoryCatalogRepository();
    const controller = new AbortController();

    await expect(
      importCatalog(
        options(file, repository, {
          batchSize: 1,
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
      ),
    ).rejects.toBeInstanceOf(ImportInterruptedError);
    expect([...repository.jobs.values()][0]).toMatchObject({ status: 'paused', currentOffset: 1 });

    const resumed = await importCatalog(options(file, repository, { resume: true }));
    expect(resumed).toMatchObject({ status: 'completed', resumedFromOffset: 1, insertedRows: 2 });
    expect(repository.products).toHaveLength(2);
  });

  it("ne saute aucune ligne après l'échec persistant d'un lot", async () => {
    class FailingRepository extends MemoryCatalogRepository {
      calls = 0;
      failing = true;

      override async commitBatch(batch: CatalogImportBatch) {
        this.calls += 1;
        if (this.failing && this.calls >= 2) throw new Error('base indisponible');
        return super.commitBatch(batch);
      }
    }

    const file = await fixture(
      'database-failure.csv',
      `${HEADER}4006381333931,Un,Démo,chips-nature,true\n96385074,Deux,Démo,chips-nature,true\n`,
    );
    const repository = new FailingRepository();
    await expect(importCatalog(options(file, repository, { batchSize: 1 }))).rejects.toThrow(
      'base indisponible',
    );
    expect([...repository.jobs.values()][0]).toMatchObject({
      status: 'failed',
      currentOffset: 1,
      insertedRows: 1,
    });
    expect(repository.products).toHaveLength(0);
    expect([...repository.stagingProducts.values()][0]).toHaveLength(1);

    repository.failing = false;
    const resumed = await importCatalog(options(file, repository, { batchSize: 1, resume: true }));
    expect(resumed).toMatchObject({ status: 'completed', insertedRows: 2 });
    expect(repository.products).toHaveLength(2);
  });

  it("annule tout le lot si l'ecriture echoue apres l'upsert", async () => {
    class FailingAfterUpsertRepository extends MemoryCatalogRepository {
      failing = true;
      calls = 0;

      protected override async afterBatchUpsert(
        _batch: CatalogImportBatch,
        _result: UpsertResult,
      ): Promise<void> {
        this.calls += 1;
        if (this.failing) throw new Error('checkpoint indisponible apres upsert');
      }
    }

    const file = await fixture(
      'atomic-failure.csv',
      `${HEADER}4006381333931,Valide,Demo,chips-nature,true\n4006381333932,Cle invalide,Demo,chips-nature,true\n`,
    );
    const repository = new FailingAfterUpsertRepository();

    await expect(importCatalog(options(file, repository))).rejects.toThrow(
      'checkpoint indisponible apres upsert',
    );
    expect(repository.calls).toBe(1);
    expect(repository.products).toHaveLength(0);
    expect(repository.errors).toHaveLength(0);
    expect([...repository.jobs.values()][0]).toMatchObject({
      status: 'failed',
      currentOffset: 0,
      processedRows: 0,
      insertedRows: 0,
      rejectedRows: 0,
      filteredRows: 0,
    });

    repository.failing = false;
    const resumed = await importCatalog(options(file, repository, { resume: true }));
    expect(resumed).toMatchObject({
      status: 'completed',
      resumedFromOffset: 0,
      processedRows: 2,
      insertedRows: 1,
      rejectedRows: 1,
    });
    expect(repository.products).toHaveLength(1);
    expect(repository.errors).toHaveLength(1);
  });

  it('ne réalise aucune écriture et aucun appel externe en dry-run', async () => {
    const file = await fixture(
      'dry.csv',
      `${HEADER}4006381333931,Produit démo,Démo,chips-nature,true\n`,
    );
    const repository = new MemoryCatalogRepository();
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => Promise.reject(new Error('appel interdit')));
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      const result = await importCatalog(options(file, repository, { dryRun: true }));
      expect(result).toMatchObject({ status: 'dry-run', insertedRows: 1 });
      expect(repository.products).toHaveLength(0);
      expect(repository.jobs).toHaveLength(0);
      expect(repository.errors).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('garde la déduplication du dry-run bornée au lot', async () => {
    const file = await fixture(
      'dry-bounded.csv',
      `${HEADER}4006381333931,Produit démo,Démo,chips-nature,true\n4006381333931,Produit démo,Démo,chips-nature,true\n`,
    );
    const result = await importCatalog(
      options(file, new MemoryCatalogRepository(), { dryRun: true, batchSize: 1 }),
    );
    expect(result).toMatchObject({ processedRows: 2, insertedRows: 2, updatedRows: 0 });
  });

  it('recherche sans tenir compte des accents ni de la casse', async () => {
    const file = await fixture(
      'search.csv',
      `${HEADER}4006381333931,Chips Épicées,Démo,chips-aromatisees,true\n`,
    );
    const repository = new MemoryCatalogRepository();
    await importCatalog(options(file, repository));
    expect(await repository.searchProducts('EPICEES')).toHaveLength(1);
  });
});
