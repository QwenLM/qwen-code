/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentProxy } from './sdk/browser.js';
import {
  createBrowserSdkContext,
  type BrowserSdkContext,
} from './sdk/context.js';
import type { BrowserAgent } from './sdk/types.js';

export type * from './sdk/types.js';

interface BrowserRuntimeSession {
  agent: BrowserAgent;
  context: BrowserSdkContext;
}

let singletonSession: Promise<BrowserRuntimeSession> | undefined;

export async function setupBrowserRuntime(): Promise<BrowserAgent> {
  const pending = (singletonSession ??= createBrowserRuntimeSession());
  try {
    return (await pending).agent;
  } catch (error) {
    if (singletonSession === pending) singletonSession = undefined;
    throw error;
  }
}

export async function closeBrowserRuntime(): Promise<void> {
  const pending = singletonSession;
  singletonSession = undefined;
  if (pending === undefined) return;
  const session = await pending.catch(() => undefined);
  await session?.context.close();
}

async function createBrowserRuntimeSession(): Promise<BrowserRuntimeSession> {
  const context = await createBrowserSdkContext();
  return { context, agent: new AgentProxy(context) };
}
