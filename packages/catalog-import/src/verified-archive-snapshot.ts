import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SNAPSHOT_DIRECTORY_PREFIX = 'notons-off-archive-snapshot-';
const SNAPSHOT_FILENAME = 'archive.tsv.gz';
const COPY_BUFFER_BYTES = 1024 * 1024;

export interface VerifiedArchiveSnapshot {
  filePath: string;
  sha256: string;
  cleanup: () => Promise<void>;
}

const throwIfAborted = (signal?: AbortSignal): void => signal?.throwIfAborted();

const isMissingPathError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertRegularSource = (stats: BigIntStats): void => {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('L’archive OFF source doit être un fichier régulier sans lien symbolique.');
  }
};

const removeSnapshotArtifacts = async (
  snapshotPath: string,
  directoryPath: string,
): Promise<void> => {
  const errors: unknown[] = [];
  try {
    await unlink(snapshotPath);
  } catch (error) {
    if (!isMissingPathError(error)) errors.push(error);
  }
  try {
    await rmdir(directoryPath);
  } catch (error) {
    if (!isMissingPathError(error)) errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Le nettoyage du snapshot OFF a échoué.');
  }
};

const createIdempotentCleanup = (
  snapshotPath: string,
  directoryPath: string,
): (() => Promise<void>) => {
  let cleaned = false;
  let pending: Promise<void> | undefined;

  return async (): Promise<void> => {
    if (cleaned) return;
    if (!pending) {
      pending = removeSnapshotArtifacts(snapshotPath, directoryPath)
        .then(() => {
          cleaned = true;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    await pending;
  };
};

const closeHandle = async (handle: FileHandle | undefined, errors: unknown[]): Promise<void> => {
  if (!handle) return;
  try {
    await handle.close();
  } catch (error) {
    errors.push(error);
  }
};

const copyAndHash = async (
  source: FileHandle,
  destination: FileHandle,
  signal?: AbortSignal,
): Promise<string> => {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);

  while (true) {
    throwIfAborted(signal);
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
    throwIfAborted(signal);
    if (bytesRead === 0) break;

    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      throwIfAborted(signal);
      const result = await destination.write(buffer, written, bytesRead - written, null);
      if (result.bytesWritten === 0) {
        throw new Error('La copie du snapshot de l’archive OFF n’a pas progressé.');
      }
      written += result.bytesWritten;
    }
  }

  throwIfAborted(signal);
  return hash.digest('hex');
};

export async function createVerifiedArchiveSnapshot(
  sourcePath: string,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<VerifiedArchiveSnapshot> {
  if (!/\.tsv\.gz$/.test(sourcePath)) {
    throw new Error('L’archive OFF source doit être un fichier local .tsv.gz.');
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('L’empreinte attendue de l’archive OFF doit être un SHA-256 minuscule.');
  }
  throwIfAborted(signal);

  const pathStats = await lstat(sourcePath, { bigint: true });
  assertRegularSource(pathStats);
  throwIfAborted(signal);

  let sourceHandle: FileHandle | undefined;
  let snapshotHandle: FileHandle | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    sourceHandle = await open(sourcePath, 'r');
    const openedStats = await sourceHandle.stat({ bigint: true });
    assertRegularSource(openedStats);
    if (!sameFile(pathStats, openedStats)) {
      throw new Error('L’archive OFF source a changé pendant son ouverture.');
    }

    const confirmedPathStats = await lstat(sourcePath, { bigint: true });
    assertRegularSource(confirmedPathStats);
    if (!sameFile(openedStats, confirmedPathStats)) {
      throw new Error('L’archive OFF source a changé pendant son ouverture.');
    }
    throwIfAborted(signal);

    const directoryPath = await mkdtemp(join(tmpdir(), SNAPSHOT_DIRECTORY_PREFIX));
    const snapshotPath = join(directoryPath, SNAPSHOT_FILENAME);
    cleanup = createIdempotentCleanup(snapshotPath, directoryPath);
    await chmod(directoryPath, 0o700);
    throwIfAborted(signal);

    snapshotHandle = await open(snapshotPath, 'wx', 0o600);
    await snapshotHandle.chmod(0o600);
    const sha256 = await copyAndHash(sourceHandle, snapshotHandle, signal);

    await snapshotHandle.close();
    snapshotHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    throwIfAborted(signal);

    if (sha256 !== expectedSha256) {
      throw new Error(
        `Empreinte de l’archive OFF incorrecte : attendu ${expectedSha256}, obtenu ${sha256}.`,
      );
    }

    return { filePath: snapshotPath, sha256, cleanup };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await closeHandle(snapshotHandle, cleanupErrors);
    await closeHandle(sourceHandle, cleanupErrors);
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'La création ou le nettoyage du snapshot de l’archive OFF a échoué.',
      );
    }
    throw error;
  }
}
