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

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 141.38 140"><defs><linearGradient id="qwen-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#a855f7"/></linearGradient></defs><path fill="url(#qwen-gradient)" d="m140.93 85-16.35-28.33-1.93-3.34 8.66-15a3.323 3.323 0 0 0 0-3.34l-9.62-16.67c-.3-.51-.72-.93-1.22-1.22s-1.07-.45-1.67-.45H82.23l-8.66-15a3.33 3.33 0 0 0-2.89-1.67H51.43c-.59 0-1.17.16-1.66.45-.5.29-.92.71-1.22 1.22L32.19 29.98l-1.92 3.33H12.96c-.59 0-1.17.16-1.66.45-.5.29-.93.71-1.22 1.22L.45 51.66a3.323 3.323 0 0 0 0 3.34l18.28 31.67-8.66 15a3.32 3.32 0 0 0 0 3.34l9.62 16.67c.3.51.72.93 1.22 1.22s1.07.45 1.67.45h36.56l8.66 15a3.35 3.35 0 0 0 2.89 1.67h19.25a3.34 3.34 0 0 0 2.89-1.67l18.28-31.67h17.32c.6 0 1.17-.16 1.67-.45s.92-.71 1.22-1.22l9.62-16.67a3.323 3.323 0 0 0 0-3.34ZM51.44 3.33 61.07 20l-9.63 16.66h76.98l-9.62 16.66H45.67l-11.54-20zM57.21 120H22.58l9.63-16.67h19.25l-38.5-66.67h19.25l9.62 16.67L68.78 100l-11.55 20Zm61.59-33.34-9.62-16.67-38.49 66.67-9.63-16.67 9.63-16.66 26.94-46.67h23.1l17.32 30z"/></svg>';

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en" class="dark">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
  <title>Qwen Code Chat Export</title>
  <!-- Load React and ReactDOM from CDN -->
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

  <!-- Manually create the jsxRuntime object to satisfy the dependency -->
  <script>
    // Provide a minimal JSX runtime for builds that expect react/jsx-runtime globals.
    const withKey = (props, key) =>
      key == null ? props : Object.assign({}, props, { key });
    const jsx = (type, props, key) => React.createElement(type, withKey(props, key));
    const jsxRuntime = {
      Fragment: React.Fragment,
      jsx,
      jsxs: jsx,
      jsxDEV: jsx
    };

    window.ReactJSXRuntime = jsxRuntime;
    window['react/jsx-runtime'] = jsxRuntime;
    window['react/jsx-dev-runtime'] = jsxRuntime;
  </script>

  <!-- Load the webui library from CDN -->
  <script src="https://unpkg.com/@qwen-code/webui@0.1.0-beta.4/dist/index.umd.js"></script>

  <!-- Load the CSS -->
  <link rel="stylesheet" href="https://unpkg.com/@qwen-code/webui@0.1.0-beta.4/dist/styles.css">
  
  <!-- Load Google Font for Logo -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">

  <style>
    :root {
      --bg-primary: #18181b;
      --bg-secondary: #27272a;
      --text-primary: #f4f4f5;
      --text-secondary: #a1a1aa;
      --border-color: #3f3f46;
      --accent-color: #3b82f6;
    }

    body {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      margin: 0;
      padding: 0;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    .page-wrapper {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .header {
      width: 100%;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-color);
      background-color: rgba(24, 24, 27, 0.95);
      backdrop-filter: blur(8px);
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-sizing: border-box;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .logo-icon svg {
      width: 100%;
      height: 100%;
    }

    /* Logo Styles */
    .logo {
      display: flex;
      flex-direction: column;
      line-height: 1;
    }

    .logo-text {
      font-family: 'Press Start 2P', cursive;
      font-weight: 400;
      font-size: 24px;
      letter-spacing: -0.05em;
      position: relative;
      color: white; /* Fallback */
    }

    .logo-text-inner {
      background: linear-gradient(to right, #60a5fa, #a855f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      position: relative;
      z-index: 2;
    }

    /* Echo effect */
    .logo-text::before,
    .logo-text::after {
      content: attr(data-text);
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 1;
      background: none;
      -webkit-text-fill-color: transparent;
      -webkit-text-stroke: 1px rgba(96, 165, 250, 0.3);
    }

    .logo-text::before {
      transform: translate(2px, 2px);
      -webkit-text-stroke: 1px rgba(168, 85, 247, 0.3);
    }

    .logo-text::after {
      transform: translate(4px, 4px);
      opacity: 0.4;
    }

    .logo-sub {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-top: 4px;
    }

    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background-color: var(--bg-secondary);
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
      font-weight: 500;
    }

    .meta {
      display: flex;
      gap: 24px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .meta-label {
      color: #71717a;
    }

    .chat-container {
      width: 100%;
      max-width: 900px;
      padding: 40px 20px;
      box-sizing: border-box;
      flex: 1;
    }

    /* Scrollbar styling */
    ::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }

    ::-webkit-scrollbar-track {
      background: var(--bg-primary);
    }

    ::-webkit-scrollbar-thumb {
      background: var(--bg-secondary);
      border-radius: 5px;
      border: 2px solid var(--bg-primary);
    }

    ::-webkit-scrollbar-thumb:hover {
      background: #52525b;
    }

    /* Responsive adjustments */
    @media (max-width: 768px) {
      .chat-container {
        max-width: 100%;
        padding: 20px 16px;
      }

      .header {
        padding: 12px 16px;
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
      }

      .header-left {
        width: 100%;
        justify-content: space-between;
      }

      .meta {
        width: 100%;
        flex-direction: column;
        gap: 6px;
      }
    }

    @media (max-width: 480px) {
      .chat-container {
        padding: 16px 12px;
      }
    }
  </style>
</head>

<body>
  <div class="page-wrapper">
    <div class="header">
      <div class="header-left">
        <div class="logo-icon">${FAVICON_SVG}</div>
        <div class="logo">
          <div class="logo-text" data-text="QWEN">
            <span class="logo-text-inner">QWEN</span>
          </div>
        </div>
      </div>
      <div class="meta">
        <div class="meta-item">
          <span class="meta-label">Session Id</span>
          <span id="session-id" class="font-mono">-</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Export Time</span>
          <span id="session-date">-</span>
        </div>
      </div>
    </div>

    <div id="chat-root-no-babel" class="chat-container"></div>
  </div>

  <script id="chat-data" type="application/json">
    // DATA_PLACEHOLDER: Chat export data will be injected here
  </script>

  <script>
    const chatDataElement = document.getElementById('chat-data');
    const chatData = chatDataElement?.textContent
      ? JSON.parse(chatDataElement.textContent)
      : {};
    const rawMessages = Array.isArray(chatData.messages) ? chatData.messages : [];
    const messages = rawMessages.filter((record) => record && record.type !== 'system');

    // Populate metadata
    const sessionIdElement = document.getElementById('session-id');
    if (sessionIdElement && chatData.sessionId) {
      sessionIdElement.textContent = chatData.sessionId;
    }

    const sessionDateElement = document.getElementById('session-date');
    if (sessionDateElement && chatData.startTime) {
      try {
        const date = new Date(chatData.startTime);
        sessionDateElement.textContent = date.toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch (e) {
        sessionDateElement.textContent = chatData.startTime;
      }
    }

    // Get the ChatViewer and Platform components from the global object
    const { ChatViewer, PlatformProvider } = QwenCodeWebUI;

    // Define a minimal platform context for web usage
    const platformContext = {
      platform: 'web',
      postMessage: (message) => {
        console.log('Posted message:', message);
      },
      onMessage: (handler) => {
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
      },
      openFile: (path) => {
        console.log('Opening file:', path);
      },
      getResourceUrl: (resource) => {
        return null;
      },
      features: {
        canOpenFile: false,
        canCopy: true
      }
    };

    // Render the ChatViewer component without Babel
    const rootElementNoBabel = document.getElementById('chat-root-no-babel');

    // Create the ChatViewer element wrapped with PlatformProvider using React.createElement (no JSX)
    const ChatAppNoBabel = React.createElement(PlatformProvider, { value: platformContext },
      React.createElement(ChatViewer, {
        messages,
        autoScroll: false,
        theme: 'dark'
      })
    );

    ReactDOM.render(ChatAppNoBabel, rootElementNoBabel);
  </script>
</body>

</html>
`;

function escapeJsonForHtml(json) {
  return json
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function injectDataIntoHtmlTemplate(template, data) {
  const jsonData = JSON.stringify(data, null, 2);
  const escapedJsonData = escapeJsonForHtml(jsonData);
  return template.replace(
    /<script id="chat-data" type="application\/json">\s*\/\/ DATA_PLACEHOLDER:.*?\s*<\/script>/s,
    `<script id="chat-data" type="application/json">\n${escapedJsonData}\n    </script>`,
  );
}

function toHtml(sessionData) {
  return injectDataIntoHtmlTemplate(HTML_TEMPLATE, sessionData);
}

function printUsage(exitCode) {
  const msg = `
Usage:
  node scripts/export-html-from-chatrecord-jsonl.js <input.jsonl> [--out <output.html>]
  node scripts/export-html-from-chatrecord-jsonl.js - [--out <output.html>]

Notes: 
  - Input JSONL is expected to be "one ChatRecord per line".
  - For convenience, this also supports JSONL generated by the existing "toJsonl" formatter
    (first line is { type: "session_metadata", ... } then one ExportMessage per line).
`;
  console.error(msg.trimEnd());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    input: null,
    output: null,
  };

  const args = argv.slice(2);
  if (args.length === 0) return out;

  out.input = args[0] ?? null;
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--out' || a === '-o') {
      out.output = args[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (a === '--help' || a === '-h') {
      printUsage(0);
    }
  }
  return out;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Invalid JSONL line: ${message}\nLine: ${line.slice(0, 200)}`,
    );
  }
}

