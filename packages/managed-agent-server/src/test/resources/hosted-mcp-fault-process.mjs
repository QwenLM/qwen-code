import { closeSync, existsSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, evidence, revision] = process.argv.slice(2);

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
    revision: Number(revision),
    ...fields,
  });
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

// Only a promise that never settles suspends the branch. A bare keep-alive
// timer would let the handler fall through and answer the held request.
async function waitForRelease(file) {
  for (;;) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

if (mode !== 'mcp') throw new Error(`Unknown fixture mode: ${mode}`);

record('mcp.start');
const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  const request = JSON.parse(line);
  record('mcp.request', { method: request.method, requestId: request.id });
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'release-proof', version: revision },
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'append',
            description: 'Append a durable release proof.',
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
    case 'resources/list':
      result = {
        resources: [
          { uri: 'ext://proof', name: 'proof' },
          { uri: 'ext://hold', name: 'hold' },
        ],
      };
      break;
    case 'resources/read': {
      const uri = request.params.uri;
      if (uri === 'ext://hold') {
        record('mcp.hold', { value: uri });
        await waitForRelease(`${evidence}.release`);
        record('mcp.effect', { kind: 'resource_read', value: uri });
        result = {
          contents: [{ uri, mimeType: 'text/plain', text: 'EXT_HELD' }],
        };
        break;
      }
      record('mcp.effect', { kind: 'resource_read', value: uri });
      result = {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `EXT_RESOURCE_${revision}`,
          },
        ],
      };
      break;
    }
    case 'prompts/list':
      result = {
        prompts: [{ name: 'proof', description: 'Release proof prompt.' }],
      };
      break;
    case 'prompts/get':
      record('mcp.effect', { kind: 'prompt_get', value: request.params.name });
      result = {
        description: 'Release proof prompt.',
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `EXT_PROMPT_${revision}` },
          },
        ],
      };
      break;
    case 'tools/call': {
      const value = request.params.arguments.value;
      append('mcp-proof.jsonl', { requestId: request.id, value });
      record('mcp.effect', { kind: 'tool_call', value });
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
  respond(request.id, result);
});
lines.on('close', () => {
  record('mcp.exit');
  process.exit(0);
});
