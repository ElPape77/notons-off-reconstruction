import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { lstat, readdir, readFile } from 'node:fs/promises';

import type { OffReconstructionResult } from './off-reconstruction.js';

export interface ReconstructionManifestInput {
  rootDirectory: string;
  archivePath: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  sourceRetrievedAt: string;
  immutableCodeUrl: string;
  codeRevision: string;
  resultPath: string;
}

export const OFF_RECONSTRUCTION_TRANSFORMATION_FILES = Object.freeze([
  'packages/catalog-import/src/catalog-scope.ts',
  'packages/catalog-import/src/errors.ts',
  'packages/catalog-import/src/git-provenance.ts',
  'packages/catalog-import/src/importer.ts',
  'packages/catalog-import/src/manifest-cli.ts',
  'packages/catalog-import/src/migration-ledger.ts',
  'packages/catalog-import/src/off-cli.ts',
  'packages/catalog-import/src/off-database-url.ts',
  'packages/catalog-import/src/off-init-cli.ts',
  'packages/catalog-import/src/off-reconstruction.ts',
  'packages/catalog-import/src/process-signals.ts',
  'packages/catalog-import/src/reconstruction-manifest.ts',
  'packages/catalog-import/src/repository/off-postgres.ts',
  'packages/catalog-import/src/source.ts',
  'packages/catalog-import/src/types.ts',
  'packages/catalog-import/src/verified-archive-snapshot.ts',
  'packages/catalog-import/src/mappers/open-food-facts.ts',
  'packages/catalog-import/package.json',
  'packages/catalog-import/tsconfig.json',
  'packages/shared/package.json',
  'packages/shared/tsconfig.json',
  'packages/shared/src/catalog-types.ts',
  'packages/shared/src/gtin.ts',
  'packages/shared/src/index.ts',
  'package.json',
  'tsconfig.base.json',
  'docs/open-food-facts-reconstruction-method.md',
] as const);

export const OFF_RECONSTRUCTION_MIGRATION_FILES = Object.freeze([
  '001_catalog_foundation.sql',
  '002_runtime_indexes.sql',
  '003_reader_search_privilege.sql',
  '004_resumable_initial_activation.sql',
  '005_verified_staging_seal.sql',
  '006_runtime_query_indexes.sql',
  '007_indexable_published_view.sql',
  '008_native_archive_reconstruction.sql',
  '009_reader_runtime_hardening.sql',
  '010_indexed_ranking_categories.sql',
  '011_sealed_reconstruction_resume.sql',
  '012_attested_migration_ledger.sql',
] as const);

export const OFF_RECONSTRUCTION_TRACKED_FILES = Object.freeze(
  [
    ...OFF_RECONSTRUCTION_TRANSFORMATION_FILES,
    ...OFF_RECONSTRUCTION_MIGRATION_FILES.map(
      (filename) => `ops/off-catalog/migrations/${filename}`,
    ),
    'package-lock.json',
  ].sort(),
);

const sha256 = (contents: Buffer | string): string =>
  createHash('sha256').update(contents).digest('hex');

