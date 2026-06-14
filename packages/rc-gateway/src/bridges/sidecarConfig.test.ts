/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSidecarConfig,
  checkMxid,
  SidecarConfigError,
  type Env,
} from './sidecarConfig.js';

const HOME = '/home/bot';

const fullTelegram: Env = {
  TELEGRAM_BOT_TOKEN: 'tg-bot',
  QWEN_DAEMON_URL: 'https://daemon.test',
  QWEN_BRIDGE_TOKEN: 'qwk_tok',
};
const fullDiscord: Env = {
  DISCORD_BOT_TOKEN: 'dc-bot',
  DISCORD_APPLICATION_ID: 'app-1',
  QWEN_DAEMON_URL: 'https://daemon.test',
  QWEN_BRIDGE_TOKEN: 'qwk_tok',
};
const fullMatrix: Env = {
  MATRIX_HOMESERVER_URL: 'https://home.test',
  MATRIX_USER_ID: '@qwenbot:home.test',
  MATRIX_ACCESS_TOKEN: 'mx-tok',
  QWEN_DAEMON_URL: 'https://daemon.test',
  QWEN_BRIDGE_TOKEN: 'qwk_tok',
};

describe('resolveSidecarConfig — telegram', () => {
  it('resolves a full env with gatewayUrl + default stateDir', () => {
    const cfg = resolveSidecarConfig('telegram', fullTelegram, HOME);
    expect(cfg).toMatchObject({
      kind: 'telegram',
      botToken: 'tg-bot',
      gatewayUrl: 'https://daemon.test',
      bridgeToken: 'qwk_tok',
      stateDir: '/home/bot/.qwen/rc/bridges/telegram',
    });
  });

  it('fails fast with the exact message when the bot token is missing', () => {
    const env = { ...fullTelegram, TELEGRAM_BOT_TOKEN: undefined };
    expect(() => resolveSidecarConfig('telegram', env, HOME)).toThrow(
      'TELEGRAM_BOT_TOKEN is required',
    );
    expect(() => resolveSidecarConfig('telegram', env, HOME)).toThrow(
      SidecarConfigError,
    );
  });

  it('the bot-token message wins even when daemon URL is also unset', () => {
    const env: Env = { QWEN_BRIDGE_TOKEN: 'qwk_tok' };
    expect(() => resolveSidecarConfig('telegram', env, HOME)).toThrow(
      'TELEGRAM_BOT_TOKEN is required',
    );
  });
});

describe('resolveSidecarConfig — discord', () => {
  it('resolves app id and optional guild id', () => {
    const cfg = resolveSidecarConfig(
      'discord',
      { ...fullDiscord, DISCORD_GUILD_ID: 'guild-9' },
      HOME,
    );
    expect(cfg).toMatchObject({
      kind: 'discord',
      botToken: 'dc-bot',
      applicationId: 'app-1',
      guildId: 'guild-9',
      stateDir: '/home/bot/.qwen/rc/bridges/discord',
    });
  });

  it('guild id is optional (undefined when unset)', () => {
    const cfg = resolveSidecarConfig('discord', fullDiscord, HOME);
    expect((cfg as { guildId?: string }).guildId).toBeUndefined();
  });

  it('fails fast on a missing application id', () => {
    const env = { ...fullDiscord, DISCORD_APPLICATION_ID: undefined };
    expect(() => resolveSidecarConfig('discord', env, HOME)).toThrow(
      'DISCORD_APPLICATION_ID is required',
    );
  });

  it('fails fast with the exact bot-token message', () => {
    const env = { ...fullDiscord, DISCORD_BOT_TOKEN: undefined };
    expect(() => resolveSidecarConfig('discord', env, HOME)).toThrow(
      'DISCORD_BOT_TOKEN is required',
    );
  });
});

