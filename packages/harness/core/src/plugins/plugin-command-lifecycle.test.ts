/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { normalizePluginMarketplaceMetadata } from '@qwen-code/resource';
import { PluginCommandLifecycle } from './plugin-command-lifecycle.js';
import type { HookRequestAttribution } from '../hooks/types.js';
import { tmpdir } from 'node:os';

function setup() {
  const config = new Config({
    loadedSettings: createEmptyLoadedSettings(),
    model: 'test',
    sessionId: 'plugin-session',
    targetDir: tmpdir(),
    cwd: tmpdir(),
    debugMode: false,
  });
  const post = vi.fn(async (..._args: unknown[]) => { });
  const failure = vi.fn(async (..._args: unknown[]) => { });
  vi.spyOn(
    config,
    'getHookSystem'
  ).mockReturnValue({
    firePostToolUseEvent: post,
    firePostToolUseFailureEvent: failure,
  } as never);
  return { config, post, failure };
}

describe(
  'PluginCommandLifecycle',
  () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
      [{ displayName: 'Marketplace name', marketItemId: 'market-id' }, 'Marketplace name'],
      [{ displayName: ' ', marketItemId: 'market-id' }, 'market-id'],
      [{}, 'local-plugin'],
    ])(
      'resolves marketplace identity before the loaded plugin name: %j',
      async (metadata, expected) => {
        const { config, post } = setup();
        const lifecycle = new PluginCommandLifecycle(
          config,
          'local-plugin:receipt',
          normalizePluginMarketplaceMetadata(metadata),
          ' local-plugin ',
        );

        await lifecycle.succeed('expanded');

        const attribution = post.mock.calls[0][11] as HookRequestAttribution;
        expect(attribution.extensionExecution?.name).toBe(expected);
      },
    );

    it(
      'snapshots plugin ownership and expansion duration before awaiting hooks, once per invocation',
      async () => {
        const { config, post, failure } = setup();
        const clock = vi.spyOn(
          performance,
          'now'
        ).mockReturnValue(100);
        const metadata = normalizePluginMarketplaceMetadata({
          displayName: 'Original',
          marketItemId: 'demo',
        });
        const lifecycle = new PluginCommandLifecycle(
          config,
          'demo:receipt',
          metadata,
        );
        metadata.displayName = 'Changed';
        clock.mockReturnValue(125.7);
        post.mockImplementation(async () => {
          clock.mockReturnValue(900);
        });
        await lifecycle.succeed('expanded');
        await lifecycle.succeed('duplicate');
        await lifecycle.fail(new Error('late error'));
        expect(post).toHaveBeenCalledOnce();
        expect(failure).not.toHaveBeenCalled();
        expect(post.mock.calls[0].slice(
          0,
          4
        )).toEqual([
          'PluginCommand',
          { command: 'demo:receipt' },
          'expanded',
          expect.stringMatching(/^plugin-command-/),
        ]);
        const attribution = post.mock.calls[0][11] as HookRequestAttribution;
        expect(attribution.extensionExecution).toEqual({
          kind: 'plugin',
          name: 'Original',
          durationMs: 25,
          status: 'success',
        });
        expect(attribution).not.toHaveProperty('pluginCommand');
        expect(attribution.extensionFeatures).not.toHaveProperty('mcpServerName');
        expect(attribution.extensionFeatures).not.toHaveProperty('name');
        expect(attribution.extensionFeatures).not.toHaveProperty('durationMs');
        expect(attribution.extensionFeatures).toMatchObject({
          marketSourceId: '',
          marketOrgId: '',
          extensionKind: '',
          extensionId: 'demo',
          extensionVersion: '',
        });
      }
    );
    it.each([undefined, 'EXPLICIT_CODE'])(
      'reports expansion failure and only explicit error codes (%s)',
      async (code) => {
        const { config, failure } = setup();
        const lifecycle = new PluginCommandLifecycle(
          config,
          'local:receipt',
          normalizePluginMarketplaceMetadata(),
        );
        await lifecycle.fail(
          Object.assign(
            new Error('expansion failed'),
            {
              code,
              errorType: 'expansion_error',
            }
          ),
        );
        expect(failure).toHaveBeenCalledOnce();
        expect(failure.mock.calls[0].slice(
          0,
          5
        )).toEqual([
          'PluginCommand',
          { command: 'local:receipt' },
          'expansion failed',
          expect.stringMatching(/^plugin-command-/),
          'expansion_error',
        ]);
        const facts = (failure.mock.calls[0][12] as HookRequestAttribution)
          .extensionExecution!;
        expect(facts).toMatchObject({
          name: 'unknown',
          status: 'error',
          errorType: 'expansion_error',
        });
        if (code) expect(facts.errorCode).toBe(code);
        else expect(facts).not.toHaveProperty('errorCode');
      },
    );
    it(
      'contains hook failures without changing command behavior',
      async () => {
        const { config, post } = setup();
        post.mockRejectedValue(new Error('metrics unavailable'));
        await expect(
          new PluginCommandLifecycle(
            config,
            'demo:receipt',
            normalizePluginMarketplaceMetadata(),
          ).succeed('expanded'),
        ).resolves.toBeUndefined();
        expect(post).toHaveBeenCalledOnce();
      }
    );
  }
);
