import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slash = (value) => value.split(path.sep).join('/');

const rootFiles = new Set([
  '.gitattributes',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
  'DATA-LICENSE.md',
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'RELEASING.md',
  'SECURITY.md',
  'package-lock.json',
  'package.json',
  'tsconfig.base.json',
]);

const exactFiles = new Set([
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/codeql.yml',
  'docs/open-food-facts-reconstruction-method.md',
  'packages/catalog-import/README.md',
  'packages/catalog-import/package.json',
  'packages/catalog-import/src/catalog-scope.ts',
  'packages/catalog-import/src/cli.ts',
  'packages/catalog-import/src/errors.ts',
  'packages/catalog-import/src/git-provenance.ts',
  'packages/catalog-import/src/importer.ts',
  'packages/catalog-import/src/index.ts',
  'packages/catalog-import/src/manifest-cli.ts',
  'packages/catalog-import/src/migration-ledger.ts',
  'packages/catalog-import/src/mappers/columns.ts',
  'packages/catalog-import/src/mappers/open-food-facts.ts',
  'packages/catalog-import/src/off-cli.ts',
  'packages/catalog-import/src/off-database-url.ts',
  'packages/catalog-import/src/off-init-cli.ts',
  'packages/catalog-import/src/off-reconstruction.ts',
  'packages/catalog-import/src/process-signals.ts',
  'packages/catalog-import/src/reconstruction-manifest.ts',
  'packages/catalog-import/src/repository/memory.ts',
  'packages/catalog-import/src/repository/off-postgres.ts',
  'packages/catalog-import/src/source.ts',
  'packages/catalog-import/src/types.ts',
  'packages/catalog-import/src/verified-archive-snapshot.ts',
  'packages/catalog-import/test/catalog-scope.test.ts',
  'packages/catalog-import/test/git-provenance.test.ts',
  'packages/catalog-import/test/importer.test.ts',
  'packages/catalog-import/test/mappers.test.ts',
  'packages/catalog-import/test/migration-ledger.test.ts',
  'packages/catalog-import/test/off-postgres-repository.test.ts',
  'packages/catalog-import/test/off-reconstruction.test.ts',
  'packages/catalog-import/test/process-signals.test.ts',
  'packages/catalog-import/test/source.test.ts',
  'packages/catalog-import/test/verified-archive-snapshot.test.ts',
  'packages/catalog-import/tsconfig.json',
  'packages/catalog-import/vitest.config.ts',
  'packages/shared/package.json',
  'packages/shared/src/catalog-types.ts',
  'packages/shared/src/gtin.ts',
  'packages/shared/src/index.ts',
  'packages/shared/test/gtin.test.ts',
  'packages/shared/tsconfig.json',
  'packages/shared/vitest.config.ts',
  'schemas/reconstruction-manifest.schema.json',
  'scripts/check-public-boundary.mjs',
  'scripts/run-off-catalog-smokes.mjs',
  'scripts/run-off-reconstruction-e2e.mjs',
  'scripts/verify-reconstruction-manifest.mjs',
]);

const allowed = (filename) =>
  rootFiles.has(filename) ||
  exactFiles.has(filename) ||
  /^ops\/off-catalog\/migrations\/\d{3}_[a-z0-9_-]+\.sql$/.test(filename) ||
  /^ops\/off-catalog\/tests\/\d{3}_[a-z0-9_.-]+\.sql$/.test(filename);

const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);

const walk = (directory, prefix = '') => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
};

const trackedFiles = () => {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (output) return output.split('\0').filter(Boolean).map(slash).sort();
  } catch {
    // A fresh export intentionally has no Git history yet.
  }
  return walk(root).map(slash).sort();
};

const files = trackedFiles();
const errors = [];
for (const required of [...rootFiles, ...exactFiles]) {
  if (!files.includes(required)) errors.push(`fichier public obligatoire absent : ${required}`);
}
const forbiddenPath =
  /(?:^|\/)(?:data|supabase|apps|legal|backups?|dumps?|private|secrets?)(?:\/|$)|\.(?:dump|backup|bak|csv|tsv|gz|parquet|sqlite3?)$/i;
const privatePath = /(?:[a-z]:\\Users\\|[a-z]:\\DEV-VSCODE\\|\/home\/[^/\s]+\/)/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsbp_[A-Za-z0-9]{30,}\b/,
  /\bsk_(?:live|prod)_[A-Za-z0-9]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];
