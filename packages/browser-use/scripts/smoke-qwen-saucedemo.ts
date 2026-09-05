#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChromeExtensionTransport } from '../src/bridge/index.js';
import { PlaywrightRuntime } from '../src/playwright/playwright-runtime.js';
import { withManagedChrome } from './managed-chrome.js';
import { collectAssistantReport } from './smoke-transcript.js';

const PROMPT = [
  '这是 Qwen Browser Use 的隔离 SauceDemo 冒烟测试。',
  '使用 browser-use skill 和标准 node_repl，',
  '用 standard_user / secret_sauce 登录 https://www.saucedemo.com/，',
  '动态识别价格最低的三件商品并加入购物车，完成整个结账流程，',
  '提交后验证完成页，最后告诉我含税总价。',
  '所有表单输入必须使用 locator.type，不要使用 locator.fill。',
  '在商品页和购物车分别用 locator.allTextContents 读取价格；导航到购物车后必须先调用 tab.url() 确认 cart.html，再读取购物车价格。',
  '在结账概览用 locator.innerText 读取 Total；每次导航后调用 tab.url()，完成页使用 domSnapshot() 验证。',
  '先观察再行动；browser.tabs.new() 已自动 grant，不要使用其他浏览器、shell 或网络工具。',
  '完成验证后，把完成页作为 deliverable 调用 browser.tabs.finalize；finalize 必须是最后一个浏览器操作。',
].join('');
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

