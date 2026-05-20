/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockSpawnSync, mockGetExternalEditorCommand } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn().mockReturnValue({ status: 0, error: null }),
  mockGetExternalEditorCommand: vi.fn().mockReturnValue(null),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Named re-exports must be spelled out for vitest ESM mocking to rebind them.
  return {
    ...actual,
    default: { ...actual, spawnSync: mockSpawnSync },
    spawnSync: mockSpawnSync,
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: { ...(actual['default'] as object), tmpdir: () => '/tmp' },
    tmpdir: () => '/tmp',
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocks = {
    mkdtempSync: vi.fn().mockReturnValue('/tmp/qwen-edit-mock'),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('edited text'),
    rmSync: vi.fn(),
  };
  return {
    ...actual,
    ...mocks,
    default: { ...(actual['default'] as object), ...mocks },
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    getExternalEditorCommand: mockGetExternalEditorCommand,
  };
});

import fs from 'node:fs';
import pathMod from 'node:path';
import { useTextBuffer } from './text-buffer.js';

const viewport = { height: 5, width: 40 };
const expectedTmpFile = pathMod.join('/tmp/qwen-edit-mock', 'buffer.txt');

describe('openInExternalEditor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (fs.mkdtempSync as Mock).mockReturnValue('/tmp/qwen-edit-mock');
    (fs.writeFileSync as Mock).mockImplementation(() => {});
    (fs.readFileSync as Mock).mockReturnValue('edited text');
    (fs.rmSync as Mock).mockImplementation(() => {});
    mockSpawnSync.mockReturnValue({ status: 0, error: null });
    mockGetExternalEditorCommand.mockReturnValue(null);
  });

  it('should create temp file in private mkdtemp directory', async () => {
    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(fs.mkdtempSync).toHaveBeenCalledWith(
      expect.stringContaining('qwen-edit-'),
    );
    const writePath = (fs.writeFileSync as Mock).mock.calls[0]?.[0] as string;
    expect(writePath).toBe(expectedTmpFile);
  });

  it('should write temp file with mode 0o600', async () => {
    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    const writeOpts = (fs.writeFileSync as Mock).mock.calls[0]?.[2] as {
      mode?: number;
    };
    expect(writeOpts).toEqual(expect.objectContaining({ mode: 0o600 }));
  });

  it('should clean up temp file even when editor fails', async () => {
    mockSpawnSync.mockReturnValue({ status: 1, error: null });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(fs.rmSync).toHaveBeenCalled();
  });

  it('should clean up temp file when writeFileSync throws', async () => {
    (fs.writeFileSync as Mock).mockImplementation(() => {
      throw new Error('disk full');
    });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(fs.rmSync).toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('should fall back to env/default when no preferredEditor', async () => {
    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(mockGetExternalEditorCommand).not.toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringMatching(/\.txt$/)]),
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('should use getExternalEditorCommand when preferredEditor is set', async () => {
    mockGetExternalEditorCommand.mockReturnValue({
      command: 'code',
      args: [expectedTmpFile, '--wait'],
      needsShell: false,
    });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
        preferredEditor: 'vscode',
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(mockGetExternalEditorCommand).toHaveBeenCalledWith(
      'vscode',
      expect.stringMatching(/\.txt$/),
    );
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'code',
      expect.arrayContaining(['--wait']),
      expect.objectContaining({ shell: false }),
    );
  });

  it('should quote args when needsShell is true', async () => {
    mockGetExternalEditorCommand.mockReturnValue({
      command: 'code.cmd',
      args: [expectedTmpFile, '--wait'],
      needsShell: true,
    });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
        preferredEditor: 'vscode',
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    const spawnCmd = mockSpawnSync.mock.calls[0]?.[0] as string;
    expect(spawnCmd).toBe('"code.cmd"');
    const spawnArgs = mockSpawnSync.mock.calls[0]?.[1] as string[];
    for (const arg of spawnArgs) {
      expect(arg).toMatch(/^".*"$/);
    }
    expect(mockSpawnSync.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ shell: true }),
    );
  });

  it('should fall back to env/default when preferredEditor is set but not found', async () => {
    mockGetExternalEditorCommand.mockReturnValue(null);

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
        preferredEditor: 'vscode',
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(mockGetExternalEditorCommand).toHaveBeenCalledWith(
      'vscode',
      expect.stringMatching(/\.txt$/),
    );
    expect(mockSpawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringMatching(/\.txt$/)]),
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('should clean up temp file when spawnSync returns error object', async () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      error: new Error('ENOENT'),
    });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(fs.rmSync).toHaveBeenCalled();
    expect(result.current.text).toBe('hello');
  });

  it('should respect VISUAL > EDITOR > default fallback order', async () => {
    const origVISUAL = process.env['VISUAL'];
    const origEDITOR = process.env['EDITOR'];

    process.env['VISUAL'] = 'my-visual-editor';
    process.env['EDITOR'] = 'my-editor';
    try {
      const { result } = renderHook(() =>
        useTextBuffer({
          initialText: 'hello',
          viewport,
          isValidPath: () => false,
        }),
      );

      await act(async () => {
        await result.current.openInExternalEditor();
      });

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'my-visual-editor',
        expect.any(Array),
        expect.any(Object),
      );
    } finally {
      if (origVISUAL === undefined) delete process.env['VISUAL'];
      else process.env['VISUAL'] = origVISUAL;
      if (origEDITOR === undefined) delete process.env['EDITOR'];
      else process.env['EDITOR'] = origEDITOR;
    }
  });

  it('should fall back to EDITOR when VISUAL is not set', async () => {
    const origVISUAL = process.env['VISUAL'];
    const origEDITOR = process.env['EDITOR'];

    delete process.env['VISUAL'];
    process.env['EDITOR'] = 'my-editor';
    try {
      const { result } = renderHook(() =>
        useTextBuffer({
          initialText: 'hello',
          viewport,
          isValidPath: () => false,
        }),
      );

      await act(async () => {
        await result.current.openInExternalEditor();
      });

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'my-editor',
        expect.any(Array),
        expect.any(Object),
      );
    } finally {
      if (origVISUAL === undefined) delete process.env['VISUAL'];
      else process.env['VISUAL'] = origVISUAL;
      if (origEDITOR === undefined) delete process.env['EDITOR'];
      else process.env['EDITOR'] = origEDITOR;
    }
  });

  it('should detect .cmd/.bat in env-var fallback and enable shell mode on Windows', async () => {
    const origPlatform = process.platform;
    const origVISUAL = process.env['VISUAL'];
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['VISUAL'] = 'code.cmd';

    try {
      const { result } = renderHook(() =>
        useTextBuffer({
          initialText: 'hello',
          viewport,
          isValidPath: () => false,
        }),
      );

      await act(async () => {
        await result.current.openInExternalEditor();
      });

      expect(mockSpawnSync).toHaveBeenCalledWith(
        '"code.cmd"',
        expect.arrayContaining([expect.stringMatching(/^".*"$/)]),
        expect.objectContaining({ shell: true }),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      if (origVISUAL === undefined) delete process.env['VISUAL'];
      else process.env['VISUAL'] = origVISUAL;
    }
  });

  it('should pass timeout to spawnSync', async () => {
    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(mockSpawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeout: 30 * 60 * 1000 }),
    );
  });

  it('should update text after successful editor session', async () => {
    (fs.readFileSync as Mock).mockReturnValue('new content');

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'old content',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(result.current.text).toBe('new content');
  });

  it('should not read temp file when editor is killed by signal', async () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      error: null,
      signal: 'SIGKILL',
    });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'original',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(result.current.text).toBe('original');
  });

  it('should not create undo snapshot when editor fails — undo is no-op', async () => {
    mockSpawnSync.mockReturnValue({ status: 1, error: null });
    (fs.readFileSync as Mock).mockReturnValue('should not see this');

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'original',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(result.current.text).toBe('original');

    act(() => {
      result.current.undo();
    });
    expect(result.current.text).toBe('original');
  });

  it('should skip undo snapshot when content is unchanged', async () => {
    (fs.readFileSync as Mock).mockReturnValue('unchanged');

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'unchanged',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(result.current.text).toBe('unchanged');

    act(() => {
      result.current.undo();
    });
    expect(result.current.text).toBe('unchanged');
  });

  it('should undo to pre-editor content after successful edit', async () => {
    (fs.readFileSync as Mock).mockReturnValue('new content');

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'old content',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(result.current.text).toBe('new content');

    act(() => {
      result.current.undo();
    });
    expect(result.current.text).toBe('old content');
  });

  it('should clean up tmpDir and file in finally', async () => {
    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(fs.rmSync).toHaveBeenCalledWith('/tmp/qwen-edit-mock', {
      recursive: true,
      force: true,
    });
  });

  it('should normalize CRLF to LF in editor output', async () => {
    (fs.readFileSync as Mock).mockReturnValue('line1\r\nline2\rline3\nline4');

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'original',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(result.current.text).toBe('line1\nline2\nline3\nline4');
  });

  it('should keep buffer unchanged when readFileSync throws', async () => {
    (fs.readFileSync as Mock).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'original',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(result.current.text).toBe('original');
    expect(fs.rmSync).toHaveBeenCalled();
  });

  it('should not propagate when rmSync cleanup throws (e.g. EPERM)', async () => {
    (fs.rmSync as Mock).mockImplementation(() => {
      throw new Error('EPERM');
    });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(fs.rmSync).toHaveBeenCalledWith('/tmp/qwen-edit-mock', {
      recursive: true,
      force: true,
    });
    expect(result.current.text).toBe('edited text');
  });

  it('should abort gracefully when mkdtempSync fails', async () => {
    (fs.mkdtempSync as Mock).mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'original',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(result.current.text).toBe('original');
  });

  it('should quote editorCmd and args with shell:true when shell mode is enabled', async () => {
    const origPlatform = process.platform;
    const origVISUAL = process.env['VISUAL'];
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['VISUAL'] = 'C:\\Program Files\\Code\\code.cmd';

    try {
      const { result } = renderHook(() =>
        useTextBuffer({
          initialText: 'hello',
          viewport,
          isValidPath: () => false,
        }),
      );

      await act(async () => {
        await result.current.openInExternalEditor();
      });

      expect(mockSpawnSync).toHaveBeenCalledWith(
        '"C:\\Program Files\\Code\\code.cmd"',
        expect.arrayContaining([expect.stringMatching(/^".*"$/)]),
        expect.objectContaining({ shell: true }),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      if (origVISUAL === undefined) delete process.env['VISUAL'];
      else process.env['VISUAL'] = origVISUAL;
    }
  });

  it('should use opts.editor when provided', async () => {
    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor({ editor: 'nano' });
    });

    expect(mockGetExternalEditorCommand).not.toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'nano',
      expect.arrayContaining([expect.stringMatching(/\.txt$/)]),
      expect.objectContaining({ stdio: 'inherit', shell: false }),
    );
  });

  it('should enable shell mode for .cmd opts.editor on Windows', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const { result } = renderHook(() =>
        useTextBuffer({
          initialText: 'hello',
          viewport,
          isValidPath: () => false,
        }),
      );

      await act(async () => {
        await result.current.openInExternalEditor({ editor: 'C:\\editor.cmd' });
      });

      expect(mockSpawnSync).toHaveBeenCalledWith(
        '"C:\\editor.cmd"',
        expect.arrayContaining([expect.stringMatching(/^".*"$/)]),
        expect.objectContaining({ shell: true }),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it.each([
    { char: '"', editor: 'evil"|cmd.cmd' },
    { char: '%', editor: 'expand%PATH%.cmd' },
    { char: '!', editor: 'delayed!var!.cmd' },
  ])(
    'should reject opts.editor with unsafe "$char" on Windows',
    async ({ editor }) => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      try {
        const { result } = renderHook(() =>
          useTextBuffer({
            initialText: 'hello',
            viewport,
            isValidPath: () => false,
          }),
        );

        await act(async () => {
          await result.current.openInExternalEditor({ editor });
        });

        expect(mockSpawnSync).not.toHaveBeenCalled();
        expect(result.current.text).toBe('hello');
        expect(fs.rmSync).toHaveBeenCalledWith('/tmp/qwen-edit-mock', {
          recursive: true,
          force: true,
        });
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    },
  );

  it('should disable and restore raw mode around editor session', async () => {
    const mockSetRawMode = vi.fn();
    const mockStdin = { isRaw: true } as unknown as NodeJS.ReadStream;

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
        stdin: mockStdin,
        setRawMode: mockSetRawMode,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(mockSetRawMode).toHaveBeenCalledWith(false);
    expect(mockSetRawMode).toHaveBeenCalledWith(true);
    const falseIdx = mockSetRawMode.mock.calls.findIndex((c) => c[0] === false);
    const trueIdx = mockSetRawMode.mock.calls.findIndex((c) => c[0] === true);
    expect(falseIdx).toBeLessThan(trueIdx);
  });

  it('should restore raw mode even when editor fails', async () => {
    const mockSetRawMode = vi.fn();
    const mockStdin = { isRaw: true } as unknown as NodeJS.ReadStream;
    mockSpawnSync.mockReturnValueOnce({ status: 1, error: null, signal: null });

    const { result } = renderHook(() =>
      useTextBuffer({
        initialText: 'hello',
        viewport,
        isValidPath: () => false,
        stdin: mockStdin,
        setRawMode: mockSetRawMode,
      }),
    );

    await act(async () => {
      await result.current.openInExternalEditor();
    });

    expect(mockSetRawMode).toHaveBeenCalledWith(false);
    expect(mockSetRawMode).toHaveBeenCalledWith(true);
    const falseIdx = mockSetRawMode.mock.calls.findIndex((c) => c[0] === false);
    const trueIdx = mockSetRawMode.mock.calls.findIndex((c) => c[0] === true);
    expect(falseIdx).toBeLessThan(trueIdx);
    expect(result.current.text).toBe('hello');
  });

  it('should fall back to vi when VISUAL and EDITOR are unset on non-Windows', async () => {
    const origPlatform = process.platform;
    const origVISUAL = process.env['VISUAL'];
    const origEDITOR = process.env['EDITOR'];
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env['VISUAL'];
    delete process.env['EDITOR'];

    try {
      const { result } = renderHook(() =>
        useTextBuffer({
          initialText: 'hello',
          viewport,
          isValidPath: () => false,
        }),
      );

      await act(async () => {
        await result.current.openInExternalEditor();
      });

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'vi',
        expect.arrayContaining([expect.stringMatching(/\.txt$/)]),
        expect.objectContaining({ stdio: 'inherit' }),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      if (origVISUAL === undefined) delete process.env['VISUAL'];
      else process.env['VISUAL'] = origVISUAL;
      if (origEDITOR === undefined) delete process.env['EDITOR'];
      else process.env['EDITOR'] = origEDITOR;
    }
  });

  it('should fall back to notepad when VISUAL and EDITOR are unset on Windows', async () => {
    const origPlatform = process.platform;
    const origVISUAL = process.env['VISUAL'];
    const origEDITOR = process.env['EDITOR'];
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['VISUAL'];
    delete process.env['EDITOR'];

    try {
      const { result } = renderHook(() =>
        useTextBuffer({
          initialText: 'hello',
          viewport,
          isValidPath: () => false,
        }),
      );

      await act(async () => {
        await result.current.openInExternalEditor();
      });

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'notepad',
        expect.arrayContaining([expect.stringMatching(/\.txt$/)]),
        expect.objectContaining({ stdio: 'inherit' }),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      if (origVISUAL === undefined) delete process.env['VISUAL'];
      else process.env['VISUAL'] = origVISUAL;
      if (origEDITOR === undefined) delete process.env['EDITOR'];
      else process.env['EDITOR'] = origEDITOR;
    }
  });

  it.each([
    { char: '"', env: 'evil"cmd.cmd' },
    { char: '%', env: 'expand%PATH%.cmd' },
    { char: '!', env: 'delayed!var!.cmd' },
  ])(
    'should reject env-var .cmd with unsafe "$char" on Windows',
    async ({ env }) => {
      const origPlatform = process.platform;
      const origVISUAL = process.env['VISUAL'];
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env['VISUAL'] = env;

      try {
        const { result } = renderHook(() =>
          useTextBuffer({
            initialText: 'hello',
            viewport,
            isValidPath: () => false,
          }),
        );

        await act(async () => {
          await result.current.openInExternalEditor();
        });

        expect(mockSpawnSync).not.toHaveBeenCalled();
        expect(result.current.text).toBe('hello');
        expect(fs.rmSync).toHaveBeenCalledWith('/tmp/qwen-edit-mock', {
          recursive: true,
          force: true,
        });
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
        if (origVISUAL === undefined) delete process.env['VISUAL'];
        else process.env['VISUAL'] = origVISUAL;
      }
    },
  );
});
