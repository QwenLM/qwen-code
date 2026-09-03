/**
 * Path-safe filesystem facade over one user-granted directory.
 *
 * Every path is relative to the granted root: the File System Access API gives
 * no way to reach outside it, and the checks here exist so a model-supplied
 * path cannot even *ask* for that (no absolute paths, no `..`, no backslashes).
 *
 * The handle types are structural rather than the DOM interfaces so this module
 * is testable with an in-memory tree; a real `FileSystemDirectoryHandle`
 * satisfies them as-is.
 */

export interface LocalFileLike {
  readonly size: number;
  readonly lastModified: number;
  readonly type: string;
  text(): Promise<string>;
}

export interface LocalFileWriterLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface LocalFileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<LocalFileLike>;
  createWritable(): Promise<LocalFileWriterLike>;
}

export interface LocalDirectoryHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<LocalDirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<LocalFileHandleLike>;
  values(): AsyncIterableIterator<unknown>;
}

export type LocalDirectoryErrorCode =
  | 'invalid_path'
  | 'not_found'
  | 'not_a_directory'
  | 'not_a_file'
  | 'too_large'
  | 'binary_content'
  | 'permission_denied'
  | 'failed';

export class LocalDirectoryError extends Error {
  constructor(
    readonly code: LocalDirectoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalDirectoryError';
  }
}

export interface LocalDirectoryLimits {
  maxListEntries: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxSearchFiles: number;
  maxSearchBytes: number;
  maxSearchHits: number;
}

export const DEFAULT_LOCAL_DIRECTORY_LIMITS: LocalDirectoryLimits = {
  maxListEntries: 500,
  maxReadBytes: 1_000_000,
  maxWriteBytes: 10_000_000,
  maxSearchFiles: 2_000,
  maxSearchBytes: 20_000_000,
  maxSearchHits: 200,
};

export interface LocalDirectoryEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  lastModified?: number;
}

export interface LocalReadResult {
  path: string;
  content: string;
  totalLines: number;
  returnedLines: number;
  /** True when more lines remain below the returned window. */
  truncated: boolean;
}

export interface LocalWriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

export interface LocalSearchHit {
  path: string;
  line: number;
  text: string;
}

export interface LocalSearchResult {
  pattern: string;
  hits: LocalSearchHit[];
  filesScanned: number;
  bytesScanned: number;
  /** Files seen but not searched: over the read cap, binary, or unreadable. */
  filesSkipped: number;
  truncated: boolean;
  truncatedBy: 'hits' | 'files' | 'bytes' | null;
}

export interface LocalListResult {
  entries: LocalDirectoryEntry[];
  /** True when the listing stopped at the cap and more entries exist. */
  truncated: boolean;
  limit: number;
}

/** Longest hit line we echo back, so one minified file cannot flood the reply. */
const MAX_HIT_LINE_CHARS = 400;

function isDirectoryEntry(entry: unknown): entry is LocalDirectoryHandleLike {
  return (entry as { kind?: unknown } | null)?.kind === 'directory';
}

function isFileEntry(entry: unknown): entry is LocalFileHandleLike {
  return (entry as { kind?: unknown } | null)?.kind === 'file';
}

/**
 * Split a caller-supplied path into segments under the granted root. Throws
 * `invalid_path` for anything that could escape it or that the API cannot
 * address: absolute paths, drive letters, backslashes, `..`, empty segments,
 * and control characters.
 */
export function splitRelativePath(path: unknown): string[] {
  if (typeof path !== 'string') {
    throw new LocalDirectoryError('invalid_path', '`path` must be a string.');
  }
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '.') return [];
  if (trimmed.includes('\\')) {
    throw new LocalDirectoryError(
      'invalid_path',
      'Backslashes are not allowed; use forward slashes.',
    );
  }
  if (trimmed.startsWith('/')) {
    throw new LocalDirectoryError(
      'invalid_path',
      'Absolute paths are not allowed; paths are relative to the granted directory.',
    );
  }
  if (/^[a-zA-Z]:/.test(trimmed)) {
    throw new LocalDirectoryError(
      'invalid_path',
      'Windows drive paths are not allowed; paths are relative to the granted directory.',
    );
  }
  const segments: string[] = [];
  for (const raw of trimmed.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      throw new LocalDirectoryError(
        'invalid_path',
        '`..` is not allowed; paths must stay inside the granted directory.',
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(raw)) {
      throw new LocalDirectoryError(
        'invalid_path',
        'Control characters are not allowed in a path.',
      );
    }
    segments.push(raw);
  }
  return segments;
}

