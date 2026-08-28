import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const normativeFiles = [
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
];

const excludedDomains = [
  'accounts',
  'profiles',
  'reviews',
  'ratings',
  'favorites',
  'scans',
  'moderation',
  'submissions',
  'private photos',
];

const fail = (message) => {
  throw new Error(`Manifeste refusé : ${message}`);
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} invalide`);
  return value;
};
const exactKeys = (value, keys, label) => {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`champs ${label} inattendus`);
};
const integer = (value, minimum, label) => {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} invalide`);
};
const regularFile = async (filename, label) => {
  const stats = await lstat(filename).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) fail(`${label} absent ou non sûr`);
  return stats;
};
const fileSha256 = async (filename) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
};
const git = (arguments_) => {
  try {
    return execFileSync('git', arguments_, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    fail('le dépôt Git public ne peut pas être vérifié');
  }
};
const gitBytes = (arguments_) => {
  try {
    return execFileSync('git', arguments_, {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 3 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    fail('le blob Git public ne peut pas être vérifié');
  }
};

const parseArguments = () => {
  const values = process.argv.slice(2);
  const manifest = values.shift();
  if (!manifest) fail('chemin du manifeste obligatoire');
  let archive;
  let revision;
  while (values.length > 0) {
    const option = values.shift();
    const value = values.shift();
    if (!value) fail(`valeur manquante pour ${option}`);
    if (option === '--archive') archive = value;
    else if (option === '--revision') revision = value;
    else fail(`option inconnue ${option}`);
  }
  return { manifest, archive, revision };
};

const argumentsInput = parseArguments();
const manifestPath = path.resolve(process.cwd(), argumentsInput.manifest);
await regularFile(manifestPath, 'manifeste');
const manifest = object(JSON.parse(await readFile(manifestPath, 'utf8')), 'racine');

const schemaPath = path.join(root, 'schemas', 'reconstruction-manifest.schema.json');
await regularFile(schemaPath, 'schéma JSON');
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
  fail('le schéma JSON 2020-12 est absent');
}
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
if (!validateSchema(manifest)) {
  const details = (validateSchema.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalide'}`)
    .join('; ');
  fail(`schéma JSON invalide : ${details}`);
}

exactKeys(
  manifest,
  [
    'formatVersion',
    'documentKind',
    'containsDatabaseRows',
    'containsNotonsData',
    'databaseLicense',
    'contentsLicense',
    'imageLicense',
    'upstream',
    'transformation',
    'output',
    'notices',
  ],
  'racine',
);
if (
  manifest.formatVersion !== 2 ||
  manifest.documentKind !== 'odbl-4.6b-reconstruction-method' ||
  manifest.containsDatabaseRows !== false ||
  manifest.containsNotonsData !== false ||
  manifest.databaseLicense !== 'ODbL-1.0' ||
  manifest.contentsLicense !== 'DbCL-1.0' ||
  manifest.imageLicense !== 'CC-BY-SA-3.0'
) {
  fail('contrat ou licences invalides');
}

const upstream = object(manifest.upstream, 'upstream');
exactKeys(
  upstream,
  [
    'name',
    'sourceUrl',
    'sourcePublishedAt',
    'sourceRetrievedAt',
    'archiveFilename',
    'archiveBytes',
    'archiveSha256',
  ],
  'upstream',
);
let sourceUrl;
try {
  sourceUrl = new URL(upstream.sourceUrl);
} catch {
  fail('URL source OFF invalide');
}
if (
  upstream.name !== 'Open Food Facts' ||
  sourceUrl.protocol !== 'https:' ||
  sourceUrl.username ||
  sourceUrl.password ||
  sourceUrl.search ||
  sourceUrl.hash ||
  sourceUrl.pathname === '/' ||
  !['static.openfoodfacts.org', 'world.openfoodfacts.org'].includes(sourceUrl.hostname)
) {
  fail('source OFF non officielle');
}
if (
  !timestampPattern.test(upstream.sourcePublishedAt) ||
  !timestampPattern.test(upstream.sourceRetrievedAt) ||
  !Number.isFinite(Date.parse(upstream.sourcePublishedAt)) ||
  !Number.isFinite(Date.parse(upstream.sourceRetrievedAt)) ||
  new Date(Date.parse(upstream.sourcePublishedAt)).toISOString().replace('.000Z', 'Z') !==
    upstream.sourcePublishedAt ||
  new Date(Date.parse(upstream.sourceRetrievedAt)).toISOString().replace('.000Z', 'Z') !==
    upstream.sourceRetrievedAt ||
  Date.parse(upstream.sourceRetrievedAt) < Date.parse(upstream.sourcePublishedAt)
) {
  fail('chronologie source UTC invalide');
}
if (
  typeof upstream.archiveFilename !== 'string' ||
  !upstream.archiveFilename ||
  /[/\\]/.test(upstream.archiveFilename) ||
  !/\.tsv\.gz$/.test(upstream.archiveFilename) ||
  path.basename(upstream.archiveFilename) !== upstream.archiveFilename
) {
  fail("nom d'archive invalide");
}
integer(upstream.archiveBytes, 1, "taille d'archive");
if (!sha256Pattern.test(upstream.archiveSha256)) fail("SHA-256 d'archive invalide");

const transformation = object(manifest.transformation, 'transformation');
exactKeys(
  transformation,
  [
    'immutableCodeUrl',
    'revision',
    'methodDocument',
    'entrypoint',
    'files',
    'fullSnapshotArguments',
  ],
  'transformation',
);
if (!shaPattern.test(transformation.revision)) fail('révision du code invalide');
const expectedCodeUrl = `https://github.com/ElPape77/notons-off-reconstruction/tree/${transformation.revision}`;
if (transformation.immutableCodeUrl !== expectedCodeUrl) fail('URL du code non immuable');

const repositoryRoot = realpathSync.native(path.resolve(git(['rev-parse', '--show-toplevel'])));
const canonicalRoot = realpathSync.native(root);
const sameRepository =
  process.platform === 'win32'
    ? repositoryRoot.toLocaleLowerCase('en') === canonicalRoot.toLocaleLowerCase('en')
    : repositoryRoot === canonicalRoot;
if (!sameRepository) {
  fail('la vérification doit être exécutée dans le dépôt public canonique');
}
const headRevision = git(['rev-parse', 'HEAD']);
if (
  !shaPattern.test(headRevision) ||
  transformation.revision !== headRevision ||
  (argumentsInput.revision && argumentsInput.revision !== headRevision) ||
  (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== headRevision)
) {
  fail('la révision du manifeste ne correspond pas au commit ciblé');
}
if (git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) {
  fail('le dépôt public contient des fichiers non validés dans Git');
}
if (
  transformation.methodDocument !== 'docs/open-food-facts-reconstruction-method.md' ||
  transformation.entrypoint !== 'npm run catalog:off-reconstruct --'
) {
  fail('point d’entrée ou méthode inattendu');
}

const migrationsDirectory = path.join(root, 'ops', 'off-catalog', 'migrations');
const migrationNames = (await readdir(migrationsDirectory))
  .filter((filename) => filename.endsWith('.sql'))
  .sort();
if (
  migrationNames.length !== 14 ||
  migrationNames.some(
    (filename, index) =>
      !/^\d{3}_[a-z0-9_-]+\.sql$/.test(filename) || Number(filename.slice(0, 3)) !== index + 1,
  )
) {
  fail('séquence des migrations 001 à 014 incomplète');
}
const expectedFiles = [
  ...normativeFiles,
  ...migrationNames.map((filename) => `ops/off-catalog/migrations/${filename}`),
  'package-lock.json',
].sort();
if (!Array.isArray(transformation.files)) fail('inventaire des fichiers invalide');
const actualPaths = transformation.files.map((entry) => object(entry, 'fichier').path);
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedFiles)) {
  fail('inventaire normatif non trié, incomplet ou inattendu');
}
for (const entry of transformation.files) {
  const treeEntry = git(['ls-tree', 'HEAD', '--', entry.path]);
  if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(treeEntry)) {
    fail(`source absente du commit Git : ${entry.path}`);
  }
  exactKeys(entry, ['path', 'sha256'], `fichier ${entry.path}`);
  if (!sha256Pattern.test(entry.sha256)) fail(`SHA-256 invalide pour ${entry.path}`);
  const absolute = path.resolve(root, entry.path);
  if (!absolute.startsWith(`${root}${path.sep}`)) fail(`chemin sortant : ${entry.path}`);
  await regularFile(absolute, `source ${entry.path}`);
  const workingBytes = await readFile(absolute);
  if (!workingBytes.equals(gitBytes(['cat-file', 'blob', `HEAD:${entry.path}`]))) {
    fail(`source différente du blob Git HEAD : ${entry.path}`);
  }
  if ((await fileSha256(absolute)) !== entry.sha256) fail(`source modifiée : ${entry.path}`);
}

