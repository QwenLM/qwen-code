/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Content } from '@google/genai';

import { acceptSpeculation, type SpeculationState } from './speculation.js';
import { OverlayFs } from './overlayFs.js';
import type { LlmClient } from '../core/client.js';

/**
 * `acceptSpeculation` is the only caller of `OverlayFs.applyToReal`, and the
 * ordering it guarantees -- files land before the tool results that claim they
 * landed are injected -- is what these tests pin.
 */
describe('acceptSpeculation', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  async function makeCwd(): Promise<string> {
    const dir = await mkdtemp(
      join(tmpdir(), `accept-spec-${randomUUID().slice(0, 8)}`),
    );
    dirs.push(dir);
    return dir;
  }

  function makeState(
    cwd: string,
    overlayFs: OverlayFs | null,
    messages: Content[] = [],
  ): SpeculationState {
    return {
      id: 'spec-1',
      status: 'boundary',
      suggestion: 'do a thing',
      overlayFs,
      abortController: null,
      messages,
      startTime: Date.now() - 5,
      toolUseCount: 1,
    };
  }

  function makeLlmClient(): {
    client: LlmClient;
    addHistory: ReturnType<typeof vi.fn>;
  } {
    const addHistory = vi.fn().mockResolvedValue(undefined);
    return { client: { addHistory } as unknown as LlmClient, addHistory };
  }

  it('injects history only after the files are on disk', async () => {
    const cwd = await makeCwd();
    const overlay = new OverlayFs(cwd);
    dirs.push(overlay.overlayDir);

    const realFile = join(cwd, 'src', 'app.ts');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(realFile, 'original');
    await writeFile(await overlay.redirectWrite(realFile), 'edited');

    // Reading the file from inside the hook is the ordering assertion: if
    // applyToReal had not run yet, this would still see the original content.
    const observed: string[] = [];
    const addHistory = vi.fn(async () => {
      observed.push(await readFile(realFile, 'utf-8'));
    });
    const state = makeState(cwd, overlay, [
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);

    const result = await acceptSpeculation(state, {
      addHistory,
    } as unknown as LlmClient);

    expect(observed).toEqual(['edited']);
    expect(result.filesApplied).toContain(realFile);
    expect(state.status).toBe('completed');
  });

  it('accepts a redirected path nothing was written to, and still injects history', async () => {
    const cwd = await makeCwd();
    const overlay = new OverlayFs(cwd);
    dirs.push(overlay.overlayDir);

    // Registered but never written: the speculative edit failed on this path.
    const neverWritten = join(cwd, 'brand-new.ts');
    await overlay.redirectWrite(neverWritten);

    const realFile = join(cwd, 'src', 'app.ts');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(realFile, 'original');
    await writeFile(await overlay.redirectWrite(realFile), 'edited');

    const { client, addHistory } = makeLlmClient();
    const state = makeState(cwd, overlay, [
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);

    const result = await acceptSpeculation(state, client);

    // The accept must not be rejected by an entry that has nothing behind it, or
    // the turn is re-run at full cost against a tree the genuine edit already reached.
    expect(result.filesApplied).toContain(realFile);
    expect(await readFile(realFile, 'utf-8')).toBe('edited');
    expect(existsSync(neverWritten)).toBe(false);
    expect(addHistory).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('completed');
  });

  it('cleans up the overlay even when applyToReal throws', async () => {
    const cwd = await makeCwd();
    const overlay = new OverlayFs(cwd);
    dirs.push(overlay.overlayDir);
    const overlayDir = overlay.overlayDir;

    // A genuine blocked copy: the overlay file exists, the real-side mkdir fails.
    await writeFile(join(cwd, 'blocker'), 'not a directory');
    const blocked = join(cwd, 'blocker', 'file.ts');
    await writeFile(await overlay.redirectWrite(blocked), 'blocked edit');

    const { client, addHistory } = makeLlmClient();
    const state = makeState(cwd, overlay, [
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);

    await expect(acceptSpeculation(state, client)).rejects.toThrow(/file\.ts/);

    // No history may be injected when the files did not land, and the overlay must
    // not be left behind for the next speculation to trip over.
    expect(addHistory).not.toHaveBeenCalled();
    expect(existsSync(overlayDir)).toBe(false);
    expect(state.status).not.toBe('completed');
  });
});
