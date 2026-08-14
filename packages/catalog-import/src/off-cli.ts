#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { assertPublicRepositoryRevision } from './git-provenance.js';
import { loadOffCatalogDatabaseUrl } from './off-database-url.js';
import { loadExpectedOffMigrationLedger } from './migration-ledger.js';
import { OFF_RECONSTRUCTION_TRACKED_FILES } from './reconstruction-manifest.js';
import {
  reconstructOffCatalog,
  type OffReconstructionProgress,
  type OffReconstructionResult,
} from './off-reconstruction.js';
import { attachImportAbortSignals } from './process-signals.js';
import { OffCatalogPostgresRepository } from './repository/off-postgres.js';

interface CliOptions {
  file: string;
  sourceSha256: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  sourceRetrievedAt: string;
  codeUrl: string;
  codeRevision: string;
  batchSize: string;
  activationBatchSize: string;
  resume?: boolean;
  activate?: boolean;
  result?: string;
}

const loadLocalEnvironment = (invocationDirectory: string): void => {
  try {
    loadEnvFile(resolve(invocationDirectory, '.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const renderProgress = (progress: OffReconstructionProgress): void => {
  const label = progress.phase === 'projection' ? 'projection' : 'activation';
  process.stderr.write(
    `[${label}] source=${progress.processedRows} rejetés=${progress.rejectedRows} ` +
      `staging=${progress.stagedRows} activés=${progress.activatedRows}\n`,
  );
};

const publicResult = (
  result: OffReconstructionResult,
): Omit<OffReconstructionResult, 'errorSamples'> => {
  const { errorSamples: _privateErrorSamples, ...metadataOnly } = result;
  return metadataOnly;
};

const writeResult = async (filename: string, result: OffReconstructionResult): Promise<void> => {
  const destination = resolve(process.env.INIT_CWD ?? process.cwd(), filename);
  const temporary = `${destination}.tmp.${process.pid}`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(publicResult(result), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  await rename(temporary, destination);
};

async function run(options: CliOptions): Promise<void> {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
  assertPublicRepositoryRevision(
    repositoryRoot,
    options.codeRevision,
    OFF_RECONSTRUCTION_TRACKED_FILES,
  );
  const expectedMigrationLedger = await loadExpectedOffMigrationLedger(repositoryRoot);
  loadLocalEnvironment(invocationDirectory);
  const connectionString = await loadOffCatalogDatabaseUrl(invocationDirectory);
  if (!connectionString) {
    throw new Error(
      'OFF_CATALOG_DATABASE_URL ou OFF_CATALOG_DATABASE_URL_FILE est obligatoire. DATABASE_URL n’est volontairement jamais lu.',
    );
  }

  const repository = new OffCatalogPostgresRepository(connectionString);
  const controller = new AbortController();
  const detachAbortSignals = attachImportAbortSignals(controller);
  try {
    const result = await reconstructOffCatalog({
      filePath: resolve(invocationDirectory, options.file),
      expectedSha256: options.sourceSha256,
      sourceUrl: options.sourceUrl,
      sourcePublishedAt: options.sourcePublishedAt,
      sourceRetrievedAt: options.sourceRetrievedAt,
      immutableCodeUrl: options.codeUrl,
      codeRevision: options.codeRevision,
      repository,
      expectedMigrationLedger,
      batchSize: Number(options.batchSize),
      activationBatchSize: Number(options.activationBatchSize),
      resume: options.resume,
      activate: options.activate,
      signal: controller.signal,
      onProgress: renderProgress,
    });
    if (options.result) await writeResult(options.result, result);
    // Standard output is safe to archive or feed to another tool: malformed
    // row samples remain process-local and never become a public artefact.
    process.stdout.write(`${JSON.stringify(publicResult(result), null, 2)}\n`);
  } finally {
    detachAbortSignals();
    await repository.close();
  }
}

const program = new Command()
  .name('notons-off-reconstruct')
  .description('Reconstruit la projection OFF dans la base PostgreSQL isolée, sans table Core')
  .requiredOption('--file <path>', 'Archive officielle Open Food Facts TSV compressée')
  .requiredOption('--source-sha256 <sha256>', 'SHA-256 publié dans le manifeste de génération')
  .requiredOption('--source-url <url>', 'URL HTTPS officielle exacte de l’archive')
  .requiredOption('--source-published-at <timestamp>', 'Date de publication UTC de la source')
  .requiredOption('--source-retrieved-at <timestamp>', 'Date de récupération UTC de la source')
  .requiredOption('--code-url <url>', 'URL HTTPS de la révision immuable du transformateur')
  .requiredOption(
    '--code-revision <revision>',
    'Révision immuable hexadécimale (40 ou 64 caractères)',
  )
  .option('--batch-size <rows>', 'Lignes source par checkpoint atomique (1..1000)', '500')
  .option(
    '--activation-batch-size <rows>',
    'Produits par checkpoint d’activation invisible (1..100000)',
    '100000',
  )
  .option('--resume', 'Reprend le dernier offset source confirmé')
  .option('--activate', 'Construit les index et publie atomiquement la génération')
  .option('--result <path>', 'Écrit le résultat metadata-only destiné au manifeste public')
  .showHelpAfterError()
  .action((options: CliOptions) => run(options));

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Erreur de reconstruction OFF : ${message}\n`);
  process.exitCode = 1;
});
