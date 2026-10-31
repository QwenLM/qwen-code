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
  QQ_OUTBOUND_IMAGE_MAX_BYTES,
  QQ_OUTBOUND_VIDEO_MAX_BYTES,
  QQ_OUTBOUND_VOICE_MAX_BYTES,
  buildFileTools,
  readOutboundFile,
  type QQFileToolDeps,
  type QQMediaKind,
} from './file-tools.js';

// A real file outside both the session workspace and the system temporary
// directory. It must exist on the platform running these tests — the macOS and
// Windows lanes would otherwise fail on a missing path before the boundary
// check gets a chance to refuse it.
const OUTSIDE_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';

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
    expect(() => readOutboundFile(OUTSIDE_PATH, workspace)).toThrow(
      /outside the session workspace/,
    );
  });

  it('rejects a symlink that escapes the workspace', () => {
    const link = join(workspace, 'escape.txt');
    symlinkSync(OUTSIDE_PATH, link);

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
    kind: QQMediaKind;
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
      sendMedia: async (input) => {
        sent.push(input);
        return result;
      },
      log: (message) => logs.push(message),
      ...overrides,
    };
    const tools = buildFileTools(deps);
    const tool = tools[0]!;
    const byName = (name: string) => {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`${name} was not registered`);
      return found;
    };
    const call = (args: Record<string, unknown>, sessionId = 'S1') =>
      tool.handler(args, { sessionId });
    const callTool = (
      name: string,
      args: Record<string, unknown>,
      sessionId = 'S1',
    ) => byName(name).handler(args, { sessionId });
    return { tool, tools, call, callTool, sent, logs };
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

  it('exposes the four media tools, with file_name only on qq_send_file', () => {
    const { tools } = harness();

    expect(tools.map((entry) => entry.name)).toEqual([
      'qq_send_file',
      'qq_send_image',
      'qq_send_video',
      'qq_send_voice',
    ]);
    for (const entry of tools) {
      expect(entry.inputSchema['required']).toEqual(['path']);
    }
    expect(tools[0]!.inputSchema['properties']).toHaveProperty('file_name');
    for (const entry of tools.slice(1)) {
      expect(entry.inputSchema['properties']).not.toHaveProperty('file_name');
    }
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
    expect(sent[0]!.kind).toBe('file');
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

    const result = await call({ path: OUTSIDE_PATH });

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

    const result = await call({ path: OUTSIDE_PATH });

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

  // --- image / video / voice -------------------------------------------------

  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('body'),
  ]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const MP4 = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.alloc(8),
  ]);
  const SILK = Buffer.from('#!SILK_V3payload');
  const SILK_WITH_FORMAT_BYTE = Buffer.from('\x02#!SILK_V3payload');
  const MP3 = Buffer.from('ID3\x04\x00payload');
  const WAV = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WAVEfmt '),
  ]);
  const OGG = Buffer.from('OggS\x00\x02payload');

  /** Report a size the real file does not have, without writing it to disk. */
  function reportSize(size: number): void {
    const real = fsHooks.realFstatSync!;
    fsHooks.fstatSync.mockImplementationOnce(((fd: number) => {
      const stat = real(fd);
      // Keep the Stats prototype: spreading drops isFile() and friends.
      return Object.assign(
        Object.create(Object.getPrototypeOf(stat)) as object,
        stat,
        { size },
      );
    }) as never);
  }

  it('sends a PNG as an image', async () => {
    const path = join(workspace, 'chart.png');
    writeFileSync(path, PNG);
    const { callTool, sent } = harness();

    const result = await callTool('qq_send_image', { path });

    expect(isError(result)).toBe(false);
    expect(textOf(result)).toBe('Image sent (chart.png).');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('image');
    expect(sent[0]!.bytes.toString('latin1', 0, 4)).toBe('\x89PNG');
  });

  it('sends a JPEG as an image', async () => {
    const path = join(workspace, 'photo.jpg');
    writeFileSync(path, JPEG);
    const { callTool } = harness();

    const result = await callTool('qq_send_image', { path });

    expect(isError(result)).toBe(false);
    expect(textOf(result)).toBe('Image sent (photo.jpg).');
  });

  it('rejects a GIF as an image and points at qq_send_file', async () => {
    const path = join(workspace, 'page.gif');
    writeFileSync(path, Buffer.from('GIF89a-payload'));
    const { callTool, sent } = harness();

    const result = await callTool('qq_send_image', { path });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('qq_send_image:');
    expect(textOf(result)).toContain('PNG or JPEG');
    expect(textOf(result)).toContain('qq_send_file');
    expect(sent).toHaveLength(0);
  });

  it('sends an MP4 as a video', async () => {
    const path = join(workspace, 'clip.mp4');
    writeFileSync(path, MP4);
    const { callTool, sent } = harness();

    const result = await callTool('qq_send_video', { path });

    expect(isError(result)).toBe(false);
    expect(textOf(result)).toBe('Video sent (clip.mp4).');
    expect(sent[0]!.kind).toBe('video');
  });

  it('rejects a non-MP4 file as a video', async () => {
    const path = join(workspace, 'clip.webm');
    writeFileSync(path, Buffer.from('webm-payload'));
    const { callTool, sent } = harness();

    const result = await callTool('qq_send_video', { path });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('an MP4 video');
    expect(sent).toHaveLength(0);
  });

  it('sends SILK, MP3, WAV and OGG as voice', async () => {
    const samples: Array<[string, Buffer]> = [
      ['a.silk', SILK],
      ['b.silk', SILK_WITH_FORMAT_BYTE],
      ['c.mp3', MP3],
      ['d.wav', WAV],
      ['e.ogg', OGG],
    ];

    for (const [name, bytes] of samples) {
      const path = join(workspace, name);
      writeFileSync(path, bytes);
      const { callTool, sent } = harness();

      const result = await callTool('qq_send_voice', { path });

      expect(isError(result)).toBe(false);
      expect(textOf(result)).toBe(`Voice sent (${name}).`);
      expect(sent[0]!.kind).toBe('voice');
    }
  });

  it('rejects a text file as voice', async () => {
    const path = join(workspace, 'notes.txt');
    writeFileSync(path, 'not audio');
    const { callTool, sent } = harness();

    const result = await callTool('qq_send_voice', { path });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('SILK, MP3, WAV or OGG');
    expect(sent).toHaveLength(0);
  });

  it('rejects an image above the platform soft limit', () => {
    const path = join(workspace, 'big.png');
    writeFileSync(path, PNG);
    reportSize(QQ_OUTBOUND_IMAGE_MAX_BYTES + 1);

    expect(() => readOutboundFile(path, workspace, 'image')).toThrow(
      /larger than 20 MB/,
    );
  });

  it('rejects a video above the platform soft limit', () => {
    const path = join(workspace, 'big.mp4');
    writeFileSync(path, MP4);
    reportSize(QQ_OUTBOUND_VIDEO_MAX_BYTES + 1);

    expect(() => readOutboundFile(path, workspace, 'video')).toThrow(
      /larger than 30 MB/,
    );
  });

  it('rejects a voice message above the platform soft limit', () => {
    const path = join(workspace, 'big.wav');
    writeFileSync(path, WAV);
    reportSize(QQ_OUTBOUND_VOICE_MAX_BYTES + 1);

    expect(() => readOutboundFile(path, workspace, 'voice')).toThrow(
      /larger than 20 MB/,
    );
  });
});
