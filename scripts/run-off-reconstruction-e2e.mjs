import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.OFF_CATALOG_ADMIN_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('OFF_CATALOG_ADMIN_DATABASE_URL is required.');

const revision = (
  process.env.GITHUB_SHA ??
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
).trim();
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
  throw new Error('An immutable Git revision is required for the reconstruction fixture.');
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notons-off-e2e-'));
const archivePath = path.join(temporaryDirectory, 'ci-off-fixture.tsv.gz');
const resultPath = path.join(temporaryDirectory, 'reconstruction-result.json');
const manifestPath = path.join(temporaryDirectory, 'reconstruction-manifest.json');
const sourceUrl = 'https://static.openfoodfacts.org/data/ci-off-fixture.tsv.gz';
const sourcePublishedAt = '2026-08-14T00:00:00Z';
const sourceRetrievedAt = '2026-08-14T00:01:00Z';
const codeUrl = `https://github.com/ElPape77/notons-off-reconstruction/tree/${revision}`;

const run = (command, args, environment = process.env) =>
  execFileSync(command, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });

try {
  const tsv = [
    'code\tproduct_name_fr\tbrands\tcategories_tags\tnutriscore_grade\tenergy-kcal_100g',
    '2000000000015\tProduit synthétique cacao\tFixture\ten:sweet-spreads\td\t539',
    '2000000000022\tProduit synthétique salé\tFixture\ten:salty-snacks\tc\t412',
  ].join('\n');
  const archive = gzipSync(`${tsv}\n`, { level: 9, mtime: 0 });
  await writeFile(archivePath, archive, { mode: 0o600 });
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const reconstructionEnvironment = {
    ...process.env,
    OFF_CATALOG_DATABASE_URL: databaseUrl,
  };

  run(
    npm,
    [
      'run',
      'catalog:off-reconstruct',
      '--',
      '--file',
      archivePath,
      '--source-sha256',
      archiveSha256,
      '--source-url',
      sourceUrl,
      '--source-published-at',
      sourcePublishedAt,
      '--source-retrieved-at',
      sourceRetrievedAt,
      '--code-url',
      codeUrl,
      '--code-revision',
      revision,
      '--batch-size',
      '1',
      '--activation-batch-size',
      '1',
      '--activate',
      '--result',
      resultPath,
    ],
    reconstructionEnvironment,
  );

  run(npm, [
    'run',
    'catalog:off-manifest',
    '--',
    '--archive',
    archivePath,
    '--source-url',
    sourceUrl,
    '--source-published-at',
    sourcePublishedAt,
    '--source-retrieved-at',
    sourceRetrievedAt,
    '--code-url',
    codeUrl,
    '--code-revision',
    revision,
    '--result',
    resultPath,
    '--output',
    manifestPath,
  ]);

  run(process.execPath, [
    path.join(root, 'scripts', 'verify-reconstruction-manifest.mjs'),
    manifestPath,
    '--archive',
    archivePath,
    '--revision',
    revision,
  ]);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      'select count(*)::integer as count from off_catalog.products_published',
    );
    if (result.rows[0]?.count !== 2) {
      throw new Error(`Unexpected published fixture row count: ${result.rows[0]?.count}`);
    }
  } finally {
    await client.end();
  }

  console.log('End-to-end OFF reconstruction passed with 2 metadata-only fixture products.');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