const expectedArguments = [
  '--file',
  '<verified-official-archive>',
  '--source-sha256',
  upstream.archiveSha256,
  '--source-url',
  upstream.sourceUrl,
  '--source-published-at',
  upstream.sourcePublishedAt,
  '--source-retrieved-at',
  upstream.sourceRetrievedAt,
  '--code-url',
  transformation.immutableCodeUrl,
  '--code-revision',
  transformation.revision,
  '--batch-size',
  '500',
  '--activation-batch-size',
  '100000',
  '--activate',
  '--result',
  '<metadata-only-result.json>',
];
if (JSON.stringify(transformation.fullSnapshotArguments) !== JSON.stringify(expectedArguments)) {
  fail('arguments de snapshot complet incohérents');
}

const output = object(manifest.output, 'output');
exactKeys(
  output,
  [
    'database',
    'schema',
    'runtimeRelation',
    'status',
    'processedRows',
    'rejectedRows',
    'filteredRows',
    'stagedRows',
    'projectionFingerprint',
    'importerVersion',
    'projectionVersion',
    'contractVersion',
    'excludedDomains',
  ],
  'output',
);
if (
  output.database !== 'notons_off_catalog' ||
  output.schema !== 'off_catalog' ||
  output.runtimeRelation !== 'off_catalog.products_published' ||
  !['active', 'already-active'].includes(output.status) ||
  output.contractVersion !== 'notons-off-reconstruction/1' ||
  typeof output.importerVersion !== 'string' ||
  !output.importerVersion ||
  typeof output.projectionVersion !== 'string' ||
  !output.projectionVersion ||
  JSON.stringify(output.excludedDomains) !== JSON.stringify(excludedDomains)
) {
  fail('contrat de sortie invalide');
}
integer(output.processedRows, 1, 'processedRows');
integer(output.rejectedRows, 0, 'rejectedRows');
integer(output.filteredRows, 0, 'filteredRows');
integer(output.stagedRows, 1, 'stagedRows');
if (
  output.filteredRows !== 0 ||
  output.processedRows < output.rejectedRows ||
  output.stagedRows > output.processedRows - output.rejectedRows
) {
  fail('compteurs incompatibles avec un snapshot complet');
}
if (!/^\d+\|-?\d+\|-?\d+$/.test(output.projectionFingerprint)) {
  fail('empreinte de projection invalide');
}
if (Number(output.projectionFingerprint.split('|', 1)[0]) !== output.stagedRows) {
  fail("l'empreinte ne correspond pas au nombre de lignes projetées");
}

const notices = object(manifest.notices, 'notices');
exactKeys(notices, ['database', 'noPublicDump', 'compliancePath'], 'notices');
if (
  notices.database !==
    'Contains information from Open Food Facts, made available under ODbL 1.0.' ||
  notices.noPublicDump !== true ||
  notices.compliancePath !== 'ODbL 1.0 section 4.6(b): complete method of alterations'
) {
  fail('notice de licence invalide');
}

if (argumentsInput.archive) {
  const archivePath = path.resolve(process.cwd(), argumentsInput.archive);
  const stats = await regularFile(archivePath, 'archive source');
  if (
    path.basename(archivePath) !== upstream.archiveFilename ||
    stats.size !== upstream.archiveBytes ||
    (await fileSha256(archivePath)) !== upstream.archiveSha256
  ) {
    fail('archive locale différente de la source manifestée');
  }
}

console.log(
  `Manifeste vérifié : ${transformation.revision}, ${transformation.files.length} sources, aucune ligne publiée.`,
);
