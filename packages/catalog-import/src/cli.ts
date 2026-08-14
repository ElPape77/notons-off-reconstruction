#!/usr/bin/env node
import { Command, Option } from 'commander';
import { resolve } from 'node:path';

import { importCatalog } from './importer.js';
import { CATALOG_IMPORTER_VERSION, resolveCatalogScope } from './catalog-scope.js';
import {
  OPEN_FOOD_FACTS_DEFAULT_CATEGORY_TAGS,
  OPEN_FOOD_FACTS_DEFAULT_COUNTRY_TAGS,
  OPEN_FOOD_FACTS_PROJECTION_VERSION,
  OpenFoodFactsMapper,
} from './mappers/open-food-facts.js';
import { MemoryCatalogRepository } from './repository/memory.js';
import { attachImportAbortSignals } from './process-signals.js';
import type { CatalogImportOptions, CatalogRepository, ImportProgress } from './types.js';

interface CliOptions {
  file: string;
  batchSize: string;
  delimiter?: string;
  limit?: string;
  updateExisting: boolean;
  countryTags: string;
  categoryTags: string;
  filterCountries?: boolean;
  filterCategories?: boolean;
  fullSnapshot?: boolean;
  allCountries?: boolean;
  allCategories?: boolean;
  snapshotMinimumRows: string;
  snapshotMinimumCoverage: string;
  snapshotMaximumRejectedRatio: string;
  sourceName: string;
  sourceVersion: string;
  sourcePublishedAt?: string;
  licenseName: string;
  licenseUrl: string;
}

const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const printableDelimiter = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (value === '\\t' || value.toLowerCase() === 'tab') return '\t';
  return value;
};

const sourceTimestamp = (value: string | undefined, required: boolean): string | null => {
  const date = value ? new Date(value) : null;
  if (date && Number.isFinite(date.getTime())) return date.toISOString();
  if (required) {
    throw new Error(
      '--source-published-at (ou --source-version au format date ISO) est obligatoire pour --full-snapshot.',
    );
  }
  return null;
};

const renderProgress = (progress: ImportProgress): void => {
  const summary = [
    `lus=${progress.processedRows}`,
    `insérés=${progress.insertedRows}`,
    `mis-à-jour=${progress.updatedRows}`,
    `rejetés=${progress.rejectedRows}`,
    `filtrés=${progress.filteredRows}`,
  ].join(' | ');
  process.stderr.write(`${progress.dryRun ? '[simulation] ' : ''}${summary}\n`);
};

async function run(options: CliOptions): Promise<void> {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const repository: CatalogRepository = new MemoryCatalogRepository();
  const controller = new AbortController();
  const {
    requireCountry,
    requireCategory,
    validateFullSnapshot,
    isFullSnapshot,
    snapshotActivationPolicy,
  } = resolveCatalogScope({
    ...options,
    dryRun: true,
  });
  const countryTags = list(options.countryTags);
  const categoryTags = list(options.categoryTags);
  const delimiter = printableDelimiter(options.delimiter);
  const mapper = new OpenFoodFactsMapper({
    countryTags,
    categoryTags,
    requireCountry,
    requireCategory,
  });
  const sourcePublishedAt = sourceTimestamp(
    options.sourcePublishedAt ?? options.sourceVersion,
    validateFullSnapshot,
  );
  const detachAbortSignals = attachImportAbortSignals(controller);

  try {
    const importOptions: CatalogImportOptions = {
      // npm workspaces change cwd to this package; INIT_CWD keeps paths relative
      // to the directory from which the user invoked the root command.
      filePath: resolve(invocationDirectory, options.file),
      mapper,
      repository,
      metadata: {
        name: options.sourceName,
        version: options.sourceVersion,
        licenseName: options.licenseName,
        licenseUrl: options.licenseUrl,
        importerVersion: CATALOG_IMPORTER_VERSION,
        projectionVersion: OPEN_FOOD_FACTS_PROJECTION_VERSION,
        importOptions: {
          mapper: 'open-food-facts',
          delimiter: delimiter ?? null,
          delimitedSourceOptions: mapper.delimitedSourceOptions,
          requireCountry,
          requireCategory,
          countryTags,
          categoryTags,
          updateExisting: options.updateExisting,
          validateFullSnapshot,
        },
        sourcePublishedAt,
        isFullSnapshot,
        ...(snapshotActivationPolicy ? { snapshotActivationPolicy } : {}),
      },
      validateFullSnapshotHeader: validateFullSnapshot,
      batchSize: Number(options.batchSize),
      delimiter,
      dryRun: true,
      limit: options.limit === undefined ? undefined : Number(options.limit),
      updateExisting: options.updateExisting,
      signal: controller.signal,
      onProgress: renderProgress,
    };
    const result = await importCatalog(importOptions);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    detachAbortSignals();
    await repository.close?.();
  }
}

const addSharedOptions = (command: Command): Command =>
  command
    .requiredOption('--file <path>', 'Fichier CSV/TSV/JSON/JSONL, éventuellement .gz ou .zip')
    .option('--batch-size <rows>', 'Nombre de lignes par transaction atomique', '500')
    .option('--delimiter <character>', 'Séparateur forcé (, ; ou \\t); auto-détecté par défaut')
    .option('--limit <rows>', 'Arrête la validation après N lignes')
    .option(
      '--country-tags <tags>',
      'Tags pays séparés par des virgules',
      OPEN_FOOD_FACTS_DEFAULT_COUNTRY_TAGS.join(','),
    )
    .option(
      '--category-tags <tags>',
      'Tags catégories séparés par des virgules',
      OPEN_FOOD_FACTS_DEFAULT_CATEGORY_TAGS.join(','),
    )
    .option('--all-countries', 'Désactive un éventuel filtre pays (compatibilité)')
    .option('--all-categories', 'Désactive un éventuel filtre catégorie (compatibilité)')
    .option('--filter-countries', 'Active le filtre fourni par --country-tags')
    .option('--filter-categories', 'Active le filtre fourni par --category-tags')
    .option(
      '--full-snapshot',
      'Déclare explicitement un dump OFF intégral (autorise le marquage stale des absents)',
    )
    .option(
      '--snapshot-minimum-rows <rows>',
      "Plancher absolu de produits distincts avant l'activation d'un snapshot complet",
      '1000000',
    )
    .option(
      '--snapshot-minimum-coverage <ratio>',
      'Couverture minimale par rapport au dernier snapshot complet (0..1)',
      '0.80',
    )
    .option(
      '--snapshot-maximum-rejected-ratio <ratio>',
      'Part maximale de lignes rejetées dans un snapshot complet (0..1)',
      '0.20',
    )
    .option('--source-name <name>', 'Nom de la source', 'Open Food Facts')
    .option('--source-version <version>', "Version/date déclarée de l'export", 'unknown')
    .option(
      '--source-published-at <timestamp>',
      'Horodatage ISO publié par la source (obligatoire pour un snapshot complet)',
    )
    .option('--license-name <name>', 'Licence de la base', 'ODbL 1.0')
    .option(
      '--license-url <url>',
      'URL HTTPS de la licence',
      'https://opendatacommons.org/licenses/odbl/1-0/',
    )
    .addOption(new Option('--no-update-existing', "N'insère que les GTIN absents").default(true));

const program = new Command()
  .name('notons-catalog')
  .description('Validation en lecture seule d’une archive catalogue')
  .showHelpAfterError();

addSharedOptions(
  program.command('check').description('Valide un catalogue sans aucune écriture'),
).action(async (options: CliOptions) => run(options));

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Erreur catalogue : ${message}\n`);
  process.exitCode = 1;
});