const assertRegularFile = async (filename: string, label: string) => {
  const stats = await lstat(filename);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} absent ou non sûr.`);
  return stats;
};

const fileSha256 = async (filename: string): Promise<string> => {
  await assertRegularFile(filename, 'Fichier normatif');
  return sha256(await readFile(filename));
};

const officialUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname !== '/' &&
      ['static.openfoodfacts.org', 'world.openfoodfacts.org'].includes(parsed.hostname)
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

const containsExactRevision = (value: string, revision: string): boolean =>
  new RegExp(`(?:^|[^0-9a-f])${revision}(?:[^0-9a-f]|$)`, 'i').test(value);

const immutableCodeUrl = (value: string, revision: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === 'https://github.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === `/ElPape77/notons-off-reconstruction/tree/${revision}` &&
      containsExactRevision(parsed.href, revision)
    );
  } catch {
    return false;
  }
};

export async function buildReconstructionManifest(input: ReconstructionManifestInput) {
  if (!officialUrl(input.sourceUrl)) throw new Error('URL source OFF officielle invalide.');
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(input.codeRevision)) {
    throw new Error('Révision immuable invalide.');
  }
  if (!immutableCodeUrl(input.immutableCodeUrl, input.codeRevision)) {
    throw new Error('L’URL HTTPS du code doit contenir la révision immuable exacte.');
  }
  if (!utcTimestamp(input.sourcePublishedAt) || !utcTimestamp(input.sourceRetrievedAt)) {
    throw new Error('Dates source UTC invalides.');
  }
  if (Date.parse(input.sourceRetrievedAt) < Date.parse(input.sourcePublishedAt)) {
    throw new Error('La récupération de la source précède sa publication.');
  }
  const root = resolve(input.rootDirectory);
  const archivePath = resolve(input.archivePath);
  if (!/\.tsv\.gz$/.test(basename(archivePath))) {
    throw new Error('Le manifeste exige une archive locale OFF .tsv.gz.');
  }
  const archiveStats = await assertRegularFile(archivePath, 'Archive OFF');
  await assertRegularFile(resolve(input.resultPath), 'Résultat de reconstruction');
  const archiveSha256 = await fileSha256(archivePath);
  const result = JSON.parse(
    await readFile(resolve(input.resultPath), 'utf8'),
  ) as OffReconstructionResult;
  const expected = {
    archiveFilename: basename(archivePath),
    archiveSha256,
    sourceUrl: input.sourceUrl,
    sourcePublishedAt: input.sourcePublishedAt,
    sourceRetrievedAt: input.sourceRetrievedAt,
    immutableCodeUrl: input.immutableCodeUrl,
    codeRevision: input.codeRevision,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (result[key as keyof OffReconstructionResult] !== value) {
      throw new Error(`Résultat de reconstruction incohérent : ${key}.`);
    }
  }
  if (
    result.formatVersion !== 1 ||
    result.documentKind !== 'notons-off-reconstruction-result' ||
    !['active', 'already-active'].includes(result.status) ||
    result.contractVersion !== 'notons-off-reconstruction/1' ||
    typeof result.importerVersion !== 'string' ||
    !result.importerVersion ||
    typeof result.projectionVersion !== 'string' ||
    !result.projectionVersion ||
    !Number.isSafeInteger(result.processedRows) ||
    !Number.isSafeInteger(result.rejectedRows) ||
    !Number.isSafeInteger(result.filteredRows) ||
    !Number.isSafeInteger(result.stagedRows) ||
    result.processedRows < 1 ||
    result.rejectedRows < 0 ||
    result.filteredRows !== 0 ||
    result.stagedRows < 1 ||
    result.processedRows < result.rejectedRows + result.filteredRows ||
    result.stagedRows > result.processedRows - result.rejectedRows - result.filteredRows ||
    !/^\d+\|-?\d+\|-?\d+$/.test(result.sourceFingerprint) ||
    Number(result.sourceFingerprint.split('|', 1)[0]) !== result.stagedRows
  ) {
    throw new Error('Le résultat ne prouve pas une reconstruction OFF activée.');
  }

  const migrationDirectory = resolve(root, 'ops/off-catalog/migrations');
  const migrationDirectoryStats = await lstat(migrationDirectory);
  if (!migrationDirectoryStats.isDirectory() || migrationDirectoryStats.isSymbolicLink()) {
    throw new Error('Le répertoire des migrations OFF est absent ou non sûr.');
  }
  const sqlNames = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  if (sqlNames.some((filename) => !/^\d{3}_[a-z0-9_-]+\.sql$/.test(filename))) {
    throw new Error('Le répertoire contient un nom de migration OFF non sûr.');
  }
  const migrationNames = sqlNames;
  if (migrationNames.length < 1) throw new Error('Aucune migration OFF normative trouvée.');
  const migrationNumbers = migrationNames.map((filename) => Number(filename.slice(0, 3)));
  if (
    new Set(migrationNumbers).size !== migrationNumbers.length ||
    migrationNumbers.some((number, index) => number !== index + 1)
  ) {
    throw new Error('La séquence des migrations OFF est incomplète ou ambiguë.');
  }
  if (JSON.stringify(migrationNames) !== JSON.stringify(OFF_RECONSTRUCTION_MIGRATION_FILES)) {
    throw new Error(
      'L’inventaire des migrations OFF ne correspond pas à cette version du contrat.',
    );
  }
  const transformationPaths = OFF_RECONSTRUCTION_TRACKED_FILES;
  const files = await Promise.all(
    transformationPaths.map(async (path) => ({
      path,
      sha256: await fileSha256(resolve(root, path)),
    })),
  );

  return {
    formatVersion: 2,
    documentKind: 'odbl-4.6b-reconstruction-method',
    containsDatabaseRows: false,
    containsNotonsData: false,
    databaseLicense: 'ODbL-1.0',
    contentsLicense: 'DbCL-1.0',
    imageLicense: 'CC-BY-SA-3.0',
    upstream: {
      name: 'Open Food Facts',
      sourceUrl: input.sourceUrl,
      sourcePublishedAt: input.sourcePublishedAt,
      sourceRetrievedAt: input.sourceRetrievedAt,
      archiveFilename: basename(archivePath),
      archiveBytes: archiveStats.size,
      archiveSha256,
    },
    transformation: {
      immutableCodeUrl: input.immutableCodeUrl,
      revision: input.codeRevision,
      methodDocument: 'docs/open-food-facts-reconstruction-method.md',
      entrypoint: 'npm run catalog:off-reconstruct --',
      files,
      fullSnapshotArguments: [
        '--file',
        '<verified-official-archive>',
        '--source-sha256',
        archiveSha256,
        '--source-url',
        input.sourceUrl,
        '--source-published-at',
        input.sourcePublishedAt,
        '--source-retrieved-at',
        input.sourceRetrievedAt,
        '--code-url',
        input.immutableCodeUrl,
        '--code-revision',
        input.codeRevision,
        '--batch-size',
        '500',
        '--activation-batch-size',
        '100000',
        '--activate',
        '--result',
        '<metadata-only-result.json>',
      ],
    },
    output: {
      database: 'notons_off_catalog',
      schema: 'off_catalog',
      runtimeRelation: 'off_catalog.products_published',
      status: result.status,
      processedRows: result.processedRows,
      rejectedRows: result.rejectedRows,
      filteredRows: result.filteredRows,
      stagedRows: result.stagedRows,
      projectionFingerprint: result.sourceFingerprint,
      importerVersion: result.importerVersion,
      projectionVersion: result.projectionVersion,
      contractVersion: result.contractVersion,
      excludedDomains: [
        'accounts',
        'profiles',
        'reviews',
        'ratings',
        'favorites',
        'scans',
        'moderation',
        'submissions',
        'private photos',
      ],
    },
    notices: {
      database: 'Contains information from Open Food Facts, made available under ODbL 1.0.',
      noPublicDump: true,
      compliancePath: 'ODbL 1.0 section 4.6(b): complete method of alterations',
    },
  } as const;
}
