/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { resolveInProcessBridges } from './inProcess.js';
import type { Env } from './sidecarConfig.js';

const OPTS = { port: 4170, homeDir: '/home/u' };
const resolve = (env: Env) => resolveInProcessBridges(env, OPTS);

describe('resolveInProcessBridges', () => {
  it('no bridge env → no plans, no warnings', () => {
    const r = resolve({});
    expect(r.plans).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('telegram: bot token + bridge token → a plan with loopback transport', () => {
    const r = resolve({
      TELEGRAM_BOT_TOKEN: 'bot',
      QWEN_BRIDGE_TOKEN: 'qwk_x',
    });
    expect(r.warnings).toEqual([]);
    expect(r.plans).toHaveLength(1);
    const p = r.plans[0];
    expect(p.cfg.kind).toBe('telegram');
    expect(p.token).toBe('qwk_x');
    // Transport is loopback; deeplink falls back to loopback with no QWEN_DAEMON_URL.
    expect(p.cfg.gatewayUrl).toBe('http://127.0.0.1:4170');
    expect(p.deeplinkUrl).toBe('http://127.0.0.1:4170');
    expect(p.cfg.stateDir).toBe('/home/u/.qwen/rc/bridges/telegram');
  });

  it('telegram: QWEN_RC_TELEGRAM_BOT_TOKEN is honored as the bot-token alias', () => {
    const r = resolve({
      QWEN_RC_TELEGRAM_BOT_TOKEN: 'alias-bot',
      QWEN_BRIDGE_TOKEN: 'qwk_x',
    });
    expect(r.plans).toHaveLength(1);
    expect((r.plans[0].cfg as { botToken: string }).botToken).toBe('alias-bot');
  });

  it('creds present but QWEN_BRIDGE_TOKEN missing → a warning, no plan', () => {
    const r = resolve({ TELEGRAM_BOT_TOKEN: 'bot' });
    expect(r.plans).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('telegram bridge');
    expect(r.warnings[0]).toContain('QWEN_BRIDGE_TOKEN missing');
  });

  it('discord: needs both bot token and application id', () => {
    expect(
      resolve({ DISCORD_BOT_TOKEN: 'b', QWEN_BRIDGE_TOKEN: 't' }).plans,
    ).toEqual([]); // no app id → not configured
    const r = resolve({
      DISCORD_BOT_TOKEN: 'b',
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_GUILD_ID: 'g',
      QWEN_BRIDGE_TOKEN: 't',
    });
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0].cfg).toMatchObject({
      kind: 'discord',
      applicationId: 'app',
      guildId: 'g',
    });
  });

  it('matrix: full creds + token → a plan; E2EE OFF by default', () => {
    const r = resolve({
      MATRIX_HOMESERVER_URL: 'https://hs',
      MATRIX_USER_ID: '@bot:hs',
      MATRIX_ACCESS_TOKEN: 'mtok',
      QWEN_BRIDGE_TOKEN: 't',
    });
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0].cfg).toMatchObject({
      kind: 'matrix',
      homeserverUrl: 'https://hs',
      userId: '@bot:hs',
      commandPrefix: '!qwen',
      e2eeEnabled: false,
    });
  });

  it('matrix: MATRIX_ENABLE_E2EE is threaded into the plan', () => {
    const r = resolve({
      MATRIX_HOMESERVER_URL: 'https://hs',
      MATRIX_USER_ID: '@bot:hs',
      MATRIX_ACCESS_TOKEN: 'mtok',
      MATRIX_ENABLE_E2EE: '1',
      MATRIX_COMMAND_PREFIX: '!q',
      QWEN_BRIDGE_TOKEN: 't',
    });
    expect(r.plans[0].cfg).toMatchObject({
      e2eeEnabled: true,
      commandPrefix: '!q',
    });
  });

  it('matrix: healthz is opt-in in-process (only when QWEN_BRIDGE_HEALTHZ_PORT is set)', () => {
    const base = {
      MATRIX_HOMESERVER_URL: 'https://hs',
      MATRIX_USER_ID: '@bot:hs',
      MATRIX_ACCESS_TOKEN: 'mtok',
      QWEN_BRIDGE_TOKEN: 't',
    };
    expect(resolve(base).plans[0].healthzPort).toBeUndefined();
    expect(
      resolve({ ...base, QWEN_BRIDGE_HEALTHZ_PORT: '9123' }).plans[0]
        .healthzPort,
    ).toBe(9123);
  });

  it('matrix: homeserver creds but no bridge token → warning mentions homeserver creds', () => {
    const r = resolve({
      MATRIX_HOMESERVER_URL: 'https://hs',
      MATRIX_USER_ID: '@bot:hs',
      MATRIX_ACCESS_TOKEN: 'mtok',
    });
    expect(r.plans).toEqual([]);
    expect(r.warnings[0]).toContain('homeserver creds set');
  });

  it('QWEN_DAEMON_URL sets the deeplink base but NOT the loopback transport', () => {
    const r = resolve({
      TELEGRAM_BOT_TOKEN: 'bot',
      QWEN_BRIDGE_TOKEN: 't',
      QWEN_DAEMON_URL: 'https://qwen.example.com',
    });
    const p = r.plans[0];
    expect(p.cfg.gatewayUrl).toBe('http://127.0.0.1:4170'); // transport: loopback
    expect(p.deeplinkUrl).toBe('https://qwen.example.com'); // deeplink: reachable
  });

  it('starts all three bridges when all are configured', () => {
    const r = resolve({
      TELEGRAM_BOT_TOKEN: 'b',
      DISCORD_BOT_TOKEN: 'b',
      DISCORD_APPLICATION_ID: 'app',
      MATRIX_HOMESERVER_URL: 'https://hs',
      MATRIX_USER_ID: '@bot:hs',
      MATRIX_ACCESS_TOKEN: 'mtok',
      QWEN_BRIDGE_TOKEN: 't',
    });
    expect(r.plans.map((p) => p.cfg.kind)).toEqual([
      'telegram',
      'discord',
      'matrix',
    ]);
    expect(r.warnings).toEqual([]);
  });
});