function toLocalDirectoryError(
  err: unknown,
  path: string,
): LocalDirectoryError {
  if (err instanceof LocalDirectoryError) return err;
  const name = (err as { name?: unknown })?.name;
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'NotFoundError') {
    return new LocalDirectoryError(
      'not_found',
      `No such file or directory: ${path}`,
    );
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new LocalDirectoryError(
      'permission_denied',
      `Permission denied for ${path} (${message}). The directory grant may have been revoked; reconnect it.`,
    );
  }
  if (name === 'TypeMismatchError') {
    return new LocalDirectoryError(
      'not_a_directory',
      `Not a directory: ${path}`,
    );
  }
  return new LocalDirectoryError('failed', `${path}: ${message}`);
}

export class LocalDirectory {
  constructor(
    private readonly root: LocalDirectoryHandleLike,
    private readonly limits: LocalDirectoryLimits = DEFAULT_LOCAL_DIRECTORY_LIMITS,
  ) {}

  /** Display name of the granted root (the directory's own name). */
  get name(): string {
    return this.root.name;
  }

  private async resolveDirectory(
    segments: readonly string[],
    path: string,
    create: boolean,
  ): Promise<LocalDirectoryHandleLike> {
    let dir = this.root;
    for (const segment of segments) {
      try {
        dir = await dir.getDirectoryHandle(segment, { create });
      } catch (err) {
        throw toLocalDirectoryError(err, path);
      }
    }
    return dir;
  }

  async list(path: string, limit?: number): Promise<LocalListResult> {
    const segments = splitRelativePath(path);
    const dir = await this.resolveDirectory(segments, path, false);
    // A non-positive or non-finite limit falls back to the default rather than
    // clamping to zero: a zero cap would report a non-empty directory as empty.
    const requested =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.trunc(limit)
        : this.limits.maxListEntries;
    const max = Math.min(requested, this.limits.maxListEntries);
    const entries: LocalDirectoryEntry[] = [];
    let truncated = false;
    for await (const entry of dir.values()) {
      if (entries.length >= max) {
        truncated = true;
        break;
      }
      if (isDirectoryEntry(entry)) {
        entries.push({
          name: entry.name,
          path: joinPath(segments, entry.name),
          kind: 'directory',
        });
      } else if (isFileEntry(entry)) {
        const entryPath = joinPath(segments, entry.name);
        // A file's size needs getFile(); report the entry without it rather
        // than failing the whole listing on one unreadable file.
        try {
          const file = await entry.getFile();
          entries.push({
            name: entry.name,
            path: entryPath,
            kind: 'file',
            size: file.size,
            lastModified: file.lastModified,
          });
        } catch {
          entries.push({ name: entry.name, path: entryPath, kind: 'file' });
        }
      }
    }
    // Code-unit order, not localeCompare: a listing the model reads must be
    // byte-stable across environments, and the default locale collation is not.
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Truncation is a field, not a synthetic entry: a fake "truncated" line
    // that looks like a directory invites the agent to list a path that does
    // not exist. The caller renders the note.
    return { entries, truncated, limit: max };
  }

  async read(
    path: string,
    offset = 0,
    limit?: number,
  ): Promise<LocalReadResult> {
    const segments = splitRelativePath(path);
    if (segments.length === 0) {
      throw new LocalDirectoryError('invalid_path', '`path` must name a file.');
    }
    const name = segments[segments.length - 1]!;
    const dir = await this.resolveDirectory(
      segments.slice(0, -1),
      dirnameOf(path),
      false,
    );
    let file: LocalFileLike;
    try {
      const handle = await dir.getFileHandle(name);
      file = await handle.getFile();
    } catch (err) {
      throw toLocalDirectoryError(err, path);
    }
    if (file.size > this.limits.maxReadBytes) {
      throw new LocalDirectoryError(
        'too_large',
        `${path} is ${file.size} bytes, over the ${this.limits.maxReadBytes}-byte read limit. Narrow the request or handle this file another way.`,
      );
    }
    let content: string;
    try {
      content = await file.text();
    } catch (err) {
      throw toLocalDirectoryError(err, path);
    }
    if (content.includes('\u0000')) {
      throw new LocalDirectoryError(
        'binary_content',
        `${path} looks like a binary file (NUL byte); it cannot be returned as text.`,
      );
    }
    const lines = content.split('\n');
    const start = Math.max(0, Math.trunc(offset) || 0);
    const count =
      limit === undefined || !Number.isFinite(limit) || limit <= 0
        ? lines.length
        : Math.trunc(limit);
    const window = lines.slice(start, start + count);
    return {
      path,
      content: window.join('\n'),
      totalLines: lines.length,
      returnedLines: window.length,
      truncated: start + window.length < lines.length,
    };
  }

