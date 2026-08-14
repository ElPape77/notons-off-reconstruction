import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const git = (rootDirectory: string, arguments_: readonly string[]): string => {
  try {
    return execFileSync('git', arguments_, {
      cwd: rootDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('Le dépôt Git public est absent ou son état ne peut pas être vérifié.');
  }
};

const gitBytes = (rootDirectory: string, arguments_: readonly string[]): Buffer => {
  try {
    return execFileSync('git', arguments_, {
      cwd: rootDirectory,
      encoding: 'buffer',
      maxBuffer: 3 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('Le dépôt Git public est absent ou son état ne peut pas être vérifié.');
  }
};

const samePath = (left: string, right: string): boolean => {
  const normalizedLeft = realpathSync.native(resolve(left));
  const normalizedRight = realpathSync.native(resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en') === normalizedRight.toLocaleLowerCase('en')
    : normalizedLeft === normalizedRight;
};

/** Binds an attested reconstruction to the exact, clean public Git checkout. */
export function assertPublicRepositoryRevision(
  rootDirectory: string,
  expectedRevision: string,
  requiredPaths: readonly string[] = [],
): string {
  if (!REVISION_PATTERN.test(expectedRevision)) {
    throw new Error('La révision publique doit contenir 40 ou 64 caractères hexadécimaux.');
  }
  const repositoryRoot = git(rootDirectory, ['rev-parse', '--show-toplevel']);
  if (!samePath(repositoryRoot, rootDirectory)) {
    throw new Error('La reconstruction doit être lancée depuis la racine du dépôt public.');
  }
  const headRevision = git(rootDirectory, ['rev-parse', 'HEAD']);
  if (headRevision !== expectedRevision) {
    throw new Error('La révision déclarée ne correspond pas au commit Git public courant.');
  }
  const status = git(rootDirectory, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (status) {
    throw new Error('Le dépôt public contient des modifications non validées dans Git.');
  }
  for (const requiredPath of requiredPaths) {
    if (
      !/^[a-zA-Z0-9._/-]+$/.test(requiredPath) ||
      requiredPath.startsWith('/') ||
      requiredPath.split('/').includes('..')
    ) {
      throw new Error(`Chemin normatif Git invalide : ${requiredPath}`);
    }
    const treeEntry = git(rootDirectory, ['ls-tree', 'HEAD', '--', requiredPath]);
    if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(treeEntry)) {
      throw new Error(`Le fichier normatif n’est pas suivi dans Git : ${requiredPath}`);
    }
    const absolutePath = resolve(rootDirectory, requiredPath);
    const stats = lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Le fichier normatif n’est pas un fichier régulier : ${requiredPath}`);
    }
    const headBytes = gitBytes(rootDirectory, ['cat-file', 'blob', `HEAD:${requiredPath}`]);
    if (!readFileSync(absolutePath).equals(headBytes)) {
      throw new Error(`Le fichier normatif diffère du blob Git HEAD : ${requiredPath}`);
    }
  }
  return headRevision;
}
