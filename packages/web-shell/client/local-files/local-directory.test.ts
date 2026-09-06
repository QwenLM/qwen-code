import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_DIRECTORY_LIMITS,
  LocalDirectory,
  LocalDirectoryError,
  splitRelativePath,
  type LocalDirectoryHandleLike,
  type LocalFileHandleLike,
  type LocalFileLike,
  type LocalFileWriterLike,
} from './local-directory.js';

function domError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

class FakeFile implements LocalFileLike {
  lastModified = 1_700_000_000_000;
  type = 'text/plain';
  constructor(
    public content: string,
    private readonly rawBytes?: Uint8Array,
  ) {}
  get size(): number {
    return (
      this.rawBytes?.byteLength ?? new TextEncoder().encode(this.content).length
    );
  }
  async text(): Promise<string> {
    // Lossy on purpose, mirroring the real File API.
    return this.rawBytes
      ? new TextDecoder().decode(this.rawBytes)
      : this.content;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.rawBytes ?? new TextEncoder().encode(this.content);
    return bytes.slice().buffer as ArrayBuffer;
  }
}

class FakeWriter implements LocalFileWriterLike {
  closed = false;
  constructor(private readonly file: FakeFile) {}
  async write(data: string): Promise<void> {
    this.file.content = data;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeFileHandle implements LocalFileHandleLike {
  readonly kind = 'file';
  constructor(
    readonly name: string,
    readonly file: FakeFile,
  ) {}
  async getFile(): Promise<LocalFileLike> {
    return this.file;
  }
  async createWritable(): Promise<LocalFileWriterLike> {
    return new FakeWriter(this.file);
  }
}

class FakeDir implements LocalDirectoryHandleLike {
  readonly kind = 'directory';
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Map<string, FakeFileHandle>();
  constructor(readonly name: string) {}

  dir(path: string): FakeDir {
    return path
      .split('/')
      .filter(Boolean)
      .reduce<FakeDir>((current, segment) => {
        const next = current.dirs.get(segment);
        if (!next) throw new Error(`test setup: no such dir ${path}`);
        return next;
      }, this);
  }

  withFile(path: string, content: string): this {
    const segments = path.split('/');
    const name = segments.pop()!;
    const parent =
      segments.length === 0
        ? this
        : segments.reduce((dir, segment) => {
            let next = dir.dirs.get(segment);
            if (!next) {
              next = new FakeDir(segment);
              dir.dirs.set(segment, next);
            }
            return next;
          }, this);
    parent.files.set(name, new FakeFileHandle(name, new FakeFile(content)));
    return this;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<LocalDirectoryHandleLike> {
    const existing = this.dirs.get(name);
    if (existing) return existing;
    const fileHere = this.files.get(name);
    if (fileHere) throw domError('TypeMismatchError');
    if (options?.create !== true) throw domError('NotFoundError');
    const created = new FakeDir(name);
    this.dirs.set(name, created);
    return created;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<LocalFileHandleLike> {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (this.dirs.has(name)) throw domError('TypeMismatchError');
    if (options?.create !== true) throw domError('NotFoundError');
    const created = new FakeFileHandle(name, new FakeFile(''));
    this.files.set(name, created);
    return created;
  }

  values(): AsyncIterableIterator<unknown> {
    const entries: unknown[] = [...this.dirs.values(), ...this.files.values()];
    let index = 0;
    return {
      next: async () =>
        index < entries.length
          ? { value: entries[index++], done: false }
          : { value: undefined, done: true },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

function tree(): FakeDir {
  return new FakeDir('ai_coding')
    .withFile('README.md', '# hello\nworld\n')
    .withFile('src/main.ts', 'const a = 1;\nexport default a;\n')
    .withFile('src/util/paths.ts', 'export const sep = "/";\n')
    .withFile('notes/binary.bin', 'head\u0000tail');
}

describe('splitRelativePath', () => {
  it('accepts relative paths and normalizes empty and dot segments', () => {
    expect(splitRelativePath('')).toEqual([]);
    expect(splitRelativePath('.')).toEqual([]);
    expect(splitRelativePath('src/main.ts')).toEqual(['src', 'main.ts']);
    expect(splitRelativePath('./src//main.ts')).toEqual(['src', 'main.ts']);
    // Verbatim: list()/search() echo names as-is, and whitespace-padded names
    // are legal on POSIX — trimming would resolve one name to another file.
    expect(splitRelativePath('  src/main.ts  ')).toEqual([
      '  src',
      'main.ts  ',
    ]);
  });

  it.each([
    ['parent escape', '../etc/passwd'],
    ['embedded parent escape', 'src/../../etc/passwd'],
    ['absolute posix path', '/etc/passwd'],
    ['windows drive path', 'C:\\Users\\me\\file.txt'],
    ['windows drive path with forward slash', 'C:/Users/me/file.txt'],
    ['backslash separator', 'src\\main.ts'],
    ['control character', 'src/ma\u0000in.ts'],
  ])('rejects %s', async (_label, path) => {
    expect(() => splitRelativePath(path)).toThrowError(LocalDirectoryError);
    try {
      splitRelativePath(path);
    } catch (err) {
      expect((err as LocalDirectoryError).code).toBe('invalid_path');
    }
  });

  it('rejects a non-string path', () => {
    expect(() => splitRelativePath(42)).toThrowError(/must be a string/);
  });

  it('does not reject a literal percent sign (paths are never URL-decoded)', () => {
    expect(splitRelativePath('100%/done.txt')).toEqual(['100%', 'done.txt']);
  });

  it('accepts a colon inside a relative name (not a drive form)', () => {
    expect(splitRelativePath('a:b.txt')).toEqual(['a:b.txt']);
    expect(splitRelativePath('notes/todo:urgent.md')).toEqual([
      'notes',
      'todo:urgent.md',
    ]);
  });
});

describe('LocalDirectory.list', () => {
  it('lists the granted root with kinds, sizes and sorted paths', async () => {
    const { entries } = await new LocalDirectory(tree()).list('');
    expect(entries.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
      'file README.md',
      'directory notes',
      'directory src',
    ]);
    const readme = entries.find((e) => e.path === 'README.md');
    expect(readme?.size).toBe(
      new TextEncoder().encode('# hello\nworld\n').length,
    );
    expect(readme?.lastModified).toBe(1_700_000_000_000);
  });

  it('lists a nested directory', async () => {
    const { entries } = await new LocalDirectory(tree()).list('src');
    expect(entries.map((e) => e.path)).toEqual(['src/main.ts', 'src/util']);
  });

  it('reports truncation as a field, not as a synthetic entry', async () => {
    const result = await new LocalDirectory(tree()).list('', 1);
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(1);
    // A fake "... truncated" entry would look like a path the agent could list.
    expect(result.entries.every((e) => !e.name.startsWith('…'))).toBe(true);
  });

  it('never exceeds the configured cap even when asked to', async () => {
    const dir = new LocalDirectory(tree(), {
      ...DEFAULT_LOCAL_DIRECTORY_LIMITS,
      maxListEntries: 2,
    });
    const result = await dir.list('', 999);
    expect(result.entries).toHaveLength(2);
    expect(result.limit).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('ignores a non-positive limit instead of reporting a full directory as empty', async () => {
    const dir = new LocalDirectory(tree());
    for (const limit of [0, -5, Number.NaN]) {
      const result = await dir.list('', limit);
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);
    }
  });

  it('floors a fractional limit at one entry', async () => {
    // Math.trunc(0.5) is 0: without the floor a non-empty directory would be
    // reported as empty.
    const result = await new LocalDirectory(tree()).list('', 0.5);
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(1);
  });

  it('maps an enumeration failure to a tool error, not a protocol error', async () => {
    const revoked = Object.assign(tree(), {
      values: () => {
        async function* gen(): AsyncGenerator<unknown> {
          yield undefined;
          throw domError('NotAllowedError', 'grant revoked mid-scan');
        }
        return gen() as unknown as AsyncIterableIterator<unknown>;
      },
    });
    await expect(new LocalDirectory(revoked).list('')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(
      new LocalDirectory(revoked).search('needle'),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    const deleted = Object.assign(tree(), {
      values: () => {
        async function* gen(): AsyncGenerator<unknown> {
          yield undefined;
          throw domError('NotFoundError', 'directory deleted mid-scan');
        }
        return gen() as unknown as AsyncIterableIterator<unknown>;
      },
    });
    await expect(new LocalDirectory(deleted).list('')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('maps a missing directory to not_found', async () => {
    await expect(new LocalDirectory(tree()).list('nope')).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
  });

  it('maps a file used as a directory to not_a_directory', async () => {
    await expect(
      new LocalDirectory(tree()).list('README.md/inner'),
    ).rejects.toMatchObject({ code: 'not_a_directory' });
  });
});

describe('LocalDirectory.read', () => {
  it('reads a whole file', async () => {
    const result = await new LocalDirectory(tree()).read('README.md');
    expect(result.content).toBe('# hello\nworld\n');
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(3);
  });

  it('maps reading a directory to not_a_file', async () => {
    await expect(new LocalDirectory(tree()).read('src')).rejects.toMatchObject({
      code: 'not_a_file',
      message: 'src is a directory, not a file.',
    });
  });

  it('pages with offset and limit and reports that more remains', async () => {
    const result = await new LocalDirectory(tree()).read('src/main.ts', 1, 1);
    expect(result.content).toBe('export default a;');
    expect(result.returnedLines).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('refuses a file over the byte cap and names both numbers', async () => {
    const dir = new LocalDirectory(tree(), {
      ...DEFAULT_LOCAL_DIRECTORY_LIMITS,
      maxReadBytes: 5,
    });
    await expect(dir.read('README.md')).rejects.toMatchObject({
      code: 'too_large',
    });
    await expect(dir.read('README.md')).rejects.toThrow(/14 bytes.*5-byte/);
  });

  it('refuses binary content instead of returning mojibake', async () => {
    await expect(
      new LocalDirectory(tree()).read('notes/binary.bin'),
    ).rejects.toMatchObject({ code: 'binary_content' });
  });

  it('refuses invalid UTF-8 without NUL instead of returning replacement chars', async () => {
    // A lossy decode would return U+FFFD mojibake, and write_file's
    // read-modify-write cycle would then replace the original bytes.
    const root = tree();
    root
      .dir('notes')
      .files.set(
        'latin1.txt',
        new FakeFileHandle(
          'latin1.txt',
          new FakeFile('', new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
        ),
      );
    await expect(
      new LocalDirectory(root).read('notes/latin1.txt'),
    ).rejects.toMatchObject({ code: 'binary_content' });
  });

  it('maps a missing file to not_found', async () => {
    await expect(
      new LocalDirectory(tree()).read('src/missing.ts'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a path that escapes the root before touching the filesystem', async () => {
    await expect(
      new LocalDirectory(tree()).read('../../etc/passwd'),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });
});

describe('LocalDirectory.write', () => {
  it('creates a new file and reports it as created', async () => {
    const root = tree();
    const result = await new LocalDirectory(root).write('out.txt', 'hi');
    expect(result).toEqual({ path: 'out.txt', bytes: 2, created: true });
    expect(root.files.get('out.txt')?.file.content).toBe('hi');
  });

  it('overwrites an existing file and reports created false', async () => {
    const root = tree();
    const result = await new LocalDirectory(root).write('README.md', '# bye\n');
    expect(result.created).toBe(false);
    expect(root.files.get('README.md')?.file.content).toBe('# bye\n');
  });

  it('maps writing a directory to not_a_file', async () => {
    await expect(
      new LocalDirectory(tree()).write('src', 'x'),
    ).rejects.toMatchObject({ code: 'not_a_file' });
  });

  it('refuses content with unpaired surrogates instead of committing mojibake', async () => {
    const root = tree();
    const lone = String.fromCharCode(0xd800);
    await expect(
      new LocalDirectory(root).write('out.txt', `a${lone}b`),
    ).rejects.toMatchObject({ code: 'invalid_path' });
    expect(root.files.has('out.txt')).toBe(false);
  });

  it('round-trips whitespace-padded names verbatim', async () => {
    const root = new FakeDir('root');
    root.withFile('notes.txt', 'A');
    root.withFile(' notes.txt', 'B');
    const dir = new LocalDirectory(root);
    // A trimmed resolver would return the wrong file's content here and let a
    // read-modify-write cycle clobber `notes.txt`.
    expect((await dir.read(' notes.txt')).content).toBe('B');
    await dir.write(' notes.txt', 'B2');
    expect(root.files.get('notes.txt')?.file.content).toBe('A');
    expect(root.files.get(' notes.txt')?.file.content).toBe('B2');
  });

  it('creates intermediate directories', async () => {
    const root = tree();
    await new LocalDirectory(root).write('a/b/c.txt', 'deep');
    expect(root.dir('a/b').files.get('c.txt')?.file.content).toBe('deep');
  });

  it('refuses to write over the byte cap', async () => {
    const dir = new LocalDirectory(tree(), {
      ...DEFAULT_LOCAL_DIRECTORY_LIMITS,
      maxWriteBytes: 3,
    });
    await expect(dir.write('out.txt', 'too long')).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('requires a content string', async () => {
    const dir = new LocalDirectory(tree());
    await expect(
      dir.write('out.txt', undefined as unknown as string),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('closes the writer even when the write itself fails', async () => {
    const root = tree();
    const handle = (await root.getFileHandle('README.md')) as FakeFileHandle;
    let closed = false;
    handle.createWritable = async () => ({
      write: async () => {
        throw domError('QuotaExceededError', 'disk full');
      },
      close: async () => {
        closed = true;
      },
    });

    await expect(
      new LocalDirectory(root).write('README.md', 'nope'),
    ).rejects.toThrow(/disk full/);
    expect(closed).toBe(true);
    // The failed write must not have half-replaced the file's content.
    expect(handle.file.content).toBe('# hello\nworld\n');
  });
});

describe('LocalDirectory.search', () => {
  it('finds literal matches with path and line numbers, descending into subdirs', async () => {
    const result = await new LocalDirectory(tree()).search('export');
    expect(result.hits.map((h) => `${h.path}:${h.line}`)).toEqual([
      'src/main.ts:2',
      'src/util/paths.ts:1',
    ]);
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('rejects a multi-line pattern instead of reporting a silent no-match', async () => {
    // Matching is per line, so this pattern could never hit; a definitive
    // "No match" would be a false negative the model acts on.
    await expect(
      new LocalDirectory(tree()).search('export default a;\nconst'),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('rejects a NUL-bearing pattern instead of reporting a silent no-match', async () => {
    // Every file containing NUL is skipped as binary, so such a pattern can
    // never hit either; same false-negative class as the multi-line guard.
    await expect(
      new LocalDirectory(tree()).search('SQLite\u0000'),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('counts a failed getFile against the file budget', async () => {
    const root = new FakeDir('root');
    for (const name of ['a', 'b', 'c']) {
      root.files.set(name, {
        kind: 'file',
        name,
        getFile: async () => {
          throw domError('NotAllowedError', 'grant revoked mid-scan');
        },
        createWritable: async () => new FakeWriter(new FakeFile('')),
      } as unknown as FakeFileHandle);
    }
    // The attempt counts, not the success: a mid-scan revocation must stop at
    // the cap instead of paying a failing round trip per file.
    const result = await new LocalDirectory(root).search('x', { maxFiles: 2 });
    expect(result.filesSkipped).toBe(2);
    expect(result.truncatedBy).toBe('files');
    expect(result.hits).toEqual([]);
  });

  it('skips undecodable files in search instead of scanning mojibake', async () => {
    const root = new FakeDir('root');
    root.files.set(
      'latin1.txt',
      new FakeFileHandle(
        'latin1.txt',
        new FakeFile('', new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
      ),
    );
    const result = await new LocalDirectory(root).search('café');
    expect(result.filesScanned).toBe(0);
    expect(result.filesSkipped).toBe(1);
    expect(result.hits).toEqual([]);
  });

  it('searches a subtree only', async () => {
    const result = await new LocalDirectory(tree()).search('export', {
      path: 'src/util',
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.path).toBe('src/util/paths.ts');
  });

  it('treats the pattern literally, not as a regex', async () => {
    const dir = tree().withFile('re.txt', 'a.b and axb\n');
    const result = await new LocalDirectory(dir).search('a.b');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.text).toContain('a.b');
  });

  it('skips binary files and counts them so the report is not silently short', async () => {
    const result = await new LocalDirectory(tree()).search('head');
    expect(result.hits).toEqual([]);
    expect(result.filesSkipped).toBe(1);
  });

  it('counts a file over the read cap as skipped', async () => {
    const dir = new LocalDirectory(tree(), {
      ...DEFAULT_LOCAL_DIRECTORY_LIMITS,
      maxReadBytes: 5,
    });
    const result = await dir.search('hello');
    // Every text file in the tree is over a 5-byte cap, so nothing was scanned
    // and the report must say so instead of claiming "no match".
    expect(result.filesScanned).toBe(0);
    expect(result.filesSkipped).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('bounds the file budget by files examined, so binary-heavy trees cannot run away', async () => {
    const dir = new FakeDir('root')
      .withFile('a.bin', 'x\u0000x')
      .withFile('b.bin', 'y\u0000y')
      .withFile('c.bin', 'z\u0000z');
    const result = await new LocalDirectory(dir).search('x', { maxFiles: 2 });
    expect(result.truncatedBy).toBe('files');
    // Every examined file is accounted for exactly once, as scanned or skipped.
    expect(result.filesScanned + result.filesSkipped).toBeLessThanOrEqual(2);
  });

  it('stops at the file budget and says which budget cut it off', async () => {
    const result = await new LocalDirectory(tree()).search('const', {
      maxFiles: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('files');
    expect(result.filesScanned).toBeLessThanOrEqual(1);
  });

  it('stops at the hit budget', async () => {
    const dir = new LocalDirectory(tree(), {
      ...DEFAULT_LOCAL_DIRECTORY_LIMITS,
      maxSearchHits: 1,
    });
    const result = await dir.search('export');
    expect(result.hits).toHaveLength(1);
    expect(result.truncatedBy).toBe('hits');
  });

  it('truncates a very long matching line instead of echoing all of it', async () => {
    const dir = tree().withFile('min.js', `needle${'x'.repeat(900)}`);
    const result = await new LocalDirectory(dir).search('needle');
    expect(result.hits[0]!.text.length).toBeLessThan(500);
    expect(result.hits[0]!.text.endsWith('…')).toBe(true);
  });

  it('rejects an empty pattern', async () => {
    await expect(new LocalDirectory(tree()).search('')).rejects.toThrowError(
      LocalDirectoryError,
    );
  });
});