await withManagedChrome('sauce', async (chrome) => {
  const apiKey = process.env['DASHSCOPE_API_KEY'];
  assert(apiKey, 'DASHSCOPE_API_KEY is required');
  const baseUrl = process.env['DASHSCOPE_BASE_URL'];
  assert(baseUrl, 'DASHSCOPE_BASE_URL is required');
  const model = process.env['QWEN_BROWSER_USE_MODEL'];
  assert(model, 'QWEN_BROWSER_USE_MODEL is required');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const repositoryRoot = resolve(packageRoot, '../..');
  const qwenEntry = join(repositoryRoot, 'dist/cli.js');
  const nodeReplEntry = join(
    repositoryRoot,
    'packages/node-repl/dist/index.js',
  );
  const builtinSkillRoot = join(repositoryRoot, 'dist/bundled/browser-use');
  const browserRuntimeRoot = join(builtinSkillRoot, 'runtime');
  const browserRuntimeEntry = join(browserRuntimeRoot, 'index.js');
  const browserModuleRoot = join(browserRuntimeRoot, 'node_modules');
  await Promise.all(
    [
      qwenEntry,
      nodeReplEntry,
      join(builtinSkillRoot, 'SKILL.md'),
      browserRuntimeEntry,
      join(browserRuntimeRoot, 'native-host.js'),
      join(browserModuleRoot, 'playwright-core/package.json'),
    ].map((path) => access(path)),
  );
  const runId = new Date()
    .toISOString()
    .replaceAll(':', '')
    .replaceAll('.', '');
  const runRoot = join(repositoryRoot, '.qwen/e2e-tests/browser-use', runId);
  const providerLogs = join(runRoot, 'provider-logs');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'qwen-browser-use-'));
  try {
    const qwenHome = join(temporaryRoot, 'qwen-home');
    const workspace = join(temporaryRoot, 'workspace');
    await mkdir(qwenHome, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(providerLogs, { recursive: true, mode: 0o700 });

    const settings = {
      general: { chatRecording: false },
      telemetry: { enabled: false },
      security: { auth: { selectedType: 'openai' } },
      model: { name: model },
      modelProviders: {
        openai: [
          {
            id: model,
            name: `[Dashscope] ${model}`,
            baseUrl,
            envKey: 'DASHSCOPE_API_KEY',
            generationConfig: {
              modalities: { image: true },
              extra_body: { enable_thinking: true },
            },
          },
        ],
      },
      mcpServers: {
        'node-repl': {
          command: process.execPath,
          args: [nodeReplEntry],
          trust: true,
        },
      },
    };
    const settingsText = JSON.stringify(settings, null, 2) + '\n';
    assert(!settingsText.includes(apiKey), 'API key entered settings');
    await writeFile(join(qwenHome, 'settings.json'), settingsText, {
      mode: 0o600,
    });
    await writeFile(
      join(runRoot, 'manifest.json'),
      JSON.stringify(
        {
          runId,
          model,
          prompt: PROMPT,
          chromeVersion: chrome.chromeVersion,
          managedChrome: true,
          isolatedQwenHome: true,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      QWEN_HOME: qwenHome,
      QWEN_BROWSER_USE_SOCKET_PATH: chrome.socketPath,
    };
    const qwen = await runCommand(
      process.execPath,
      [
        qwenEntry,
        '--auth-type',
        'openai',
        '--model',
        model,
        '--allowed-mcp-server-names',
        'node-repl',
        '--core-tools',
        'skill,tool_search',
        '--approval-mode',
        'yolo',
        '--max-wall-time',
        '10m',
        '--max-tool-calls',
        '60',
        '--max-session-turns',
        '100',
        '--chat-recording=false',
        '--telemetry=false',
        '--openai-logging',
        '--openai-logging-dir',
        providerLogs,
        '--output-format',
        'json',
        '--prompt',
        PROMPT,
      ],
      workspace,
      environment,
      660_000,
    );
    assertNoSecret(apiKey, qwen.stdout, qwen.stderr);
    await writeFile(join(runRoot, 'qwen-transcript.json'), qwen.stdout, {
      mode: 0o600,
    });
    await writeFile(join(runRoot, 'qwen-stderr.txt'), qwen.stderr, {
      mode: 0o600,
    });
    assertSuccess(qwen, 'Qwen SauceDemo smoke');

    const events = JSON.parse(qwen.stdout.trim()) as unknown;
    assert(Array.isArray(events), 'Qwen JSON output was not an event array');
    const result = events.find(
      (event) => isRecord(event) && event['type'] === 'result',
    );
    assert(
      isRecord(result) &&
        result['subtype'] === 'success' &&
        result['is_error'] === false,
      'Qwen did not finish successfully',
    );
    const finalAnswer = collectAssistantReport(events);
    const calls = collectSuccessfulNodeReplCalls(events);
    const inventoryPrices = pricesFromCall(
      calls,
      '.inventory_item .inventory_item_price',
      6,
    );
    const cartPrices = pricesFromCall(
      calls,
      '.cart_item .inventory_item_price',
      3,
    );
    const lowestThreePrices = inventoryPrices
      ? [...inventoryPrices].sort((left, right) => left - right).slice(0, 3)
      : [];
    const cartMatchesLowestThree =
      cartPrices !== null &&
      JSON.stringify([...cartPrices].sort((left, right) => left - right)) ===
        JSON.stringify(lowestThreePrices);
    const completion = await verifySauceCompletion(chrome.socketPath);
    const joinedCode = calls.map((call) => call.code).join('\n');
    const joinedOutput = calls.map((call) => call.output).join('\n');
    const checks = {
      existingNodeReplUsed: calls.length > 0,
      browserSdkImported:
        joinedCode.includes(browserRuntimeEntry) &&
        joinedCode.includes('setupBrowserRuntime()'),
      builtinModuleRootRegistered: successfulModuleRootRegistered(
        events,
        browserModuleRoot,
      ),
      checkoutCompletionObserved:
        completion.url === 'https://www.saucedemo.com/checkout-complete.html' &&
        completion.snapshot.includes('Thank you for your order!'),
      trustedInputPathObserved:
        joinedCode.includes('.type(') && joinedCode.includes('.click('),
      tabFinalized: joinedCode.includes('.finalize('),
      cartMatchesLowestThree,
      reportedTotalIsExpected:
        joinedOutput.includes('Total: $36.69') &&
        finalAnswer.includes('$36.69'),
    };
    assert(
      Object.values(checks).every(Boolean),
      'SauceDemo checks failed: ' + JSON.stringify(checks),
    );

    const logFiles = await listFiles(providerLogs);
    for (const file of logFiles) {
      const bytes = await readFile(file);
      assert(
        !bytes.includes(Buffer.from(apiKey)),
        'API key entered provider log',
      );
      await chmod(file, 0o600);
    }
    const summary = {
      ok: true,
      runId,
      runDirectory: runRoot,
      model,
      durationMs: qwen.durationMs,
      chromeVersion: chrome.chromeVersion,
      checks,
      reportedTotal: '$36.69',
      lastObservedUrl: completion.url,
      finalAnswer,
    };
    await writeFile(
      join(runRoot, 'result.json'),
      JSON.stringify(summary, null, 2) + '\n',
      { mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function runCommand(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) child.kill('SIGTERM');
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.once('error', rejectPromise);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (bytes > MAX_OUTPUT_BYTES) {
        rejectPromise(new Error('Qwen output exceeded the limit'));
      } else if (timedOut) {
        rejectPromise(new Error('Qwen command timed out'));
      } else {
        resolvePromise({
          stdout,
          stderr,
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
        });
      }
    });
  });
}

function assertSuccess(result: CommandResult, label: string): void {
  assert(
    result.exitCode === 0,
    label +
      ' failed with code ' +
      String(result.exitCode) +
      ': ' +
      result.stderr.slice(-4_000),
  );
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(candidate)));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

