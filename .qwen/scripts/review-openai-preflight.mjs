#!/usr/bin/env node

/**
 * Preflight the review-only OpenAI-compatible credentials used by the
 * bundled PR review workflow.
 *
 * Required env:
 * - REVIEW_OPENAI_API_KEY
 * - REVIEW_OPENAI_BASE_URL
 *
 * Optional env:
 * - OPENAI_MODEL or QWEN_PR_REVIEW_MODEL (defaults to deepseek-v4-pro)
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');

const args = new Set(process.argv.slice(2));

function printHelp() {
  console.log(`Usage:
  node .qwen/scripts/review-openai-preflight.mjs [options]

Environment:
  REVIEW_OPENAI_API_KEY       Required review API key
  REVIEW_OPENAI_BASE_URL      Required OpenAI-compatible base URL
  OPENAI_MODEL                Model to test
  QWEN_PR_REVIEW_MODEL        Fallback model env if OPENAI_MODEL is unset

Options:
  --qwen-cli                  Also run a one-turn Qwen Code CLI preflight
  --build                     Build and bundle before --qwen-cli
  --timeout-ms <ms>           Per-request timeout, default 180000
  --help                      Show this help

Examples:
  REVIEW_OPENAI_API_KEY=sk-... \\
  REVIEW_OPENAI_BASE_URL=https://api.example.com/v1 \\
  OPENAI_MODEL=deepseek-v4-pro \\
  node .qwen/scripts/review-openai-preflight.mjs

  REVIEW_OPENAI_API_KEY=sk-... \\
  REVIEW_OPENAI_BASE_URL=https://api.example.com/v1 \\
  OPENAI_MODEL=deepseek-v4-pro \\
  node .qwen/scripts/review-openai-preflight.mjs --qwen-cli --build
`);
}

function readOption(name, defaultValue) {
  const rawArgs = process.argv.slice(2);
  const index = rawArgs.indexOf(name);
  if (index === -1) return defaultValue;
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function printStep(message) {
  console.log(`\n==> ${message}`);
}

function parseTimeoutMs() {
  const raw = readOption('--timeout-ms', '180000');
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--timeout-ms must be a positive integer, got ${raw}`);
  }
  return parsed;
}

function runCommand(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed`);
  }
}

async function runHttpPreflight({ apiKey, baseUrl, model, timeoutMs }) {
  printStep('Testing provider /chat/completions endpoint');
  console.log(`Model: ${model}`);
  console.log('API key: set');
  console.log('Base URL: set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
        temperature: 0,
        max_tokens: 8,
        stream: false,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      console.error(`Provider preflight failed: HTTP ${response.status}`);
      console.error(responseText.slice(0, 1200));
      process.exitCode = 1;
      return;
    }

    let content = '';
    try {
      const json = JSON.parse(responseText);
      content = json.choices?.[0]?.message?.content ?? '';
    } catch {
      content = responseText;
    }

    console.log(`Provider preflight passed in ${elapsedMs}ms.`);
    console.log(`Model response: ${JSON.stringify(content.slice(0, 120))}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`provider preflight timed out after ${timeoutMs}ms`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`provider preflight request failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

function runQwenCliPreflight({ apiKey, baseUrl, model, timeoutMs }) {
  printStep('Testing Qwen Code CLI with review credentials');

  if (args.has('--build')) {
    runCommand('npm', ['run', 'build']);
    runCommand('npm', ['run', 'bundle']);
  }

  const cliPath = path.join(repoRoot, 'dist/cli.js');
  if (!existsSync(cliPath)) {
    throw new Error(
      'dist/cli.js does not exist. Run `npm run build && npm run bundle`, or pass --build.',
    );
  }

  const result = spawnSync(
    'node',
    [
      'dist/cli.js',
      '--auth-type',
      'openai',
      '--model',
      model,
      '--max-session-turns',
      '1',
      '--prompt',
      'Reply with OK only.',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: baseUrl,
        OPENAI_MODEL: model,
        QWEN_SANDBOX: 'false',
      },
      stdio: 'inherit',
      timeout: timeoutMs,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('Qwen Code CLI preflight failed');
  }

  console.log('Qwen Code CLI preflight passed.');
}

async function main() {
  if (args.has('--help')) {
    printHelp();
    return;
  }

  const apiKey = requireEnv('REVIEW_OPENAI_API_KEY');
  const baseUrl = requireEnv('REVIEW_OPENAI_BASE_URL');
  const model =
    process.env.OPENAI_MODEL?.trim() ||
    process.env.QWEN_PR_REVIEW_MODEL?.trim() ||
    'deepseek-v4-pro';
  const timeoutMs = parseTimeoutMs();

  await runHttpPreflight({ apiKey, baseUrl, model, timeoutMs });
  if (process.exitCode) return;

  if (args.has('--qwen-cli')) {
    runQwenCliPreflight({ apiKey, baseUrl, model, timeoutMs });
  } else {
    console.log('\nProvider credentials look usable.');
    console.log(
      'Run again with --qwen-cli to verify Qwen Code CLI configuration as well.',
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Preflight failed: ${message}`);
  process.exit(1);
});
