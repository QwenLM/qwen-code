/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoadedSettings } from '../../config/settings.js';

const raceState = vi.hoisted(() => ({
  target: '',
  replacementText: '',
  enabled: false,
  swapped: false,
  mode: 'recreate' as 'recreate' | 'overwrite',
  oversizedReadText: '',
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync: vi.fn(
      (
        file: Parameters<typeof actual.openSync>[0],
        flags: Parameters<typeof actual.openSync>[1],
        mode?: Parameters<typeof actual.openSync>[2],
      ) => {
        if (
          raceState.enabled &&
          !raceState.swapped &&
          file === raceState.target
        ) {
          raceState.swapped = true;
          if (raceState.mode === 'recreate') {
            actual.rmSync(raceState.target);
          }
          actual.writeFileSync(raceState.target, raceState.replacementText);
        }
        return mode === undefined
          ? actual.openSync(file, flags)
          : actual.openSync(file, flags, mode);
      },
    ),
    readFileSync: vi.fn(
      (
        pathOrFd: Parameters<typeof actual.readFileSync>[0],
        options?: Parameters<typeof actual.readFileSync>[1],
      ) => {
        if (raceState.oversizedReadText && typeof pathOrFd === 'number') {
          return raceState.oversizedReadText;
        }
        return actual.readFileSync(pathOrFd, options);
      },
    ),
  };
});

function makeSettings(workspaceDir: string): LoadedSettings {
  return {
    isTrusted: true,
    workspace: {
      path: path.join(workspaceDir, '.qwen', 'settings.json'),
      settings: {},
    },
    merged: {},
  } as unknown as LoadedSettings;
}

describe('buildVoiceKeyterms race checks', () => {
  let workspaceDir = '';
  let buildVoiceKeyterms: typeof import('./voice-keyterms.js').buildVoiceKeyterms;

  beforeAll(async () => {
    ({ buildVoiceKeyterms } = await import('./voice-keyterms.js'));
  }, 20_000);

  afterEach(() => {
    raceState.target = '';
    raceState.replacementText = '';
    raceState.enabled = false;
    raceState.swapped = false;
    raceState.mode = 'recreate';
    raceState.oversizedReadText = '';
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = '';
  });

  it('does not read a keyterms file swapped in before open', async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-keyterms-'));
    const qwenDir = path.join(workspaceDir, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    const target = path.join(qwenDir, 'voice-keyterms.txt');
    fs.writeFileSync(target, 'SafeTerm\n');

    raceState.target = fs.realpathSync(target);
    raceState.replacementText = 'SwapSecret\n';
    raceState.enabled = true;

    const terms = buildVoiceKeyterms(makeSettings(workspaceDir));

    expect(raceState.swapped).toBe(true);
    expect(terms).not.toContain('SwapSecret');
    expect(terms).toContain('TypeScript'); // globals only
  });

  it('does not read a keyterms file rewritten in place before open', async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-keyterms-'));
    const qwenDir = path.join(workspaceDir, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    const target = path.join(qwenDir, 'voice-keyterms.txt');
    fs.writeFileSync(target, 'SafeTerm\n');
    fs.utimesSync(target, new Date(0), new Date(0));

    raceState.target = fs.realpathSync(target);
    raceState.replacementText = 'EvilTermWithDifferentSize\n';
    raceState.enabled = true;
    raceState.mode = 'overwrite';

    const terms = buildVoiceKeyterms(makeSettings(workspaceDir));

    expect(raceState.swapped).toBe(true);
    expect(terms).not.toContain('EvilTermWithDifferentSize');
    expect(terms).toContain('TypeScript'); // globals only
  });

  it('does not read content larger than the file size cap after open', async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-keyterms-'));
    const qwenDir = path.join(workspaceDir, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    const target = path.join(qwenDir, 'voice-keyterms.txt');
    fs.writeFileSync(target, 'Small\n');

    raceState.oversizedReadText = `HugeTermMarker\n${'x'.repeat(64 * 1024)}`;

    const terms = buildVoiceKeyterms(makeSettings(workspaceDir));

    expect(terms).not.toContain('HugeTermMarker');
    expect(terms).toContain('TypeScript'); // globals only
  });
});
