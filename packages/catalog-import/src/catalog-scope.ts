import type { SnapshotActivationPolicy, SourceCatalogMetadata } from './types.js';

export const CATALOG_IMPORTER_VERSION = 'notons-catalog-import/2026-08-12.5';

export interface CatalogScopeOptions {
  filterCountries?: boolean;
  filterCategories?: boolean;
  allCountries?: boolean;
  allCategories?: boolean;
  fullSnapshot?: boolean;
  limit?: string | number;
  dryRun?: boolean;
  updateExisting?: boolean;
  snapshotMinimumRows?: string | number;
  snapshotMinimumCoverage?: string | number;
  snapshotMaximumRejectedRatio?: string | number;
}

export interface ResolvedCatalogScope {
  requireCountry: boolean;
  requireCategory: boolean;
  validateFullSnapshot: boolean;
  isFullSnapshot: boolean;
  snapshotActivationPolicy: SnapshotActivationPolicy | null;
}

export const DEFAULT_SNAPSHOT_ACTIVATION_POLICY: Readonly<SnapshotActivationPolicy> = Object.freeze(
  {
    minimumRows: 1,
    minimumPreviousCoverage: 0.8,
    maximumRejectedRatio: 0.2,
  },
);

export const buildCatalogImportContract = (
  metadata: SourceCatalogMetadata,
): Record<string, unknown> => ({
  schemaVersion: 1,
  importerVersion: metadata.importerVersion,
  projectionVersion: metadata.projectionVersion,
  importOptions: metadata.importOptions,
  sourcePublishedAt: metadata.sourcePublishedAt ?? null,
  isFullSnapshot: Boolean(metadata.isFullSnapshot),
  snapshotActivationPolicy: metadata.snapshotActivationPolicy ?? null,
});

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const catalogImportContractsMatch = (
  left: SourceCatalogMetadata,
  right: SourceCatalogMetadata,
): boolean =>
  canonicalJson(buildCatalogImportContract(left)) ===
  canonicalJson(buildCatalogImportContract(right));

const positiveInteger = (value: string | number | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('--snapshot-minimum-rows doit etre un entier strictement positif.');
  }
  return parsed;
};

const ratio = (
  value: string | number | undefined,
  fallback: number,
  optionName: string,
): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${optionName} doit etre compris entre 0 et 1.`);
  }
  return parsed;
};

/** Prevent a sample or filtered file from making absent catalogue rows stale. */
export function resolveCatalogScope(options: CatalogScopeOptions): ResolvedCatalogScope {
  const requireCountry = Boolean(options.filterCountries) && !options.allCountries;
  const requireCategory = Boolean(options.filterCategories) && !options.allCategories;
  if (
    options.fullSnapshot &&
    (requireCountry ||
      requireCategory ||
      options.limit !== undefined ||
      options.updateExisting === false)
  ) {
    throw new Error(
      '--full-snapshot est incompatible avec les filtres, --limit et --no-update-existing.',
    );
  }
  const validateFullSnapshot = Boolean(options.fullSnapshot);
  const isFullSnapshot = validateFullSnapshot && !options.dryRun;
  return {
    requireCountry,
    requireCategory,
    validateFullSnapshot,
    isFullSnapshot,
    snapshotActivationPolicy: validateFullSnapshot
      ? {
          minimumRows: positiveInteger(
            options.snapshotMinimumRows,
            DEFAULT_SNAPSHOT_ACTIVATION_POLICY.minimumRows,
          ),
          minimumPreviousCoverage: ratio(
            options.snapshotMinimumCoverage,
            DEFAULT_SNAPSHOT_ACTIVATION_POLICY.minimumPreviousCoverage,
            '--snapshot-minimum-coverage',
          ),
          maximumRejectedRatio: ratio(
            options.snapshotMaximumRejectedRatio,
            DEFAULT_SNAPSHOT_ACTIVATION_POLICY.maximumRejectedRatio,
            '--snapshot-maximum-rejected-ratio',
          ),
        }
      : null,
  };
}