async function readJsonlObjects(inputPath) {
  const objects = [];

  const inputStream =
    inputPath === '-'
      ? process.stdin
      : fs.createReadStream(inputPath, { encoding: 'utf8' });

  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = String(rawLine).trim();
    if (!line) continue;
    objects.push(safeJsonParse(line));
  }

  return objects;
}

function looksLikeChatRecord(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const r = obj;
  return (
    typeof r.uuid === 'string' &&
    'parentUuid' in r &&
    typeof r.sessionId === 'string' &&
    typeof r.timestamp === 'string' &&
    typeof r.type === 'string' &&
    typeof r.cwd === 'string' &&
    typeof r.version === 'string'
  );
}

function looksLikeExportJsonl(objects) {
  if (!Array.isArray(objects) || objects.length === 0) return false;
  const first = objects[0];
  return (
    !!first &&
    typeof first === 'object' &&
    first.type === 'session_metadata' &&
    typeof first.sessionId === 'string' &&
    typeof first.startTime === 'string'
  );
}

function computeStartTimeFromRecords(records) {
  let min = Number.POSITIVE_INFINITY;
  for (const r of records) {
    const t = Date.parse(r.timestamp);
    if (Number.isFinite(t)) min = Math.min(min, t);
  }
  if (!Number.isFinite(min)) {
    return new Date().toISOString();
  }
  return new Date(min).toISOString();
}