  async write(path: string, content: string): Promise<LocalWriteResult> {
    const segments = splitRelativePath(path);
    if (segments.length === 0) {
      throw new LocalDirectoryError('invalid_path', '`path` must name a file.');
    }
    if (typeof content !== 'string') {
      throw new LocalDirectoryError(
        'invalid_path',
        '`content` must be a string.',
      );
    }
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > this.limits.maxWriteBytes) {
      throw new LocalDirectoryError(
        'too_large',
        `${path} would write ${bytes} bytes, over the ${this.limits.maxWriteBytes}-byte write limit.`,
      );
    }
    const name = segments[segments.length - 1]!;
    // Intermediate directories are created, matching the built-in write_file.
    const dir = await this.resolveDirectory(
      segments.slice(0, -1),
      dirnameOf(path),
      true,
    );
    let created = true;
    try {
      await dir.getFileHandle(name);
      created = false;
    } catch {
      // Absent — createWritable below creates it.
    }
    let writer: LocalFileWriterLike | undefined;
    try {
      const handle = await dir.getFileHandle(name, { create: true });
      writer = await handle.createWritable();
      await writer.write(content);
      await writer.close();
      writer = undefined;
      return { path, bytes, created };
    } catch (err) {
      throw toLocalDirectoryError(err, path);
    } finally {
      // A half-written file is worse than no file: never leave the stream open.
      await writer?.close().catch(() => {});
    }
  }

  /**
   * Literal substring search (case-sensitive) over text files. Not a regex:
   * a model-supplied pattern is untrusted input, and a literal scan has no
   * catastrophic-backtracking failure mode.
   */
  async search(
    pattern: string,
    options: { path?: string; maxFiles?: number; maxBytes?: number } = {},
  ): Promise<LocalSearchResult> {
    if (typeof pattern !== 'string' || pattern === '') {
      throw new LocalDirectoryError(
        'invalid_path',
        '`pattern` must be a non-empty string.',
      );
    }
    const segments = splitRelativePath(options.path ?? '');
    const root = await this.resolveDirectory(
      segments,
      options.path ?? '',
      false,
    );
    const maxFiles = Math.min(
      options.maxFiles ?? this.limits.maxSearchFiles,
      this.limits.maxSearchFiles,
    );
    const maxBytes = Math.min(
      options.maxBytes ?? this.limits.maxSearchBytes,
      this.limits.maxSearchBytes,
    );
    const hits: LocalSearchHit[] = [];
    let filesScanned = 0;
    let filesExamined = 0;
    let bytesScanned = 0;
    let filesSkipped = 0;
    let truncatedBy: LocalSearchResult['truncatedBy'] = null;

    // Breadth-first so a deep node_modules cannot starve the top of the tree.
    const queue: Array<{ dir: LocalDirectoryHandleLike; prefix: string[] }> = [
      { dir: root, prefix: segments },
    ];
    while (queue.length > 0 && truncatedBy === null) {
      const { dir, prefix } = queue.shift()!;
      for await (const entry of dir.values()) {
        if (truncatedBy !== null) break;
        if (isDirectoryEntry(entry)) {
          queue.push({ dir: entry, prefix: [...prefix, entry.name] });
          continue;
        }
        if (!isFileEntry(entry)) continue;
        if (filesExamined >= maxFiles) {
          truncatedBy = 'files';
          break;
        }
        const entryPath = joinPath(prefix, entry.name);
        let file: LocalFileLike;
        try {
          file = await entry.getFile();
        } catch {
          filesSkipped += 1;
          continue;
        }
        // filesExamined bounds the work (every getFile() costs a round trip),
        // including for files we then skip — otherwise a binary-heavy tree
        // would only be stopped by the byte budget.
        filesExamined += 1;
        // Skipped files are counted, not silently invisible: without this a
        // "no match" could mean "the only copy was a 4 MB bundle we never
        // opened", which would send the agent to the wrong conclusion.
        if (file.size > this.limits.maxReadBytes) {
          filesSkipped += 1;
          continue;
        }
        if (bytesScanned + file.size > maxBytes) {
          truncatedBy = 'bytes';
          break;
        }
        // bytesScanned is a budget account (the bytes really were pulled);
        // filesScanned counts only files actually searched, so it never
        // overlaps filesSkipped.
        bytesScanned += file.size;
        let content: string;
        try {
          content = await file.text();
        } catch {
          filesSkipped += 1;
          continue;
        }
        if (content.includes('\u0000')) {
          filesSkipped += 1;
          continue;
        }
        filesScanned += 1;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i]!;
          if (!text.includes(pattern)) continue;
          hits.push({
            path: entryPath,
            line: i + 1,
            text:
              text.length > MAX_HIT_LINE_CHARS
                ? `${text.slice(0, MAX_HIT_LINE_CHARS)}…`
                : text,
          });
          if (hits.length >= this.limits.maxSearchHits) {
            truncatedBy = 'hits';
            break;
          }
        }
      }
    }
    return {
      pattern,
      hits,
      filesScanned,
      bytesScanned,
      filesSkipped,
      truncated: truncatedBy !== null,
      truncatedBy,
    };
  }
}

function joinPath(segments: readonly string[], name: string): string {
  return segments.length === 0 ? name : `${segments.join('/')}/${name}`;
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '.' : path.slice(0, index);
}
