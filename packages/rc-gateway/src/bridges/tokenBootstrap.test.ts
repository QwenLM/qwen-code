/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveBridgeToken,
  tokenFilePath,
  type TokenBootstrapDeps,
} from './tokenBootstrap.js';
import type { SidecarConfig } from './sidecarConfig.js';

const baseCfg: SidecarConfig = {
  kind: 'telegram',
  botToken: 'tg',
  gatewayUrl: 'https://daemon.test',
  stateDir: '/state/telegram',
};

function deps(over: Partial<TokenBootstrapDeps> = {}) {
  const writes: Array<{ path: string; token: string }> = [];
  const redeems: Array<{ gatewayUrl: string; code: string; label: string }> =
    [];
  const base: TokenBootstrapDeps = {
    readToken: async () => undefined,
    writeToken: async (path, token) => {
      writes.push({ path, token });
    },
    redeemPairingCode: async (gatewayUrl, code, label) => {
      redeems.push({ gatewayUrl, code, label });
      return 'qwk_redeemed';
    },
    ...over,
  };
  return { deps: base, writes, redeems };
}

describe('resolveBridgeToken', () => {
  it('uses an explicit QWEN_BRIDGE_TOKEN verbatim and never persists it', async () => {
    const f = deps();
    const cfg = { ...baseCfg, bridgeToken: 'qwk_explicit' };
    const token = await resolveBridgeToken(cfg, f.deps);
    expect(token).toBe('qwk_explicit');
    expect(f.writes).toHaveLength(0);
    expect(f.redeems).toHaveLength(0);
  });

  it('short-circuits to a persisted token, ignoring the pairing code', async () => {
    const f = deps({
      readToken: async (path) =>
        path === tokenFilePath('/state/telegram') ? 'qwk_persisted' : undefined,
    });
    const cfg = { ...baseCfg, pairingCode: 'pc_1' };
    const token = await resolveBridgeToken(cfg, f.deps);
    expect(token).toBe('qwk_persisted');
    expect(f.redeems).toHaveLength(0); // pairing code ignored — file exists
  });

  it('redeems a pairing code and persists the result on first boot', async () => {
    const f = deps();
    const cfg = { ...baseCfg, pairingCode: 'pc_abc' };
    const token = await resolveBridgeToken(cfg, f.deps);
    expect(token).toBe('qwk_redeemed');
    expect(f.redeems).toEqual([
      {
        gatewayUrl: 'https://daemon.test',
        code: 'pc_abc',
        label: 'telegram-bridge',
      },
    ]);
    expect(f.writes).toEqual([
      { path: tokenFilePath('/state/telegram'), token: 'qwk_redeemed' },
    ]);
  });

  it('labels the redeem by bridge kind', async () => {
    const f = deps();
    const cfg: SidecarConfig = {
      kind: 'matrix',
      homeserverUrl: 'https://home.test',
      userId: '@b:home.test',
      accessToken: 'mx',
      commandPrefix: '!qwen',
      gatewayUrl: 'https://daemon.test',
      stateDir: '/state/matrix',
      pairingCode: 'pc_xyz',
    };
    await resolveBridgeToken(cfg, f.deps);
    expect(f.redeems[0].label).toBe('matrix-bridge');
  });

  it('propagates a redemption failure', async () => {
    const f = deps({
      redeemPairingCode: async () => {
        throw new Error('boom');
      },
    });
    const cfg = { ...baseCfg, pairingCode: 'pc_1' };
    await expect(resolveBridgeToken(cfg, f.deps)).rejects.toThrow('boom');
  });

  it('throws when neither a token nor a pairing code is present', async () => {
    const f = deps();
    await expect(resolveBridgeToken(baseCfg, f.deps)).rejects.toThrow(
      'QWEN_BRIDGE_TOKEN or QWEN_BRIDGE_PAIRING_CODE is required',
    );
  });
});
