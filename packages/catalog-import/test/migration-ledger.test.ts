import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadExpectedOffMigrationLedger,
  OFF_RECONSTRUCTION_MIGRATION_FILES,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const fixture = async (): Promise<{ root: string; migrations: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'notons-off-ledger-'));
  temporaryDirectories.push(root);
  const migrations = join(root, 'ops', 'off-catalog', 'migrations');
  await mkdir(migrations, { recursive: true });
  await Promise.all(
    OFF_RECONSTRUCTION_MIGRATION_FILES.map((filename) =>
      writeFile(join(migrations, filename), `-- ${filename}\n`),
    ),
  );
  return { root, migrations };
};

describe('inventaire local des migrations OFF', () => {
  it('charge uniquement la séquence exacte et calcule ses SHA-256', async () => {
    const source = await fixture();

    const ledger = await loadExpectedOffMigrationLedger(source.root);

    expect(ledger.map((entry) => entry.filename)).toEqual(OFF_RECONSTRUCTION_MIGRATION_FILES);
    expect(ledger[0]?.sha256).toBe(
      createHash('sha256').update(`-- ${OFF_RECONSTRUCTION_MIGRATION_FILES[0]}\n`).digest('hex'),
    );
  });

  it('refuse une migration manquante ou supplémentaire', async () => {
    const missing = await fixture();
    await rm(join(missing.migrations, OFF_RECONSTRUCTION_MIGRATION_FILES[0]));
    await expect(loadExpectedOffMigrationLedger(missing.root)).rejects.toThrow('incomplet');

    const extra = await fixture();
    await writeFile(join(extra.migrations, '013_unexpected.sql'), '-- unexpected\n');
    await expect(loadExpectedOffMigrationLedger(extra.root)).rejects.toThrow('inattendu');
  });
});
