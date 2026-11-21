/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../config/settings.js';

const { openQwenRealtimeSession } = vi.hoisted(() => ({
  openQwenRealtimeSession: vi.fn(async (_config: unknown) => ({
    close: vi.fn(),
  })),
}));

vi.mock('./qwen-realtime-session.js', () => ({ openQwenRealtimeSession }));

const { LiveSetupController } = await import('./live-setup-controller.js');

describe('LiveSetupController default credential validation', () => {
  it('opens the setup probe with the resolved turn detection mode', async () => {
    let enabled = false;
    let settings = {
      experimental: {
        liveVoice: { enabled: false, apiKey: 'realtime-secret' },
      },
    } as unknown as Settings;
    const controller = new LiveSetupController({
      loadSettings: () => settings,
      persistSettings: vi.fn(async (writes) => {
        const liveVoice: Record<string, unknown> = {
          ...settings.experimental?.liveVoice,
        };
        for (const write of writes) {
          liveVoice[write.key.split('.').at(-1)!] = write.value;
        }
        settings = { experimental: { liveVoice } } as unknown as Settings;
      }),
      coordinator: {
        getStatus: () => ({}),
        setShortcut: vi.fn(),
        setConfiguredShortcut: vi.fn(),
      } as never,
      installer: {
        refresh: vi.fn(async () => {}),
        getStatus: () => ({ state: 'idle' }),
        ensureInstalled: vi.fn(async () => {}),
      } as never,
      getEnabled: () => enabled,
      setEnabled: vi.fn(async (next: boolean) => {
        enabled = next;
      }),
      nativeHost: false,
      // No validateCredential override: exercise the production probe.
    });

    await controller.update({
      enabled: true,
      model: 'qwen-audio-3.0-realtime-plus',
    });

    expect(openQwenRealtimeSession).toHaveBeenCalledOnce();
    // Without the mode the probe falls back to semantic_vad, which
    // qwen-audio rejects, so a valid setup would be reported as failing.
    expect(openQwenRealtimeSession.mock.lastCall?.[0]).toMatchObject({
      model: 'qwen-audio-3.0-realtime-plus',
      turnDetection: 'server_vad',
    });
  });
});
