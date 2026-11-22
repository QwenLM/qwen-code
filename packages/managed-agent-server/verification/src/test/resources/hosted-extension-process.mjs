import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [mode, evidence, revision] = process.argv.slice(2);
// The process identity is only meaningful on the Linux lane; reading it
// through a guard keeps the fixture runnable where /proc is absent.
const readOrNull = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const stat = () =>
  readOrNull('/proc/self/stat')?.split(') ').at(-1).split(' ')[19] ?? null;
// A held call blocks its own stdin loop on purpose: the stream gates need a
// tool call that is still open while the client disconnects. The release
// marker keeps that wait test-controlled instead of a fixed sleep.
function waitForRelease(marker, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      return true;
    }
    Atomics.wait(sleeper, 0, 0, 50);
  }
  return false;
}
function append(file, value) {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function record(event, fields = {}) {
  append(evidence, {
    event,
    pid: process.pid,
    parentPid: process.ppid,
    startTicks: stat(),
    bootId: readOrNull('/proc/sys/kernel/random/boot_id')?.trim() ?? null,
    cgroup: readOrNull('/proc/self/cgroup')?.trim() ?? null,
    cwd: process.cwd(),
    revision: Number(revision),
    ...fields,
  });
}

if (mode === 'child') {
  record('hook.child');
  setInterval(() => {}, 1000);
} else if (mode === 'hook') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const value = JSON.parse(input);
  record('hook.call', { input: value });
  if (value.tool_input?.value === 'EXT_CANCEL') {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'child', evidence, revision],
      { stdio: 'ignore' },
    );
    record('hook.hold', { childPid: child.pid });
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision:
            value.tool_input?.value === 'EXT_DENY' ? 'deny' : 'allow',
          permissionDecisionReason: 'EXT_DENIED',
        },
      }),
    );
  }
} else if (mode === 'mcp') {
  record('mcp.start');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    record('mcp.request', { method: request.method, requestId: request.id });
    if (request.id === undefined) return;
    let result;
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'extension-proof', version: revision },
        };
        break;
      case 'tools/list':
        result = {
          tools: [
            {
              name: 'append',
              description: 'Append a durable process acceptance proof.',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          ],
        };
        break;
      case 'tools/call': {
        const value = request.params.arguments.value;
        if (request.params.name !== 'append' || !/^EXT_[A-Z_]+$/.test(value))
          throw new Error('Unexpected MCP tool invocation');
        if (value === 'EXT_HOLD') {
          record('mcp.hold', { requestId: request.id, value });
          if (!waitForRelease('EXT_HOLD.release')) {
            record('mcp.hold.timeout', { requestId: request.id, value });
            process.exit(24);
          }
        }
        append('mcp-proof.jsonl', { requestId: request.id, value });
        record('mcp.effect', { requestId: request.id, value });
        if (value === 'EXT_UNKNOWN') process.exit(23);
        result = {
          content: [{ type: 'text', text: `EXT_MCP_${revision}_${value}` }],
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      default:
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Method not found' },
          }) + '\n',
        );
        return;
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n',
    );
  });
  lines.on('close', () => process.exit(0));
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
