import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createVerifiedArchiveSnapshot } from '../src/verified-archive-snapshot.js';
import { readCatalogRows } from '../src/source.js';

const SYSTEM_TEMP_DIRECTORY = tmpdir();
const TEMP_ENVIRONMENT_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

describe('snapshot vérifié de l’archive OFF', () => {
  let fixtureDirectory: string;
  let isolatedTempDirectory: string;
  let previousTempEnvironment: Record<string, string | undefined>;

  beforeEach(async () => {
    fixtureDirectory = await mkdtemp(join(SYSTEM_TEMP_DIRECTORY, 'notons-snapshot-test-'));
    isolatedTempDirectory = join(fixtureDirectory, 'system-temp');
    await mkdir(isolatedTempDirectory, { mode: 0o700 });
    previousTempEnvironment = Object.fromEntries(
      TEMP_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
    );
    for (const key of TEMP_ENVIRONMENT_KEYS) process.env[key] = isolatedTempDirectory;
  });

  afterEach(async () => {
    for (const key of TEMP_ENVIRONMENT_KEYS) {
      const previous = previousTempEnvironment[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  it('conserve les octets vérifiés après le remplacement de la source', async () => {
    const sourcePath = join(fixtureDirectory, 'open-food-facts.tsv.gz');
    const movedSourcePath = join(fixtureDirectory, 'source-originale.tsv.gz');
    const original = gzipSync('code\tproduct_name\n96385074\tProduit original\n');
    const replacement = gzipSync('code\tproduct_name\n96385074\tProduit remplace\n');
    const expectedSha256 = createHash('sha256').update(original).digest('hex');
    await writeFile(sourcePath, original);

    const snapshot = await createVerifiedArchiveSnapshot(sourcePath, expectedSha256);
    await rename(sourcePath, movedSourcePath);
    await writeFile(sourcePath, replacement);

    expect(snapshot.sha256).toBe(expectedSha256);
    expect(await readFile(snapshot.filePath)).toEqual(original);
    const projectedNames: string[] = [];
    for await (const row of readCatalogRows(snapshot.filePath, { delimiter: '\t' })) {
      if (row.kind === 'row') projectedNames.push(String(row.data.product_name));
    }
    expect(projectedNames).toEqual(['Produit original']);
    expect(basename(snapshot.filePath)).toBe('archive.tsv.gz');
    expect(dirname(dirname(snapshot.filePath))).toBe(isolatedTempDirectory);

    if (process.platform !== 'win32') {
      expect((await stat(dirname(snapshot.filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(snapshot.filePath)).mode & 0o777).toBe(0o600);
    }

    const snapshotDirectory = dirname(snapshot.filePath);
    await snapshot.cleanup();
    await snapshot.cleanup();
    await expect(lstat(snapshot.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(snapshotDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejette une empreinte incorrecte et supprime tous les artefacts', async () => {
    const sourcePath = join(fixtureDirectory, 'open-food-facts.tsv.gz');
    await writeFile(sourcePath, gzipSync('code\tproduct_name\n96385074\tProduit\n'));

    await expect(createVerifiedArchiveSnapshot(sourcePath, '0'.repeat(64))).rejects.toThrow(
      'Empreinte de l’archive OFF incorrecte',
    );
    expect(await readdir(isolatedTempDirectory)).toEqual([]);
  });

  it('interrompt une copie en cours et nettoie le dossier privé', async () => {
    const sourcePath = join(fixtureDirectory, 'large-open-food-facts.tsv.gz');
    await writeFile(sourcePath, 'snapshot-abort-fixture');
    await truncate(sourcePath, 64 * 1024 * 1024);
    const controller = new AbortController();
    const operation = createVerifiedArchiveSnapshot(sourcePath, '0'.repeat(64), controller.signal);
    const observed = operation.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await expect
      .poll(async () => (await readdir(isolatedTempDirectory)).length, { timeout: 5_000 })
      .toBe(1);
    controller.abort();

    const result = await observed;
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ name: 'AbortError' });
    expect(await readdir(isolatedTempDirectory)).toEqual([]);
  });

  it('rejette les dossiers et les extensions autres que .tsv.gz', async () => {
    const directoryPath = join(fixtureDirectory, 'directory.tsv.gz');
    const wrongExtensionPath = join(fixtureDirectory, 'archive.csv.gz');
    await mkdir(directoryPath);
    await writeFile(wrongExtensionPath, 'fixture');

    await expect(createVerifiedArchiveSnapshot(directoryPath, '0'.repeat(64))).rejects.toThrow(
      'fichier régulier',
    );
    await expect(createVerifiedArchiveSnapshot(wrongExtensionPath, '0'.repeat(64))).rejects.toThrow(
      '.tsv.gz',
    );
    expect(await readdir(isolatedTempDirectory)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('rejette un lien symbolique source', async () => {
    const targetPath = join(fixtureDirectory, 'target.tsv.gz');
    const sourcePath = join(fixtureDirectory, 'link.tsv.gz');
    await writeFile(targetPath, gzipSync('fixture'));
    await symlink(targetPath, sourcePath, 'file');

    await expect(createVerifiedArchiveSnapshot(sourcePath, '0'.repeat(64))).rejects.toThrow(
      'sans lien symbolique',
    );
    expect(await readdir(isolatedTempDirectory)).toEqual([]);
  });
});
