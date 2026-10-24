import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  constants,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QQ_OUTBOUND_FILE_MAX_BYTES,
  buildFileTools,
  readOutboundFile,
  type QQFileToolDeps,
} from './file-tools.js';

// Two guards are only observable through the descriptor the module opens, so
// node:fs is partially mocked: the wrappers delegate to the real functions
// unless a test replaces them.
const fsHooks = vi.hoisted(() => ({
  realOpenSync: undefined as typeof import('node:fs').openSync | undefined,
  realFstatSync: undefined as typeof import('node:fs').fstatSync | undefined,
  openSync: vi.fn(),
  fstatSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsHooks.realOpenSync = actual.openSync;
  fsHooks.realFstatSync = actual.fstatSync;
  return {
    ...actual,
    openSync: fsHooks.openSync,
    fstatSync: fsHooks.fstatSync,
  };
});

beforeEach(() => {
  fsHooks.openSync.mockReset();
  fsHooks.openSync.mockImplementation(fsHooks.realOpenSync as never);
  fsHooks.fstatSync.mockReset();
  fsHooks.fstatSync.mockImplementation(fsHooks.realFstatSync as never);
});

describe('readOutboundFile', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qq-file-tools-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a file inside the session workspace', () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'hello');

    const file = readOutboundFile(path, workspace);

    expect(file.bytes.toString()).toBe('hello');
    expect(file.fileName).toBe('report.txt');
  });

  it('reads a file under the system temporary directory', () => {
    const path = join(root, 'outside-workspace.txt');
    writeFileSync(path, 'tmp');

    // root is a mkdtemp under tmpdir(), so it is inside the second root.
    const file = readOutboundFile(path, workspace);

    expect(file.bytes.toString()).toBe('tmp');
  });

  it('rejects a relative path', () => {
    expect(() => readOutboundFile('report.txt', workspace)).toThrow(
      /must be absolute/,
    );
  });

  it('rejects a path outside the workspace and the temporary directory', () => {
    expect(() => readOutboundFile('/etc/hostname', workspace)).toThrow(
      /outside the session workspace/,
    );
  });

  it('rejects a symlink that escapes the workspace', () => {
    const link = join(workspace, 'escape.txt');
    symlinkSync('/etc/hostname', link);

    // realpath resolves the link before the root check, so the escape is caught
    // even though the link itself sits inside the workspace.
    expect(() => readOutboundFile(link, workspace)).toThrow(
      /outside the session workspace/,
    );
  });

  it('rejects a directory', () => {
    expect(() => readOutboundFile(workspace, workspace)).toThrow(
      /not a regular file/,
    );
  });

  it('rejects an empty file', () => {
    const path = join(workspace, 'empty.txt');
    writeFileSync(path, '');

    expect(() => readOutboundFile(path, workspace)).toThrow(/is empty/);
  });

  it('rejects a missing file', () => {
    expect(() =>
      readOutboundFile(join(workspace, 'nope.txt'), workspace),
    ).toThrow(/does not exist/);
  });

  it('rejects a file with more than one hard link', () => {
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'linked bytes');
    const link = join(workspace, 'leak.txt');
    linkSync(outside, link);

    // A hard link has no target for realpath to resolve, so the path check
    // alone would read the linked contents; the link count is the guard.
    expect(() => readOutboundFile(link, workspace)).toThrow(
      /more than one hard link/,
    );
  });

  it('opens with O_NOFOLLOW and O_NONBLOCK', () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'hello');

    readOutboundFile(path, workspace);

    expect(fsHooks.openSync).toHaveBeenCalledTimes(1);
    const flags = fsHooks.openSync.mock.calls[0]![1] as number;
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  });

  it('reports a file rewritten between the two stat calls', () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'hello');
    const real = fsHooks.realFstatSync!;
    fsHooks.fstatSync
      .mockImplementationOnce(real as never)
      .mockImplementationOnce(((fd: number) => {
        const stat = real(fd);
        return { ...stat, mtimeMs: stat.mtimeMs + 1 };
      }) as never);

    expect(() => readOutboundFile(path, workspace)).toThrow(
      /changed while it was being read/,
    );
  });

  it('rejects a file above the size cap', () => {
    const path = join(workspace, 'big.bin');
    writeFileSync(path, Buffer.alloc(QQ_OUTBOUND_FILE_MAX_BYTES + 1));

    expect(() => readOutboundFile(path, workspace)).toThrow(
      /larger than 20 MiB/,
    );
  });

  it('accepts a file at exactly the size cap', () => {
    const path = join(workspace, 'cap.bin');
    writeFileSync(path, Buffer.alloc(QQ_OUTBOUND_FILE_MAX_BYTES));

    expect(readOutboundFile(path, workspace).bytes.length).toBe(
      QQ_OUTBOUND_FILE_MAX_BYTES,
    );
  });

  it('still allows the temporary directory when the workspace is unknown', () => {
    const path = join(root, 'no-workspace.txt');
    writeFileSync(path, 'x');

    expect(readOutboundFile(path, undefined).bytes.toString()).toBe('x');
  });
});

