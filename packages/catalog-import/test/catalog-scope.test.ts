import { describe, expect, it } from 'vitest';

import { resolveCatalogScope } from '../src/index.js';

describe('portee du catalogue', () => {
  it('garde le snapshot complet desactive par defaut', () => {
    expect(resolveCatalogScope({})).toEqual({
      requireCountry: false,
      requireCategory: false,
      validateFullSnapshot: false,
      isFullSnapshot: false,
      snapshotActivationPolicy: null,
    });
  });

  it('accepte uniquement une declaration explicite non bornee', () => {
    expect(resolveCatalogScope({ fullSnapshot: true })).toMatchObject({
      validateFullSnapshot: true,
      isFullSnapshot: true,
      snapshotActivationPolicy: {
        minimumRows: 1,
        minimumPreviousCoverage: 0.8,
        maximumRejectedRatio: 0.2,
      },
    });
    expect(resolveCatalogScope({ fullSnapshot: true, dryRun: true })).toMatchObject({
      validateFullSnapshot: true,
      isFullSnapshot: false,
    });
  });

  it('refuse de traiter un extrait ou un filtre comme un snapshot complet', () => {
    expect(() => resolveCatalogScope({ fullSnapshot: true, limit: '100000' })).toThrow(
      '--full-snapshot',
    );
    expect(() => resolveCatalogScope({ fullSnapshot: true, filterCountries: true })).toThrow(
      '--full-snapshot',
    );
    expect(() => resolveCatalogScope({ fullSnapshot: true, filterCategories: true })).toThrow(
      '--full-snapshot',
    );
    expect(() => resolveCatalogScope({ fullSnapshot: true, updateExisting: false })).toThrow(
      '--full-snapshot',
    );
  });

  it('valide et normalise les seuils configurables', () => {
    expect(
      resolveCatalogScope({
        fullSnapshot: true,
        snapshotMinimumRows: '1000000',
        snapshotMinimumCoverage: '0.75',
        snapshotMaximumRejectedRatio: '0.20',
      }).snapshotActivationPolicy,
    ).toEqual({
      minimumRows: 1_000_000,
      minimumPreviousCoverage: 0.75,
      maximumRejectedRatio: 0.2,
    });
    expect(() => resolveCatalogScope({ fullSnapshot: true, snapshotMinimumRows: '0' })).toThrow(
      '--snapshot-minimum-rows',
    );
    expect(() =>
      resolveCatalogScope({ fullSnapshot: true, snapshotMinimumCoverage: '1.1' }),
    ).toThrow('--snapshot-minimum-coverage');
    expect(() =>
      resolveCatalogScope({ fullSnapshot: true, snapshotMaximumRejectedRatio: '-0.1' }),
    ).toThrow('--snapshot-maximum-rejected-ratio');
  });
});
