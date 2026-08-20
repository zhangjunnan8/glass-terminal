import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFilesystemBackend } from './local-filesystem';
import { FilesystemReadLimitError } from './remote-filesystem';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-terminal-local-filesystem-'));
  roots.push(root);
  return root;
}

describe('LocalFilesystemBackend', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads paths and maps stat metadata without throwing for missing paths', async () => {
    const root = temporaryRoot();
    const file = join(root, 'file.txt');
    writeFileSync(file, 'content', 'utf8');
    const filesystem = new LocalFilesystemBackend();

    await expect(filesystem.realpath(file)).resolves.toBe(file);
    await expect(filesystem.readFile(file)).resolves.toEqual(Buffer.from('content'));
    await expect(filesystem.stat(file)).resolves.toMatchObject({
      type: 'file',
      size: 7,
      mode: expect.any(Number),
      modifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    await expect(filesystem.stat(join(root, 'missing'))).resolves.toBeUndefined();
    await expect(filesystem.lstat(join(root, 'missing'))).resolves.toBeUndefined();
  });

  it('lists symlinks themselves without following their targets', async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8');
    const link = join(root, 'linked-directory');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const filesystem = new LocalFilesystemBackend();

    const entries = [];
    for await (const entry of filesystem.iterateDirectory(root)) entries.push(entry);
    expect(entries).toContainEqual(expect.objectContaining({
      name: 'linked-directory',
      path: link,
      stat: expect.objectContaining({ type: 'symlink' }),
    }));
    await expect(filesystem.lstat(link)).resolves.toMatchObject({ type: 'symlink' });
    await expect(filesystem.stat(link)).resolves.toMatchObject({ type: 'directory' });
  });

  it('does not stat local entries that the bounded consumer never requests', async () => {
    const root = temporaryRoot();
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(root, `entry-${index}.txt`), String(index), 'utf8');
    }
    class RecordingFilesystem extends LocalFilesystemBackend {
      readonly entryStats: string[] = [];

      protected override readDirectoryEntryStat(path: string): Promise<Stats> {
        this.entryStats.push(path);
        return super.readDirectoryEntryStat(path);
      }
    }
    const filesystem = new RecordingFilesystem();
    let consumed = 0;
    for await (const _entry of filesystem.iterateDirectory(root)) {
      consumed += 1;
      if (consumed === 3) break;
    }

    expect(consumed).toBe(3);
    expect(filesystem.entryStats).toHaveLength(3);
  });

  it('maps file and directory mutations, including atomic replacement', async () => {
    const root = temporaryRoot();
    const filesystem = new LocalFilesystemBackend();
    const source = join(root, 'source.txt');
    const renamed = join(root, 'renamed.txt');
    const replacement = join(root, 'replacement.txt');
    const directory = join(root, 'directory');

    await filesystem.writeFile(source, Buffer.from('source'));
    await filesystem.rename(source, renamed);
    await filesystem.writeFile(replacement, Buffer.from('replacement'), 0o1640);
    await filesystem.atomicReplace(replacement, renamed);
    expect(readFileSync(renamed, 'utf8')).toBe('replacement');

    await filesystem.mkdir(directory, 0o1750);
    await expect(filesystem.stat(directory)).resolves.toMatchObject({ type: 'directory' });
    await filesystem.rmdir(directory);
    await filesystem.unlink(renamed);
    await expect(filesystem.stat(renamed)).resolves.toBeUndefined();
  });

  it('bounds reads and supports exclusive file creation', async () => {
    const root = temporaryRoot();
    const filesystem = new LocalFilesystemBackend();
    const path = join(root, 'bounded.txt');

    await filesystem.writeFile(path, Buffer.from('1234'), undefined, true);
    await expect(filesystem.readFile(path, 4)).resolves.toEqual(Buffer.from('1234'));
    await expect(filesystem.readFile(path, 3)).rejects.toBeInstanceOf(FilesystemReadLimitError);
    await expect(filesystem.writeFile(path, Buffer.from('overwrite'), undefined, true))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(path, 'utf8')).toBe('1234');
  });

  it.runIf(process.platform !== 'win32')(
    'uses secure default modes and masks special permission bits',
    async () => {
      const root = temporaryRoot();
      const filesystem = new LocalFilesystemBackend();
      const defaultFile = join(root, 'default.txt');
      const maskedFile = join(root, 'masked.txt');
      const defaultDirectory = join(root, 'default-directory');
      const maskedDirectory = join(root, 'masked-directory');

      await filesystem.writeFile(defaultFile, Buffer.from('default'));
      await filesystem.writeFile(maskedFile, Buffer.from('masked'), 0o7640);
      await filesystem.mkdir(defaultDirectory);
      await filesystem.mkdir(maskedDirectory, 0o7750);

      expect(statSync(defaultFile).mode & 0o777).toBe(0o600);
      expect(statSync(maskedFile).mode & 0o777).toBe(0o640);
      expect(statSync(defaultDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(maskedDirectory).mode & 0o777).toBe(0o750);
    },
  );
});