describe('buildFileTools', () => {
  let root: string;
  let workspace: string;

  interface Sent {
    sessionId: string;
    chatId: string;
    fileName: string;
    bytes: Buffer;
  }

  function harness(
    overrides: Partial<QQFileToolDeps> = {},
    result: { ok: true } | { ok: false; message: string } = { ok: true },
  ) {
    const sent: Sent[] = [];
    const logs: string[] = [];
    const deps: QQFileToolDeps = {
      resolveChat: () => ({ chatId: 'CHAT' }),
      sessionCwd: () => workspace,
      sendFile: async (input) => {
        sent.push(input);
        return result;
      },
      log: (message) => logs.push(message),
      ...overrides,
    };
    const tools = buildFileTools(deps);
    const tool = tools[0]!;
    const call = (args: Record<string, unknown>, sessionId = 'S1') =>
      tool.handler(args, { sessionId });
    return { tool, call, sent, logs };
  }

  function textOf(value: unknown): string {
    return typeof value === 'string' ? value : (value as { text: string }).text;
  }

  function isError(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { isError?: boolean }).isError === true
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qq-file-tool-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exposes exactly one tool named qq_send_file', () => {
    const { tool } = harness();

    expect(tool.name).toBe('qq_send_file');
    expect(tool.inputSchema['required']).toEqual(['path']);
  });

  it('sends the file bytes with its own name', async () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'payload');
    const { call, sent } = harness();

    const result = await call({ path });

    expect(isError(result)).toBe(false);
    expect(textOf(result)).toBe('File sent (report.txt).');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe('CHAT');
    expect(sent[0]!.fileName).toBe('report.txt');
    expect(sent[0]!.bytes.toString()).toBe('payload');
  });

  it('uses a sanitized display name when one is given', async () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'payload');
    const { call, sent } = harness();

    await call({ path, file_name: '../evil/name.txt' });

    expect(sent[0]!.fileName).toBe('..evilname.txt');
    expect(sent[0]!.fileName).not.toContain('/');
  });

  it('truncates a display name by code point, not by UTF-16 unit', async () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'payload');
    const { call, sent } = harness();

    await call({ path, file_name: `${'a'.repeat(100)}😀` });

    expect(sent[0]!.fileName).toBe('a'.repeat(100));
    expect([...sent[0]!.fileName]).toHaveLength(100);
    // A UTF-16 slice would leave a lone high surrogate at the end.
    expect(sent[0]!.fileName).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('strips bidi overrides from a display name', async () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'payload');
    const { call, sent } = harness();

    await call({ path, file_name: 'invoice\u202Egnp.exe\u200F' });

    expect(sent[0]!.fileName).toBe('invoicegnp.exe');
  });

  it('strips a lone surrogate from a display name', async () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'payload');
    const { call, sent } = harness();

    await call({ path, file_name: 'report\uD83D.txt' });

    expect(sent[0]!.fileName).toBe('report.txt');
  });

  it('fails as a tool result when no chat is bound', async () => {
    const { call, sent } = harness({ resolveChat: () => undefined });

    const result = await call({ path: '/etc/hostname' });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('No QQ chat is bound');
    expect(sent).toHaveLength(0);
  });

  it('fails as a tool result when path is missing', async () => {
    const { call, sent } = harness();

    const result = await call({});

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('path is required');
    expect(sent).toHaveLength(0);
  });

  it('fails as a tool result when the path escapes the workspace', async () => {
    const { call, sent } = harness();

    const result = await call({ path: '/etc/hostname' });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('outside the session workspace');
    expect(sent).toHaveLength(0);
  });

  it('reports a send failure from the adapter', async () => {
    const path = join(workspace, 'report.txt');
    writeFileSync(path, 'payload');
    const { call, logs } = harness({}, { ok: false, message: 'upload failed' });

    const result = await call({ path });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toBe('upload failed');
    expect(logs.some((line) => line.includes('upload failed'))).toBe(true);
  });
});