describe('resolveSidecarConfig — matrix', () => {
  it('resolves homeserver/user/token + default command prefix', () => {
    const cfg = resolveSidecarConfig('matrix', fullMatrix, HOME);
    expect(cfg).toMatchObject({
      kind: 'matrix',
      homeserverUrl: 'https://home.test',
      userId: '@qwenbot:home.test',
      accessToken: 'mx-tok',
      commandPrefix: '!qwen',
      stateDir: '/home/bot/.qwen/rc/bridges/matrix',
    });
  });

  it('honors a custom command prefix', () => {
    const cfg = resolveSidecarConfig(
      'matrix',
      { ...fullMatrix, MATRIX_COMMAND_PREFIX: '!q' },
      HOME,
    );
    expect((cfg as { commandPrefix: string }).commandPrefix).toBe('!q');
  });

  it('E2EE is OFF by default and opt-in via MATRIX_ENABLE_E2EE', () => {
    const off = resolveSidecarConfig('matrix', fullMatrix, HOME);
    expect((off as { e2eeEnabled: boolean }).e2eeEnabled).toBe(false);
    const on = resolveSidecarConfig(
      'matrix',
      { ...fullMatrix, MATRIX_ENABLE_E2EE: 'true' },
      HOME,
    );
    expect((on as { e2eeEnabled: boolean }).e2eeEnabled).toBe(true);
  });

  it('fails fast on a missing access token', () => {
    const env = { ...fullMatrix, MATRIX_ACCESS_TOKEN: undefined };
    expect(() => resolveSidecarConfig('matrix', env, HOME)).toThrow(
      'MATRIX_ACCESS_TOKEN is required',
    );
  });
});

describe('resolveSidecarConfig — shared vars', () => {
  it('fails fast on a missing daemon URL (all creds present)', () => {
    const env = { ...fullTelegram, QWEN_DAEMON_URL: undefined };
    expect(() => resolveSidecarConfig('telegram', env, HOME)).toThrow(
      'QWEN_DAEMON_URL is required',
    );
  });

  it('requires a token OR a pairing code', () => {
    const env = { ...fullTelegram, QWEN_BRIDGE_TOKEN: undefined };
    expect(() => resolveSidecarConfig('telegram', env, HOME)).toThrow(
      'QWEN_BRIDGE_TOKEN or QWEN_BRIDGE_PAIRING_CODE is required',
    );
  });

  it('accepts a pairing code in place of a token', () => {
    const cfg = resolveSidecarConfig(
      'telegram',
      {
        ...fullTelegram,
        QWEN_BRIDGE_TOKEN: undefined,
        QWEN_BRIDGE_PAIRING_CODE: 'pc_1',
      },
      HOME,
    );
    expect(cfg.bridgeToken).toBeUndefined();
    expect(cfg.pairingCode).toBe('pc_1');
  });

  it('QWEN_BRIDGE_STATE_DIR overrides the default state dir', () => {
    const cfg = resolveSidecarConfig(
      'telegram',
      { ...fullTelegram, QWEN_BRIDGE_STATE_DIR: '/data/tg' },
      HOME,
    );
    expect(cfg.stateDir).toBe('/data/tg');
  });

  it('treats an empty-string var as missing', () => {
    const env = { ...fullTelegram, TELEGRAM_BOT_TOKEN: '' };
    expect(() => resolveSidecarConfig('telegram', env, HOME)).toThrow(
      'TELEGRAM_BOT_TOKEN is required',
    );
  });
});

describe('checkMxid', () => {
  it('returns an error message on a confirmed mismatch', () => {
    const msg = checkMxid('@other:home.test', '@qwenbot:home.test');
    expect(msg).toContain('MXID mismatch');
    expect(msg).toContain('@other:home.test');
    expect(msg).toContain('@qwenbot:home.test');
  });

  it('passes (null) when the whoami MXID matches', () => {
    expect(checkMxid('@qwenbot:home.test', '@qwenbot:home.test')).toBeNull();
  });

  it('fails open (null) when whoami returned no MXID', () => {
    expect(checkMxid(undefined, '@qwenbot:home.test')).toBeNull();
  });
});