function assertNoSecret(secret: string, ...values: string[]): void {
  assert(
    values.every((value) => !value.includes(secret)),
    'DASHSCOPE_API_KEY appeared in process output',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface NodeReplCall {
  code: string;
  output: string;
}

function collectSuccessfulNodeReplCalls(events: unknown[]): NodeReplCall[] {
  const calls = new Map<string, { code: string; name: string }>();
  for (const event of events) {
    if (!isRecord(event) || event['type'] !== 'assistant') continue;
    const message = event['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      if (
        !isRecord(block) ||
        block['type'] !== 'tool_use' ||
        typeof block['id'] !== 'string' ||
        typeof block['name'] !== 'string' ||
        !isRecord(block['input']) ||
        typeof block['input']['code'] !== 'string'
      ) {
        continue;
      }
      calls.set(block['id'], {
        code: block['input']['code'],
        name: block['name'],
      });
    }
  }
  const successful: NodeReplCall[] = [];
  for (const event of events) {
    if (!isRecord(event) || event['type'] !== 'user') continue;
    const message = event['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      if (
        !isRecord(block) ||
        block['type'] !== 'tool_result' ||
        block['is_error'] !== false ||
        typeof block['tool_use_id'] !== 'string' ||
        typeof block['content'] !== 'string'
      ) {
        continue;
      }
      const call = calls.get(block['tool_use_id']);
      if (call?.name === 'mcp__node-repl__node_repl') {
        successful.push({ code: call.code, output: block['content'] });
      }
    }
  }
  return successful;
}

function successfulModuleRootRegistered(
  events: unknown[],
  moduleRoot: string,
): boolean {
  const calls = new Set<string>();
  for (const event of events) {
    if (!isRecord(event) || event['type'] !== 'assistant') continue;
    const message = event['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      if (
        isRecord(block) &&
        block['type'] === 'tool_use' &&
        block['name'] === 'mcp__node-repl__node_repl_add_node_module_dir' &&
        isRecord(block['input']) &&
        block['input']['path'] === moduleRoot &&
        typeof block['id'] === 'string'
      ) {
        calls.add(block['id']);
      }
    }
  }
  return events.some((event) => {
    if (!isRecord(event) || event['type'] !== 'user') return false;
    const message = event['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) return false;
    return message['content'].some(
      (block) =>
        isRecord(block) &&
        block['type'] === 'tool_result' &&
        block['is_error'] === false &&
        typeof block['tool_use_id'] === 'string' &&
        calls.has(block['tool_use_id']),
    );
  });
}

function pricesFromCall(
  calls: NodeReplCall[],
  selector: string,
  expectedCount: number,
): number[] | null {
  for (const call of calls) {
    if (!call.code.includes(selector) || !call.code.includes('allTextContents'))
      continue;
    const prices = [...call.output.matchAll(/\$(\d+(?:\.\d{2})?)/g)].map(
      (match) => Number(match[1]),
    );
    if (prices.length === expectedCount && prices.every(Number.isFinite)) {
      return prices;
    }
  }
  return null;
}

async function verifySauceCompletion(socketPath: string): Promise<{
  url: string;
  snapshot: string;
}> {
  const bridge = new ChromeExtensionTransport({ socketPath });
  const runtime = new PlaywrightRuntime({ bridge });
  try {
    await bridge.request('ping', {}, 20_000);
    const openTabs = await runtime.dispatch('browser.user.openTabs', {
      browserId: runtime.browserId,
    });
    assert(Array.isArray(openTabs), 'Chrome returned an invalid tab list');
    const completion = openTabs.find(
      (tab) =>
        isRecord(tab) &&
        tab['url'] === 'https://www.saucedemo.com/checkout-complete.html',
    );
    assert(completion, 'SauceDemo completion tab was not open');
    const claimed = await claimAfterPreviousSessionExits(runtime, completion);
    assert(
      isRecord(claimed) && typeof claimed['id'] === 'string',
      'SauceDemo completion tab could not be claimed',
    );
    const url = await runtime.dispatch('tab.url', { tabId: claimed['id'] });
    const snapshot = await runtime.dispatch('playwright.domSnapshot', {
      tabId: claimed['id'],
    });
    assert(typeof url === 'string', 'SauceDemo completion URL was invalid');
    assert(
      typeof snapshot === 'string',
      'SauceDemo completion snapshot was invalid',
    );
    return { url, snapshot };
  } finally {
    await runtime.stop();
  }
}

async function claimAfterPreviousSessionExits(
  runtime: PlaywrightRuntime,
  tab: unknown,
): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await runtime.dispatch('browser.user.claimTab', {
        browserId: runtime.browserId,
        tab,
      });
    } catch (error) {
      if (
        Date.now() >= deadline ||
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'TAB_ALREADY_CLAIMED'
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