function extractToolNameFromRecord(record) {
  const parts = record?.message?.parts;
  if (!Array.isArray(parts)) return '';
  for (const part of parts) {
    if (part && typeof part === 'object' && 'functionResponse' in part) {
      const fr = part.functionResponse;
      if (fr && typeof fr === 'object' && typeof fr.name === 'string') {
        return fr.name;
      }
    }
  }
  return '';
}

const TOOL_NAME_MIGRATION = {
  search_file_content: 'grep_search',
  replace: 'edit',
};

const TOOL_DISPLAY_NAME_BY_NAME = {
  edit: 'Edit',
  write_file: 'WriteFile',
  read_file: 'ReadFile',
  read_many_files: 'ReadManyFiles',
  grep_search: 'Grep',
  glob: 'Glob',
  run_shell_command: 'Shell',
  todo_write: 'TodoWrite',
  save_memory: 'SaveMemory',
  task: 'Task',
  skill: 'Skill',
  exit_plan_mode: 'ExitPlanMode',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  list_directory: 'ListFiles',
};

const TOOL_KIND_BY_NAME = {
  read_file: 'read',
  read_many_files: 'read',
  skill: 'read',
  edit: 'edit',
  write_file: 'edit',
  write: 'edit',
  delete: 'delete',
  move: 'move',
  rename: 'move',
  grep_search: 'search',
  glob: 'search',
  web_search: 'search',
  list_directory: 'search',
  run_shell_command: 'execute',
  bash: 'execute',
  web_fetch: 'fetch',
  todo_write: 'think',
  save_memory: 'think',
  plan: 'think',
  exit_plan_mode: 'switch_mode',
  task: 'other',
};

function normalizeToolName(toolName) {
  if (!toolName) return '';
  return TOOL_NAME_MIGRATION[toolName] ?? toolName;
}

function resolveToolKind(toolName) {
  const normalizedName = normalizeToolName(toolName);
  return TOOL_KIND_BY_NAME[normalizedName] ?? 'other';
}

function resolveToolTitle(toolName) {
  const normalizedName = normalizeToolName(toolName);
  return (
    TOOL_DISPLAY_NAME_BY_NAME[normalizedName] ?? normalizedName ?? 'tool_call'
  );
}

