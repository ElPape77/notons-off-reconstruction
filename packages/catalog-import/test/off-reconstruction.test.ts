import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadOffCatalogDatabaseUrl,
  loadOffCatalogAdminDatabaseUrl,
  buildReconstructionManifest,
  OFF_RECONSTRUCTION_MIGRATION_FILES,
  reconstructOffCatalog,
  type OffCatalogReconstructionRepository,
  type OffMigrationLedgerEntry,
  type OffReconstructionBatch,
  type OffReconstructionMetadata,
  type OffReconstructionSourceContract,
  type OffReconstructionSession,
} from '../src/index.js';

const expectedMigrationLedger = OFF_RECONSTRUCTION_MIGRATION_FILES.map((filename, index) => ({
  filename,
  sha256: index.toString(16).padStart(64, '0'),
}));

const temporaryDirectories: string[] = [];
const TEMP_ENVIRONMENT_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

const withIsolatedSnapshotTemp = async <T>(operation: (directory: string) => Promise<T>) => {
  const directory = await mkdtemp(join(tmpdir(), 'notons-off-snapshot-cleanup-test-'));
  temporaryDirectories.push(directory);
  const previous = Object.fromEntries(
    TEMP_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof TEMP_ENVIRONMENT_KEYS)[number], string | undefined>;
  try {
    for (const key of TEMP_ENVIRONMENT_KEYS) process.env[key] = directory;
    return await operation(directory);
  } finally {
    for (const key of TEMP_ENVIRONMENT_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const archive = async (
  rows: readonly string[],
  header = 'code\tproduct_name\tbrands\tcategories_tags\tingredients_text\tallergens',
): Promise<{ filePath: string; sha256: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'notons-off-reconstruction-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'catalog.tsv.gz');
  const expectedColumns = header.split('\t').length;
  const paddedRows = rows.map((row) => {
    const missingColumns = Math.max(0, expectedColumns - row.split('\t').length);
    return `${row}${'\t'.repeat(missingColumns)}`;
  });
  const data = gzipSync([header, ...paddedRows].join('\n') + '\n');
  await writeFile(filePath, data);
  return { filePath, sha256: createHash('sha256').update(data).digest('hex') };
};

class FakeOffRepository implements OffCatalogReconstructionRepository {
  readonly batches: OffReconstructionBatch[] = [];
  readonly metadata: OffReconstructionMetadata[] = [];
  readonly sourceContracts: OffReconstructionSourceContract[] = [];
  readonly events: string[] = [];
  readonly ledgerChecks: unknown[] = [];
  activatedRows = 0;
  stagedRows = 0;
  beginCalls = 0;
  sealedLookupCalls = 0;
  beforeBegin?: () => void | Promise<void>;

  constructor(
    private readonly initial: Partial<OffReconstructionSession> = {},
    private readonly initialStatus: OffReconstructionSession['status'] = 'copying',
  ) {
    this.stagedRows = initial.stagedRows ?? 0;
  }

  async assertMigrationLedger(expected: readonly OffMigrationLedgerEntry[]): Promise<void> {
    this.events.push('ledger');
    this.ledgerChecks.push(expected);
  }

  async findSealedReconstruction(
    metadata: OffReconstructionMetadata,
  ): Promise<OffReconstructionSession | null> {
    this.events.push('sealed-lookup');
    this.sealedLookupCalls += 1;
    this.metadata.push(metadata);
    if (this.initialStatus === 'copying') return null;
    return this.session();
  }

  async beginReconstruction(
    metadata: OffReconstructionMetadata,
    _resume: boolean,
    sourceContract?: OffReconstructionSourceContract,
  ): Promise<OffReconstructionSession> {
    await this.beforeBegin?.();
    this.events.push('begin');
    this.beginCalls += 1;
    this.metadata.push(metadata);
    if (sourceContract) this.sourceContracts.push(sourceContract);
    return this.session();
  }

  private session(): OffReconstructionSession {
    return {
      datasetId: '10000000-0000-4000-8000-000000000001',
      jobId: '20000000-0000-4000-8000-000000000001',
      status: this.initialStatus,
      currentOffset: 0,
      processedRows: 0,
      insertedRows: 0,
      updatedRows: 0,
      rejectedRows: 0,
      filteredRows: 0,
      stagedRows: this.initial.stagedRows ?? 0,
      sourceFingerprint: this.initial.sourceFingerprint ?? null,
      ...this.initial,
    };
  }

  async commitReconstructionBatch(batch: OffReconstructionBatch): Promise<number> {
    this.batches.push(batch);
    this.stagedRows += batch.products.length;
    return this.stagedRows;
  }

  async sealReconstruction(): Promise<{ stagedRows: number; sourceFingerprint: string }> {
    return { stagedRows: this.stagedRows, sourceFingerprint: `${this.stagedRows}|123|-456` };
  }

  async beginActivation(): Promise<number> {
    this.events.push('activation-begin');
    return this.activatedRows;
  }

  async activateBatch(_datasetId: string, batchSize: number): Promise<number> {
    this.events.push('activation-batch');
    this.activatedRows = Math.min(this.stagedRows, this.activatedRows + batchSize);
    return this.activatedRows;
  }

  async finalizeActivation(): Promise<number> {
    this.events.push('activation-finalize');
    return this.activatedRows;
  }
}

const baseOptions = (filePath: string, expectedSha256: string, repository: FakeOffRepository) => ({
  filePath,
  expectedSha256,
  sourceUrl: 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz',
  sourcePublishedAt: '2026-08-11T00:00:00Z',
  sourceRetrievedAt: '2026-08-11T12:00:00Z',
  immutableCodeUrl:
    'https://github.com/ElPape77/notons-off-reconstruction/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  codeRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  repository,
  expectedMigrationLedger,
});

describe('reconstruction OFF native et isolée', () => {
  it('atteste le registre des migrations avant toute lecture ou session', async () => {
    const source = await archive(['2000000000015\tProduit\tExemple\ten:foods']);
    const repository = new FakeOffRepository();
    const failure = new Error('migration ledger mismatch');
    repository.assertMigrationLedger = async () => {
      repository.events.push('ledger');
      throw failure;
    };

    await expect(
      reconstructOffCatalog(baseOptions(source.filePath, source.sha256, repository)),
    ).rejects.toBe(failure);
    expect(repository.events).toEqual(['ledger']);
    expect(repository.beginCalls).toBe(0);
    expect(repository.batches).toHaveLength(0);
  });

  it('projette une archive une seule fois, checkpoint par checkpoint, puis publie', async () => {
    const source = await archive([
      '3017620422003\tPâte à tartiner\tExemple\ten:sweet-spreads',
      'code-invalide\tProduit rejeté\tExemple\ten:foods',
      '4006381333931\tProduit salé\tExemple\ten:salty-snacks',
    ]);
    const repository = new FakeOffRepository();

    const result = await reconstructOffCatalog({
      ...baseOptions(source.filePath, source.sha256, repository),
      batchSize: 2,
      activationBatchSize: 1,
      activate: true,
    });

    expect(result).toMatchObject({
      status: 'active',
      processedRows: 3,
      rejectedRows: 1,
      filteredRows: 0,
      stagedRows: 2,
      insertedRows: 2,
      archiveSha256: source.sha256,
      sourceFingerprint: '2|123|-456',
    });
    expect(repository.batches).toHaveLength(2);
    expect(repository.batches.flatMap((batch) => batch.products.map((item) => item.name))).toEqual([
      'Pâte à tartiner',
      'Produit salé',
    ]);
    expect(repository.metadata[0]).toMatchObject({
      contractVersion: 'notons-off-reconstruction/1',
      codeRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(repository.sourceContracts[0]?.sourceHeader).toEqual([
      'code',
      'product_name',
      'brands',
      'categories_tags',
      'ingredients_text',
      'allergens',
    ]);
  });

  it('conserve une première ligne malformée comme rejet sans perdre le contrat d’en-tête', async () => {
    const source = await archive([
      'ligne-malformée',
      '3017620422003\tProduit valide\tExemple\ten:foods',
    ]);
    const repository = new FakeOffRepository();

    const result = await reconstructOffCatalog({
      ...baseOptions(source.filePath, source.sha256, repository),
    });

    expect(result).toMatchObject({ processedRows: 2, rejectedRows: 1, stagedRows: 1 });
  });

  it('refuse un en-tête ambigu avant d’ouvrir une session PostgreSQL', async () => {
    const source = await archive(
      ['3017620422003\tProduit\tExemple\ten:foods'],
      'code\tproduct_name\tbrands\tbrands',
    );
    const repository = new FakeOffRepository();

    await withIsolatedSnapshotTemp(async (directory) => {
      await expect(
        reconstructOffCatalog(baseOptions(source.filePath, source.sha256, repository)),
      ).rejects.toThrow('En-tête OFF vide, dupliqué');
      expect(await readdir(directory)).toEqual([]);
    });
    expect(repository.beginCalls).toBe(0);
  });

  it('refuse un snapshot qui omet la projection composition ou allergènes', async () => {
    const source = await archive(
      ['3017620422003\tProduit\tExemple\ten:foods'],
      'code\tproduct_name\tbrands\tcategories_tags',
    );
    const repository = new FakeOffRepository();

    await expect(
      reconstructOffCatalog(baseOptions(source.filePath, source.sha256, repository)),
    ).rejects.toThrow(/ingredients_text, allergens/);
    expect(repository.beginCalls).toBe(0);
  });

  it('reprend à l’offset confirmé sans relire les lignes déjà copiées en base', async () => {
    const source = await archive([
      '3017620422003\tDéjà confirmé\tExemple\ten:foods',
      '4006381333931\tÀ reprendre\tExemple\ten:foods',
    ]);
    const repository = new FakeOffRepository({
      currentOffset: 1,
      processedRows: 1,
      insertedRows: 1,
      stagedRows: 1,
    });

    const result = await reconstructOffCatalog({
      ...baseOptions(source.filePath, source.sha256, repository),
      resume: true,
    });

    expect(repository.batches).toHaveLength(1);
    expect(repository.batches[0]?.products.map((item) => item.name)).toEqual(['À reprendre']);
    expect(result).toMatchObject({ status: 'staged', processedRows: 2, stagedRows: 2 });
  });

  it('peut sceller une reprise dont toutes les lignes source étaient déjà confirmées', async () => {
    const source = await archive(['3017620422003\tDéjà confirmé\tExemple\ten:foods']);
    const repository = new FakeOffRepository({
      currentOffset: 1,
      processedRows: 1,
      insertedRows: 1,
      stagedRows: 1,
    });

    const result = await reconstructOffCatalog({
      ...baseOptions(source.filePath, source.sha256, repository),
      resume: true,
    });

    expect(repository.batches).toHaveLength(0);
    expect(result).toMatchObject({ status: 'staged', processedRows: 1, stagedRows: 1 });
  });

  it('refuse un fichier dont le SHA-256 diffère avant toute session ou activation', async () => {
    const source = await archive(['3017620422003\tProduit\tExemple\ten:foods']);
    const repository = new FakeOffRepository();

    await expect(
      reconstructOffCatalog({
        ...baseOptions(source.filePath, 'b'.repeat(64), repository),
      }),
    ).rejects.toThrow('Empreinte de l’archive OFF incorrecte');
    expect(repository.beginCalls).toBe(0);
    expect(repository.batches).toHaveLength(0);
    expect(repository.events).toEqual(['ledger']);
  });

  it('projette le snapshot vérifié même si le chemin source est ensuite remplacé', async () => {
    const source = await archive([
      '2000000000015\tProduit original un\tExemple\ten:foods',
      '2000000000022\tProduit original deux\tExemple\ten:foods',
    ]);
    const repository = new FakeOffRepository();
    repository.beforeBegin = async () => {
      const replacement = gzipSync(
        'code\tproduct_name\tbrands\tcategories_tags\n' +
          '2000000000039\tProduit remplacé\tExemple\ten:foods\n',
      );
      await writeFile(source.filePath, replacement);
    };

    const result = await reconstructOffCatalog({
      ...baseOptions(source.filePath, source.sha256, repository),
      batchSize: 1,
      activate: true,
    });

    expect(result).toMatchObject({
      status: 'active',
      processedRows: 2,
      stagedRows: 2,
      archiveFilename: 'catalog.tsv.gz',
      archiveSha256: source.sha256,
    });
    expect(repository.batches.flatMap((batch) => batch.products.map((item) => item.name))).toEqual([
      'Produit original un',
      'Produit original deux',
    ]);
  });

  it('ferme le lecteur et supprime le snapshot temporaire après une interruption', async () => {
    const source = await archive([
      '2000000000015\tProduit original un\tExemple\ten:foods',
      '2000000000022\tProduit original deux\tExemple\ten:foods',
    ]);
    const repository = new FakeOffRepository();
    const controller = new AbortController();

    await withIsolatedSnapshotTemp(async (directory) => {
      await expect(
        reconstructOffCatalog({
          ...baseOptions(source.filePath, source.sha256, repository),
          batchSize: 1,
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
      ).rejects.toThrow('interrompue');
      expect(await readdir(directory)).toEqual([]);
    });
  });

  it('impose une archive gzip .tsv et une tabulation physique', async () => {
    const source = await archive(['2000000000015\tProduit\tExemple\ten:foods']);
    const wrongExtension = join(temporaryDirectories.at(-1)!, 'catalog.csv.gz');
    await writeFile(wrongExtension, await readFile(source.filePath));

    await expect(
      reconstructOffCatalog(baseOptions(wrongExtension, source.sha256, new FakeOffRepository())),
    ).rejects.toThrow('.tsv.gz');

    const commaSource = await archive(
      ['2000000000015,Produit,Exemple,en:foods'],
      'code,product_name,brands,categories_tags',
    );
    await expect(
      reconstructOffCatalog(
        baseOptions(commaSource.filePath, commaSource.sha256, new FakeOffRepository()),
      ),
    ).rejects.toThrow('En-tête OFF vide');
  });

  it('exige une source figée, une chronologie valide et la révision immuable', async () => {
    const source = await archive(['3017620422003\tProduit\tExemple\ten:foods']);
    const repository = new FakeOffRepository();

    await expect(
      reconstructOffCatalog({
        ...baseOptions(source.filePath, source.sha256, repository),
        sourceRetrievedAt: '2026-08-10T23:59:59Z',
      }),
    ).rejects.toThrow('ne peut pas précéder');
    await expect(
      reconstructOffCatalog({
        ...baseOptions(source.filePath, source.sha256, repository),
        immutableCodeUrl: 'https://github.com/ElPape77/notons-off-reconstruction/latest',
      }),
    ).rejects.toThrow('révision immuable exacte');
    await expect(
      reconstructOffCatalog({
        ...baseOptions(source.filePath, source.sha256, repository),
        immutableCodeUrl: `https://github.com/ElPape77/notons-off-reconstruction/tree/${'a'.repeat(40)}b`,
      }),
    ).rejects.toThrow('révision immuable exacte');
    await expect(
      reconstructOffCatalog({
        ...baseOptions(source.filePath, source.sha256, repository),
        sourceUrl: 'https://static.openfoodfacts.org/data/export.tsv.gz?mutable=1',
      }),
    ).rejects.toThrow();
    await expect(
      reconstructOffCatalog({
        ...baseOptions(source.filePath, source.sha256, repository),
        sourcePublishedAt: '2026-02-30T00:00:00Z',
      }),
    ).rejects.toThrow();
    expect(repository.beginCalls).toBe(0);
  });

  it('reconnaît sans retraitement une génération déjà active et scellée', async () => {
    const source = await archive(['3017620422003\tProduit\tExemple\ten:foods']);
    const repository = new FakeOffRepository(
      {
        currentOffset: 1,
        processedRows: 1,
        insertedRows: 1,
        stagedRows: 1,
        sourceFingerprint: '1|12|34',
      },
      'active',
    );

    const result = await reconstructOffCatalog({
      ...baseOptions(source.filePath, source.sha256, repository),
    });

    expect(result.status).toBe('already-active');
    expect(repository.batches).toHaveLength(0);
  });

  it('reprend une génération scellée sans relire une archive locale devenue absente', async () => {
    const source = await archive(['3017620422003\tProduit\tExemple\ten:foods']);
    const repository = new FakeOffRepository(
      {
        currentOffset: 1,
        processedRows: 1,
        insertedRows: 1,
        stagedRows: 1,
        sourceFingerprint: '1|12|34',
      },
      'staged',
    );
    await rm(source.filePath);

    const result = await reconstructOffCatalog({
      ...baseOptions(source.filePath, source.sha256, repository),
      resume: true,
    });

    expect(result).toMatchObject({ status: 'staged', sourceFingerprint: '1|12|34' });
    expect(repository.sealedLookupCalls).toBe(1);
    expect(repository.beginCalls).toBe(0);
    expect(repository.sourceContracts).toHaveLength(0);
  });

  it('ne laisse jamais le raccourci scellé masquer une reprise encore en copie', async () => {
    const source = await archive(['3017620422003\tProduit\tExemple\ten:foods']);
    const repository = new FakeOffRepository(
      {
        currentOffset: 1,
        processedRows: 1,
        insertedRows: 1,
        stagedRows: 1,
      },
      'copying',
    );
    await writeFile(source.filePath, 'archive altérée');

    await expect(
      reconstructOffCatalog({
        ...baseOptions(source.filePath, source.sha256, repository),
        resume: true,
      }),
    ).rejects.toThrow('Empreinte de l’archive OFF incorrecte');
    expect(repository.sealedLookupCalls).toBe(1);
    expect(repository.beginCalls).toBe(0);
  });
});

describe('secret PostgreSQL OFF', () => {
  it('ne lit que le secret dédié et refuse une base Core', async () => {
    await expect(
      loadOffCatalogDatabaseUrl('.', {
        OFF_CATALOG_DATABASE_URL: 'postgresql://importer:secret@localhost/notons_off_catalog',
        DATABASE_URL: 'postgresql://core:secret@localhost/postgres',
      }),
    ).resolves.toContain('/notons_off_catalog');
    await expect(
      loadOffCatalogDatabaseUrl('.', {
        OFF_CATALOG_DATABASE_URL: 'postgresql://core:secret@localhost/postgres',
      }),
    ).rejects.toThrow('refuse toute base autre que notons_off_catalog');
  });

  it('valide aussi le secret administratif sans accepter le secret générique', async () => {
    await expect(
      loadOffCatalogAdminDatabaseUrl('.', {
        OFF_CATALOG_ADMIN_DATABASE_URL: 'postgresql://admin:secret@localhost/notons_off_catalog',
        DATABASE_URL: 'postgresql://core:secret@localhost/postgres',
      }),
    ).resolves.toContain('/notons_off_catalog');
    await expect(
      loadOffCatalogAdminDatabaseUrl('.', {
        DATABASE_URL: 'postgresql://core:secret@localhost/postgres',
      }),
    ).resolves.toBeNull();
  });
});

describe('frontière de code de la reconstruction', () => {
  it('remet tous les rôles OFF à NOLOGIN avant leur provisionnement externe', async () => {
    const initializer = await readFile(new URL('../src/off-init-cli.ts', import.meta.url), 'utf8');

    for (const role of ['off_catalog_owner', 'off_catalog_importer', 'off_catalog_reader']) {
      expect(initializer).toMatch(new RegExp(`alter role ${role} nologin\\b`));
    }
    expect(initializer).toContain('off_catalog_reader_role_membership_forbidden');
    expect(initializer).toContain('from pg_catalog.pg_auth_members membership');
  });

  it('garde les CASE des gardes IF sous parenthèses pour le parseur PL/pgSQL', async () => {
    const migrations = await Promise.all(
      [
        '../../../ops/off-catalog/migrations/008_native_archive_reconstruction.sql',
        '../../../ops/off-catalog/migrations/011_sealed_reconstruction_resume.sql',
      ].map((relative) => readFile(new URL(relative, import.meta.url), 'utf8')),
    );

    for (const migration of migrations) {
      // At parenthesis level zero, PL/pgSQL can treat the CASE's first THEN as
      // the end of the surrounding IF expression and fail at function compile.
      expect(migration).not.toMatch(/\bor\s+case\s+when\b/i);
      expect(migration).toMatch(/\bor\s*\(\s*case\s+when\b/i);
    }
  });

  it('ne référence aucune table du domaine communautaire Notons', async () => {
    const files = await Promise.all(
      [
        '../src/off-reconstruction.ts',
        '../src/repository/off-postgres.ts',
        '../../../ops/off-catalog/migrations/008_native_archive_reconstruction.sql',
        '../../../ops/off-catalog/migrations/011_sealed_reconstruction_resume.sql',
      ].map((relative) => readFile(new URL(relative, import.meta.url), 'utf8')),
    );
    const combined = files.join('\n');
    for (const forbidden of [
      'public.products',
      'public.reviews',
      'public.profiles',
      'public.scans',
      'public.favorites',
      'public.product_submissions',
      'catalog_product_staging',
    ]) {
      expect(combined).not.toContain(forbidden);
    }
    expect(combined).toContain('off_catalog.products_staging');
    expect(combined).toContain('off_catalog.products_current');
  });
});

describe('manifeste public de reconstruction', () => {
  it('lie une activation exacte à l’archive et reste metadata-only', async () => {
    const source = await archive(['3017620422003\tProduit\tExemple\ten:foods']);
    const repository = new FakeOffRepository();
    const result = await reconstructOffCatalog({
      ...baseOptions(source.filePath, source.sha256, repository),
      activate: true,
    });
    const resultPath = join(temporaryDirectories.at(-1)!, 'result.json');
    await writeFile(resultPath, JSON.stringify({ ...result, errorSamples: undefined }));

    const manifest = await buildReconstructionManifest({
      rootDirectory: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..'),
      archivePath: source.filePath,
      sourceUrl: result.sourceUrl,
      sourcePublishedAt: result.sourcePublishedAt,
      sourceRetrievedAt: result.sourceRetrievedAt,
      immutableCodeUrl: result.immutableCodeUrl,
      codeRevision: result.codeRevision,
      resultPath,
    });

    expect(manifest).toMatchObject({
      formatVersion: 2,
      containsDatabaseRows: false,
      containsNotonsData: false,
      upstream: { archiveSha256: source.sha256 },
      output: { status: 'active', stagedRows: 1 },
    });
    expect(JSON.stringify(manifest)).not.toContain('Pâte à tartiner');
    expect(manifest.transformation.files.length).toBeGreaterThan(10);
    expect(manifest.transformation.files).toContainEqual({
      path: 'ops/off-catalog/migrations/014_off_allergens.sql',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(manifest.transformation.files).toContainEqual({
      path: 'packages/catalog-import/src/verified-archive-snapshot.ts',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
