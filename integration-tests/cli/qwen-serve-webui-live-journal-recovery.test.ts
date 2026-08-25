/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonEvent, DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import {
  makeTempWorkspace,
  spawnDaemon,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = path.resolve(
  __dirname,
  '../fixtures/mock-acp-child/agent.mjs',
);

let activeDaemon: SpawnedDaemon | undefined;
let root: Root | undefined;
let dom: JSDOM;
let createRoot: typeof import('react-dom/client').createRoot;
let DaemonSessionProvider: typeof import('@qwen-code/webui/daemon-react-sdk').DaemonSessionProvider;
let useTranscriptBlocks: typeof import('@qwen-code/webui/daemon-react-sdk').useTranscriptBlocks;
const originalGlobalDescriptors = new Map(
  ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  ),
);

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  ({ createRoot } = await import('react-dom/client'));
  ({ DaemonSessionProvider, useTranscriptBlocks } = await import(
    '@qwen-code/webui/daemon-react-sdk'
  ));
});

afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originalGlobalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  await activeDaemon?.dispose();
  activeDaemon = undefined;
});

function eventText(event: DaemonEvent): string | undefined {
  if (event.type !== 'session_update' || !event.data) return undefined;
  return (event.data as { update?: { content?: { text?: string } } }).update
    ?.content?.text;
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe('qwen serve WebUI live journal recovery', () => {
  it('repairs once after terminal without another model request', async () => {
    const workspace = makeTempWorkspace('webui-live-journal-recovery');
    const originalFetch = globalThis.fetch;
    const requestPaths: string[] = [];
    try {
      globalThis.fetch = async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        requestPaths.push(new URL(url, 'http://localhost').pathname);
        return await originalFetch(input, init);
      };
      activeDaemon = await spawnDaemon({
        workspaceCwd: workspace,
        extraArgs: ['--max-journal-events', '3', '--max-journal-bytes', '300'],
        env: {
          QWEN_CLI_ENTRY: MOCK_AGENT_PATH,
          MOCK_ACP_MODE: 'echo',
          MOCK_ACP_EMIT_CHUNKS: '20',
          MOCK_ACP_PROMPT_DELAY_MS: '1500',
        },
      });
      const created = await activeDaemon.client.createOrAttachSession({
        sessionScope: 'thread',
      });
      const observerAbort = new AbortController();
      const sawLastChunk = (async () => {
        for await (const event of activeDaemon!.client.subscribeEvents(
          created.sessionId,
          { signal: observerAbort.signal },
        )) {
          if (eventText(event) === 'chunk-19') return;
        }
      })();
      const prompt = activeDaemon.client.prompt(created.sessionId, {
        prompt: [{ type: 'text', text: 'repair this turn in WebUI' }],
      });
      await sawLastChunk;
      observerAbort.abort();

      let blocks: readonly DaemonTranscriptBlock[] = [];
      function Harness() {
        blocks = useTranscriptBlocks();
        return null;
      }
      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(
          // `children` is the one required prop on DaemonSessionProviderProps,
          // and a trailing createElement argument does not satisfy it — the
          // call only type checks with children in the props object. The lint
          // rule guards JSX readability, which does not apply in this .ts file
          // where createElement is already being called by hand.
          // eslint-disable-next-line react/no-children-prop
          createElement(DaemonSessionProvider, {
            autoConnect: true,
            baseUrl: activeDaemon!.base,
            token: activeDaemon!.token,
            sessionId: created.sessionId,
            children: createElement(Harness),
          }),
        );
      });

      await waitFor(
        () =>
          blocks.some(
            (block) =>
              'source' in block && block.source === 'history_truncated',
          ),
        'visible live journal marker',
      );
      await act(async () => {
        await prompt;
      });
      await waitFor(
        () =>
          JSON.stringify(blocks).includes('chunk-0') &&
          JSON.stringify(blocks).includes('chunk-19') &&
          !blocks.some(
            (block) =>
              'source' in block && block.source === 'history_truncated',
          ),
        'atomically repaired complete turn',
      );

      expect(
        requestPaths.filter((pathname) => pathname.endsWith('/load')),
      ).toHaveLength(2);
      expect(
        requestPaths.filter((pathname) => pathname.endsWith('/prompt')),
      ).toHaveLength(1);
      expect(JSON.stringify(blocks).match(/chunk-0/g)).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (root) {
        await act(async () => root?.unmount());
        root = undefined;
      }
      await activeDaemon?.dispose();
      activeDaemon = undefined;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