const allowedCredentialUris = new Set([
  'postgresql://admin:secret@localhost/notons_off_catalog',
  'postgresql://core:secret@localhost/postgres',
  'postgresql://importer:secret@localhost/notons_off_catalog',
  'postgresql://postgres:postgres@127.0.0.1:5432/notons_off_catalog',
]);

for (const filename of files) {
  if (!allowed(filename)) errors.push(`fichier hors liste publique : ${filename}`);
  if (forbiddenPath.test(filename))
    errors.push(`format ou chemin de données interdit : ${filename}`);

  const absolute = path.resolve(root, filename);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    errors.push(`chemin sortant du dépôt : ${filename}`);
    continue;
  }
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    errors.push(`fichier non régulier ou lien symbolique : ${filename}`);
    continue;
  }
  if (stats.size > 2 * 1024 * 1024) {
    errors.push(`fichier public supérieur à 2 Mio : ${filename}`);
    continue;
  }

  const contents = readFileSync(absolute, 'utf8');
  if (privatePath.test(contents)) errors.push(`chemin local privé détecté : ${filename}`);
  for (const match of contents.matchAll(/\bpostgres(?:ql)?:\/\/[^'"\s)]+/gi)) {
    if (match[0].includes('@') && !allowedCredentialUris.has(match[0])) {
      errors.push(`URI PostgreSQL avec identifiants détectée : ${filename}`);
    }
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(contents)) errors.push(`secret potentiel détecté : ${filename}`);
  }
}

const migrationNames = files
  .filter((filename) => filename.startsWith('ops/off-catalog/migrations/'))
  .map((filename) => path.posix.basename(filename));
const expectedMigrations = [
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
  '013_off_ingredients_text.sql',
  '014_off_allergens.sql',
];
if (JSON.stringify(migrationNames) !== JSON.stringify(expectedMigrations)) {
  errors.push('inventaire des migrations OFF incomplet, non ordonné ou ambigu');
}

const ledgerSmoke = readFileSync(
  path.join(root, 'ops/off-catalog/tests/009_attested_migration_ledger_smoke.sql'),
  'utf8',
);
const ledgerFixture = ledgerSmoke.match(
  /v_filenames text\[\] := array\[([\s\S]*?)\];\s*v_sha256 text\[\] := array\[([\s\S]*?)\];/,
);
const quotedValues = (value) => [...value.matchAll(/'([^']*)'/g)].map((match) => match[1]);
const expectedMigrationSha256 = expectedMigrations.map((filename) =>
  createHash('sha256')
    .update(readFileSync(path.join(root, 'ops/off-catalog/migrations', filename)))
    .digest('hex'),
);
if (
  !ledgerFixture ||
  JSON.stringify(quotedValues(ledgerFixture[1])) !== JSON.stringify(expectedMigrations) ||
  JSON.stringify(quotedValues(ledgerFixture[2])) !== JSON.stringify(expectedMigrationSha256)
) {
  errors.push('fixture d’attestation PostgreSQL désynchronisée des migrations OFF');
}

const testNames = files
  .filter((filename) => filename.startsWith('ops/off-catalog/tests/'))
  .map((filename) => path.posix.basename(filename));
const expectedTests = [
  '001_catalog_separation.test.sql',
  '002_resumable_activation_smoke.sql',
  '003_verified_staging_seal_smoke.sql',
  '004_indexable_published_view_smoke.sql',
  '005_reader_runtime_hardening_smoke.sql',
  '006_indexed_ranking_categories_smoke.sql',
  '007_sealed_reconstruction_resume_smoke.sql',
  '008_native_activation_wrappers_smoke.sql',
  '009_attested_migration_ledger_smoke.sql',
  '010_off_allergens_projection_smoke.sql',
];
if (JSON.stringify(testNames) !== JSON.stringify(expectedTests)) {
  errors.push('inventaire des tests PostgreSQL OFF incomplet, non ordonné ou ambigu');
}

if (errors.length > 0) {
  throw new Error(`Frontière publique refusée :\n- ${[...new Set(errors)].join('\n- ')}`);
}

console.log(
  `Frontière publique validée : ${files.length} fichiers, aucune donnée ni secret détecté.`,
);
