#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

async function loadExportApi() {
  try {
    return await import('@qwen-code/qwen-code/export');
  } catch (error) {
    if (error instanceof Error && error.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        'export API unavailable — run npm install && npm run build in the repository root',
      );
      process.exit(1);
    }
    throw error;
  }
}

const exportConfig = {};

function printUsage(exitCode) {
  const message = `
Usage:
  node export-html-from-chatrecord-jsonl.js <input.jsonl> [--out <output.html>]
  node export-html-from-chatrecord-jsonl.js - [--out <output.html>]

Notes:
  - Input JSONL is expected to contain one ChatRecord per line.
`;
  console.error(message.trimEnd());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage(0);
  if (args.length === 0) return { input: null, output: null };

  let output = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== '--out' && args[index] !== '-o') continue;
    output = args[index + 1] ?? null;
    index += 1;
  }
  return { input: args[0] ?? null, output };
}

export async function readJsonlObjects(inputPath) {
  const input =
    inputPath === '-'
      ? process.stdin
      : fs.createReadStream(inputPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const objects = [];
  for await (const rawLine of lines) {
    const line = String(rawLine).trim();
    if (!line) continue;
    try {
      objects.push(JSON.parse(line));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid JSONL line: ${message}\nLine: ${line.slice(0, 200)}`,
      );
    }
  }
  return objects;
}

export function looksLikeChatRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.uuid === 'string' &&
    'parentUuid' in value &&
    typeof value.sessionId === 'string' &&
    typeof value.timestamp === 'string' &&
    typeof value.type === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.version === 'string'
  );
}

export function looksLikeExportJsonl(objects) {
  const first = objects[0];
  return (
    first !== null &&
    typeof first === 'object' &&
    first.type === 'session_metadata' &&
    typeof first.sessionId === 'string' &&
    typeof first.startTime === 'string'
  );
}

function startTimeFor(records) {
  let earliest = Number.POSITIVE_INFINITY;
  for (const record of records) {
    const timestamp = Date.parse(record.timestamp);
    if (Number.isFinite(timestamp)) earliest = Math.min(earliest, timestamp);
  }
  return Number.isFinite(earliest)
    ? new Date(earliest).toISOString()
    : new Date().toISOString();
}

async function buildProductSessionData(records, collectSessionMetadata) {
  const conversation = {
    sessionId: records[0]?.sessionId ?? 'unknown-session',
    startTime: startTimeFor(records),
    messages: records,
  };
  return {
    sessionId: conversation.sessionId,
    startTime: conversation.startTime,
    messages: [],
    metadata: await collectSessionMetadata(conversation, exportConfig),
  };
}

function defaultOutPath(inputPath) {
  if (inputPath === '-') return path.resolve(process.cwd(), 'export.html');
  const directory = path.dirname(inputPath);
  const basename = path.basename(inputPath, path.extname(inputPath));
  return path.resolve(directory, `${basename}.html`);
}

/**
 * The input gate. Legacy exported JSONL is rejected rather than rendered: it
 * has already been through a renderer once, so feeding it back in would put
 * previously-rendered markup on the page without passing the export API's
 * document allowlist. Source ChatRecords are the only shape that goes through
 * that allowlist, so they are the only shape accepted.
 */
export function selectChatRecords(objects) {
  if (objects.length === 0) throw new Error('Input JSONL is empty.');

  if (looksLikeExportJsonl(objects)) {
    throw new Error(
      'Legacy exported JSONL cannot be rendered safely; provide source ChatRecord JSONL.',
    );
  }
  const records = objects.filter(looksLikeChatRecord);
  if (records.length === 0) {
    throw new Error(
      'Unrecognized JSONL format (expected ChatRecord-per-line).',
    );
  }
  return records;
}

/**
 * Render accepted records to HTML. `api` is the `@qwen-code/qwen-code/export`
 * module, taken as an argument so a caller can supply it — the real one comes
 * from `loadExportApi()`, which needs built CLI output.
 */
export async function renderHtmlFromObjects(objects, api) {
  const records = selectChatRecords(objects);
  const sessionData = await buildProductSessionData(
    records,
    api.collectSessionMetadata,
  );
  return api.toHtml(sessionData, records);
}

async function main() {
  const api = await loadExportApi();
  const { input, output } = parseArgs(process.argv);
  if (!input) printUsage(1);

  const objects = await readJsonlObjects(input);
  const html = await renderHtmlFromObjects(objects, api);
  const outputPath = output ? path.resolve(output) : defaultOutPath(input);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, html, 'utf8');
  console.log(`Wrote HTML export to: ${outputPath}`);
}

// Only run when invoked as the CLI. Importing this module (the test does)
// must not execute a render or touch process state.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