function normalizeRawInput(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return value;
  return undefined;
}

function extractDiffContent(resultDisplay) {
  if (!resultDisplay || typeof resultDisplay !== 'object') return null;
  const display = resultDisplay;
  if ('fileName' in display && 'newContent' in display) {
    return [
      {
        type: 'diff',
        path: display.fileName,
        oldText: display.originalContent ?? '',
        newText: display.newContent,
      },
    ];
  }
  return null;
}

function transformPartsToToolCallContent(parts) {
  const content = [];
  for (const part of parts ?? []) {
    if (part && typeof part === 'object' && 'text' in part && part.text) {
      content.push({
        type: 'content',
        content: { type: 'text', text: part.text },
      });
      continue;
    }

    if (
      part &&
      typeof part === 'object' &&
      'functionResponse' in part &&
      part.functionResponse
    ) {
      const fr = part.functionResponse;
      const response =
        fr.response && typeof fr.response === 'object' ? fr.response : {};
      const outputField = response.output;
      const errorField = response.error;
      const responseText =
        typeof outputField === 'string'
          ? outputField
          : typeof errorField === 'string'
            ? errorField
            : JSON.stringify(response);
      content.push({
        type: 'content',
        content: { type: 'text', text: responseText },
      });
    }
  }
  return content;
}

function mergeToolCallData(existing, incoming) {
  if (!existing.content || existing.content.length === 0) {
    existing.content = incoming.content;
  }
  if (existing.status === 'pending' || existing.status === 'in_progress') {
    existing.status = incoming.status;
  }
  if (!existing.rawInput && incoming.rawInput) {
    existing.rawInput = incoming.rawInput;
  }
  if ((!existing.title || existing.title === '') && incoming.title) {
    existing.title = incoming.title;
  }
  if ((!existing.kind || existing.kind === 'other') && incoming.kind) {
    existing.kind = incoming.kind;
  }
  if (
    (!existing.locations || existing.locations.length === 0) &&
    incoming.locations?.length
  ) {
    existing.locations = incoming.locations;
  }
  if (!existing.timestamp && incoming.timestamp) {
    existing.timestamp = incoming.timestamp;
  }
}

