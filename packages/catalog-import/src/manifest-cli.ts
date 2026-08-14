#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { assertPublicRepositoryRevision } from './git-provenance.js';
import {
  buildReconstructionManifest,
  OFF_RECONSTRUCTION_TRACKED_FILES,
} from './reconstruction-manifest.js';

interface Options {
  archive: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  sourceRetrievedAt: string;
  codeUrl: string;
  codeRevision: string;
  result: string;
  output: string;
}

async function run(options: Options): Promise<void> {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const rootDirectory = fileURLToPath(new URL('../../..', import.meta.url));
  assertPublicRepositoryRevision(
    rootDirectory,
    options.codeRevision,
    OFF_RECONSTRUCTION_TRACKED_FILES,
  );
  const manifest = await buildReconstructionManifest({
    rootDirectory,
    archivePath: resolve(invocationDirectory, options.archive),
    sourceUrl: options.sourceUrl,
    sourcePublishedAt: options.sourcePublishedAt,
    sourceRetrievedAt: options.sourceRetrievedAt,
    immutableCodeUrl: options.codeUrl,
    codeRevision: options.codeRevision,
    resultPath: resolve(invocationDirectory, options.result),
  });
  const output = resolve(invocationDirectory, options.output);
  const temporary = `${output}.tmp.${process.pid}`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  await rename(temporary, output);
  process.stdout.write(`Manifeste ODbL metadata-only généré : ${output}\n`);
}

new Command()
  .name('notons-off-manifest')
  .requiredOption('--archive <path>')
  .requiredOption('--source-url <url>')
  .requiredOption('--source-published-at <timestamp>')
  .requiredOption('--source-retrieved-at <timestamp>')
  .requiredOption('--code-url <url>')
  .requiredOption('--code-revision <revision>')
  .requiredOption('--result <path>')
  .requiredOption('--output <path>')
  .showHelpAfterError()
  .action((options: Options) => run(options))
  .parseAsync()
  .catch((error: unknown) => {
    process.stderr.write(
      `Erreur de manifeste OFF : ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
