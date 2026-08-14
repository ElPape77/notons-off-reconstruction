import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { assertPublicRepositoryRevision } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const git = (directory: string, ...arguments_: string[]): string =>
  execFileSync('git', arguments_, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

const repository = async (): Promise<{ directory: string; revision: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'notons-off-git-provenance-'));
  temporaryDirectories.push(directory);
  git(directory, 'init');
  git(directory, 'config', 'user.name', 'Notons CI');
  git(directory, 'config', 'user.email', 'notons-ci@users.noreply.github.com');
  await writeFile(join(directory, 'README.md'), 'fixture\n');
  await writeFile(join(directory, '.gitignore'), 'ignored.txt\ndist/\n');
  git(directory, 'add', 'README.md', '.gitignore');
  git(directory, 'commit', '-m', 'test fixture');
  return { directory, revision: git(directory, 'rev-parse', 'HEAD') };
};

describe('provenance Git publique', () => {
  it('accepte uniquement le HEAD exact d’un dépôt propre', async () => {
    const fixture = await repository();

    expect(assertPublicRepositoryRevision(fixture.directory, fixture.revision, ['README.md'])).toBe(
      fixture.revision,
    );
    expect(() => assertPublicRepositoryRevision(fixture.directory, 'a'.repeat(40))).toThrow(
      'commit Git public courant',
    );
  });

  it('refuse les modifications suivies et les fichiers non suivis', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, 'README.md'), 'modified\n');
    expect(() => assertPublicRepositoryRevision(fixture.directory, fixture.revision)).toThrow(
      'modifications non validées',
    );

    git(fixture.directory, 'restore', 'README.md');
    await writeFile(join(fixture.directory, 'untracked.txt'), 'untracked\n');
    expect(() => assertPublicRepositoryRevision(fixture.directory, fixture.revision)).toThrow(
      'modifications non validées',
    );
  });

  it('refuse un fichier normatif ignoré mais absent de HEAD', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, 'ignored.txt'), 'ignored\n');

    expect(() =>
      assertPublicRepositoryRevision(fixture.directory, fixture.revision, ['ignored.txt']),
    ).toThrow('n’est pas suivi dans Git');
  });

  it('détecte les octets modifiés malgré assume-unchanged ou skip-worktree', async () => {
    const fixture = await repository();

    git(fixture.directory, 'update-index', '--assume-unchanged', 'README.md');
    await writeFile(join(fixture.directory, 'README.md'), 'hidden assume-unchanged\n');
    expect(git(fixture.directory, 'status', '--porcelain=v1')).toBe('');
    expect(() =>
      assertPublicRepositoryRevision(fixture.directory, fixture.revision, ['README.md']),
    ).toThrow('diffère du blob Git HEAD');

    git(fixture.directory, 'update-index', '--no-assume-unchanged', 'README.md');
    git(fixture.directory, 'restore', 'README.md');
    git(fixture.directory, 'update-index', '--skip-worktree', 'README.md');
    await writeFile(join(fixture.directory, 'README.md'), 'hidden skip-worktree\n');
    expect(git(fixture.directory, 'status', '--porcelain=v1')).toBe('');
    expect(() =>
      assertPublicRepositoryRevision(fixture.directory, fixture.revision, ['README.md']),
    ).toThrow('diffère du blob Git HEAD');
  });

  it('autorise les artefacts de publication documentés dans le répertoire dist ignoré', async () => {
    const fixture = await repository();
    const dist = join(fixture.directory, 'dist');
    await mkdir(dist);
    await writeFile(join(dist, 'reconstruction-result.json'), '{}\n');
    await writeFile(join(dist, 'reconstruction-manifest.json'), '{}\n');

    expect(assertPublicRepositoryRevision(fixture.directory, fixture.revision, ['README.md'])).toBe(
      fixture.revision,
    );

    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const [gitignore, releasing] = await Promise.all([
      readFile(join(root, '.gitignore'), 'utf8'),
      readFile(join(root, 'RELEASING.md'), 'utf8'),
    ]);
    expect(gitignore.split(/\r?\n/)).toContain('dist/');
    expect(releasing).toContain('--result dist/reconstruction-result.json');
    expect(releasing).toContain('--output dist/reconstruction-manifest.json');
    expect(releasing).toContain('manifest:verify -- dist/reconstruction-manifest.json');
  });
});