function convertChatRecordsToSessionData(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      sessionId: 'unknown-session',
      startTime: new Date().toISOString(),
      messages: [],
    };
  }

  const sessionId = records[0]?.sessionId ?? 'unknown-session';
  const startTime = computeStartTimeFromRecords(records);

  const messages = [];
  const toolCallIndexById = new Map();

  let currentMessage = null;
  function flushCurrentMessage() {
    if (!currentMessage) return;
    messages.push({
      uuid: currentMessage.uuid,
      parentUuid: currentMessage.parentUuid,
      sessionId: currentMessage.sessionId,
      timestamp: currentMessage.timestamp,
      type: currentMessage.type,
      message: {
        role: currentMessage.role,
        parts: currentMessage.parts,
      },
      model: currentMessage.model,
    });
    currentMessage = null;
  }

  function handleMessageChunk(
    record,
    roleType,
    content,
    messageRole = roleType,
  ) {
    if (!content || content.type !== 'text' || !content.text) return;
    if (
      currentMessage &&
      (currentMessage.type !== roleType || currentMessage.role !== messageRole)
    ) {
      flushCurrentMessage();
    }

    if (
      currentMessage &&
      currentMessage.type === roleType &&
      currentMessage.role === messageRole
    ) {
      currentMessage.parts.push({ text: content.text });
      return;
    }

    currentMessage = {
      uuid: record.uuid,
      parentUuid: record.parentUuid,
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      type: roleType,
      role: messageRole,
      parts: [{ text: content.text }],
      model: record.model,
    };
  }

  function addOrMergeToolCallMessage(toolCallMessage) {
    const id = toolCallMessage?.toolCall?.toolCallId;
    if (!id) {
      messages.push(toolCallMessage);
      return;
    }

    const existingIndex = toolCallIndexById.get(id);
    if (existingIndex === undefined) {
      toolCallIndexById.set(id, messages.length);
      messages.push(toolCallMessage);
      return;
    }

    const existing = messages[existingIndex];
    if (!existing || existing.type !== 'tool_call' || !existing.toolCall) {
      return;
    }
    mergeToolCallData(existing.toolCall, toolCallMessage.toolCall);
  }

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    switch (record.type) {
      case 'user': {
        for (const part of record.message?.parts ?? []) {
          if (part && typeof part === 'object' && 'text' in part && part.text) {
            handleMessageChunk(
              record,
              'user',
              { type: 'text', text: part.text },
              'user',
            );
          }
        }
        break;
      }

      case 'assistant': {
        for (const part of record.message?.parts ?? []) {
          if (part && typeof part === 'object' && 'text' in part && part.text) {
            const isThought = (part.thought ?? false) === true;
            handleMessageChunk(
              record,
              'assistant',
              { type: 'text', text: part.text },
              isThought ? 'thinking' : 'assistant',
            );
            continue;
          }

          if (
            part &&
            typeof part === 'object' &&
            'functionCall' in part &&
            part.functionCall
          ) {
            flushCurrentMessage();
            const fc = part.functionCall;
            const toolName = normalizeToolName(
              typeof fc.name === 'string' ? fc.name : '',
            );
            // Match ToolCallEmitter behavior: skip tool_call start event for todo_write.
            if (toolName === 'todo_write') {
              continue;
            }
            const toolCallId =
              typeof fc.id === 'string' && fc.id
                ? fc.id
                : `${toolName || 'tool'}-${record.uuid}`;
            const toolCallMessage = {
              uuid: record.uuid,
              parentUuid: record.parentUuid,
              sessionId: record.sessionId,
              timestamp: record.timestamp,
              type: 'tool_call',
              toolCall: {
                toolCallId,
                kind: resolveToolKind(toolName),
                title: resolveToolTitle(toolName),
                status: 'in_progress',
                rawInput: normalizeRawInput(fc.args),
                timestamp: Date.parse(record.timestamp),
              },
            };
            addOrMergeToolCallMessage(toolCallMessage);
          }
        }
        break;
      }

      case 'tool_result': {
        flushCurrentMessage();

        const toolCallResult = record.toolCallResult ?? {};
        const toolCallId = toolCallResult.callId ?? record.uuid;
        const toolName = normalizeToolName(extractToolNameFromRecord(record));
        const rawInput = normalizeRawInput(toolCallResult.args);

        const content =
          extractDiffContent(toolCallResult.resultDisplay) ??
          transformPartsToToolCallContent(record.message?.parts ?? []);

        const toolCallMessage = {
          uuid: record.uuid,
          parentUuid: record.parentUuid,
          sessionId: record.sessionId,
          timestamp: record.timestamp,
          type: 'tool_call',
          toolCall: {
            toolCallId,
            kind: resolveToolKind(toolName),
            title: resolveToolTitle(toolName),
            status: toolCallResult.error ? 'failed' : 'completed',
            rawInput,
            content,
            timestamp: Date.parse(record.timestamp),
          },
        };

        addOrMergeToolCallMessage(toolCallMessage);
        break;
      }

      default: {
        // Skip system records or unknown types.
        break;
      }
    }
  }

  flushCurrentMessage();

  return { sessionId, startTime, messages };
}

function buildSessionDataFromExportJsonl(objects) {
  const first = objects[0];
  const sessionId = first.sessionId;
  const startTime = first.startTime;
  const messages = objects.slice(1);
  return { sessionId, startTime, messages };
}

function defaultOutPathForInput(inputPath) {
  if (!inputPath || inputPath === '-')
    return path.resolve(process.cwd(), 'export.html');
  const base = path.basename(inputPath, path.extname(inputPath));
  const dir = path.dirname(inputPath);
  return path.resolve(dir, `${base}.html`);
}

async function main() {
  const { input, output } = parseArgs(process.argv);
  if (!input) {
    printUsage(1);
  }

  const objects = await readJsonlObjects(input);
  if (objects.length === 0) {
    throw new Error('Input JSONL is empty.');
  }

  let sessionData;
  if (looksLikeExportJsonl(objects)) {
    sessionData = buildSessionDataFromExportJsonl(objects);
  } else if (objects.every(looksLikeChatRecord)) {
    sessionData = convertChatRecordsToSessionData(objects);
  } else if (objects.some(looksLikeChatRecord)) {
    // Mixed input: keep only ChatRecord-like entries for best-effort export.
    const records = objects.filter(looksLikeChatRecord);
    sessionData = convertChatRecordsToSessionData(records);
  } else {
    throw new Error(
      'Unrecognized JSONL format (expected ChatRecord-per-line).',
    );
  }

  const html = toHtml(sessionData);
  const outPath = output ? path.resolve(output) : defaultOutPathForInput(input);

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, html, 'utf8');
  console.log(`Wrote HTML export to: ${outPath}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
