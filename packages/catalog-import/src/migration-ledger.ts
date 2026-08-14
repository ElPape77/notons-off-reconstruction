import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { OFF_RECONSTRUCTION_MIGRATION_FILES } from './reconstruction-manifest.js';

export interface OffMigrationLedgerEntry {
  filename: string;
  sha256: string;
}

export async function loadExpectedOffMigrationLedger(
  rootDirectory: string,
): Promise<readonly OffMigrationLedgerEntry[]> {
  const migrationsDirectory = resolve(rootDirectory, 'ops/off-catalog/migrations');
  const directoryStats = await lstat(migrationsDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('Le répertoire des migrations OFF est absent ou non sûr.');
  }

  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  if (JSON.stringify(filenames) !== JSON.stringify(OFF_RECONSTRUCTION_MIGRATION_FILES)) {
    throw new Error('L’inventaire local des migrations OFF est incomplet ou inattendu.');
  }

  return Promise.all(
    filenames.map(async (filename) => {
      const path = resolve(migrationsDirectory, filename);
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Migration OFF absente ou non sûre : ${filename}`);
      }
      return {
        filename,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      };
    }),
  );
}
