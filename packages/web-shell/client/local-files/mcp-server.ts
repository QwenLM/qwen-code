/**
 * The browser side of the local-files bridge: a minimal MCP server that answers
 * the daemon's reverse-channel JSON-RPC and executes every call against the
 * user-granted directory.
 *
 * Hand-rolled rather than the MCP SDK — the daemon's client only drives
 * initialize / tools/list / tools/call (plus prompts/resources probes, which
 * get empty answers), and pulling the SDK into the browser bundle for four
 * methods is not a trade worth making.
 *
 * The handshake must be idempotent: one `mcp_register` drives a full discovery
 * pass per registration target, so a session-bound bridge is initialized more
 * than once (measured: 2 handshakes for one session).
 */

import type {
  LocalListResult,
  LocalReadResult,
  LocalSearchResult,
  LocalWriteResult,
} from './local-directory.js';
import { LocalDirectoryError } from './local-directory.js';

export const LOCAL_FILES_SERVER_NAME = 'local-files';
export const LOCAL_FILES_SERVER_VERSION = '1.0.0';
/** Fallback when the client does not state one; we echo whatever it sends. */
export const LOCAL_FILES_PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The slice of {@link LocalDirectory} this server drives. */
export interface LocalFilesFs {
  readonly name: string;
  list(path: string, limit?: number): Promise<LocalListResult>;
  read(path: string, offset?: number, limit?: number): Promise<LocalReadResult>;
  write(path: string, content: string): Promise<LocalWriteResult>;
  search(
    pattern: string,
    options?: { path?: string; maxFiles?: number; maxBytes?: number },
  ): Promise<LocalSearchResult>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PATH_PROPERTY = {
  type: 'string',
  description:
    'Path relative to the granted directory. Absolute paths, ".." and backslashes are rejected.',
};

function buildTools(rootName: string): ToolDefinition[] {
  const where = `These files live on the USER'S OWN MACHINE (the browser side of the bridge), not in the daemon workspace. The granted directory is "${rootName}".`;
  return [
    {
      name: 'list_directory',
      description: `List one directory of the user's local filesystem. ${where}`,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            ...PATH_PROPERTY,
            description: `${PATH_PROPERTY.description} Empty or "." lists the granted root.`,
          },
          limit: {
            type: 'number',
            description: 'Maximum entries to return (capped by the bridge).',
          },
        },
      },
    },
    {
      name: 'read_file',
      description: `Read a text file from the user's local filesystem. ${where}`,
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_PROPERTY,
          offset: {
            type: 'number',
            description: '0-based first line to return.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to return.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: `Overwrite (or create) one text file on the user's local filesystem. Intermediate directories are created. There is no partial-edit tool: read the file first, then write its full new content. ${where}`,
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_PROPERTY,
          content: {
            type: 'string',
            description: 'Full new content of the file.',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'search_files',
      description: `Case-sensitive literal substring search across text files of the user's local filesystem (not a regex). Reports the scan budget it used, and says so when it stopped early. ${where}`,
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Literal substring to look for.',
          },
          path: {
            ...PATH_PROPERTY,
            description: `${PATH_PROPERTY.description} Empty searches the whole granted directory.`,
          },
          maxFiles: { type: 'number' },
          maxBytes: { type: 'number' },
        },
        required: ['pattern'],
      },
    },
  ];
}

function textResult(text: string): { content: Array<Record<string, unknown>> } {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): {
  content: Array<Record<string, unknown>>;
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Keeps the -32601 mapping in one place instead of a bare throw. */
class MethodNotFound extends Error {}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function paramsOf(message: JsonRpcRequest): Record<string, unknown> {
  return recordOf(message.params);
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

function numberParam(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function formatListing(result: LocalListResult): string {
  if (result.entries.length === 0) return '(empty directory)';
  const lines = result.entries.map((entry) =>
    entry.kind === 'directory'
      ? `dir   ${entry.path}/`
      : `file  ${entry.size === undefined ? '?' : entry.size}  ${entry.path}`,
  );
  if (result.truncated) {
    lines.push(
      `(listing stopped at ${result.limit} entries; narrow the path to see the rest)`,
    );
  }
  return lines.join('\n');
}

function formatHits(result: LocalSearchResult): string {
  const lines = result.hits.map(
    (hit) => `${hit.path}:${hit.line}: ${hit.text.trim()}`,
  );
  // Naming the skips matters most when there are no hits: otherwise "no match"
  // hides that part of the tree was never opened.
  const skipped =
    result.filesSkipped > 0
      ? `, skipped ${result.filesSkipped} (binary or over the read limit)`
      : '';
  const budget = `scanned ${result.filesScanned} file(s), ${result.bytesScanned} bytes${skipped}`;
  const note = result.truncated
    ? `\n(stopped early: hit the ${result.truncatedBy} budget after ${budget})`
    : '';
  if (result.hits.length === 0) {
    // A truncated scan with zero hits is not "the pattern does not exist":
    // without the note the model would act on a false negative.
    return `No match for "${result.pattern}" (${budget}).${note}`;
  }
  return `${lines.join('\n')}\n\n${result.hits.length} hit(s), ${budget}.${note}`;
}

export class LocalFilesMcpServer {
  constructor(private readonly fs: LocalFilesFs) {}

  /**
   * Answer one inbound JSON-RPC message. Returns `undefined` for notifications,
   * which must not be replied to.
   */
  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const id = message.id === undefined ? null : message.id;
    const isNotification = message.id === undefined || message.id === null;
    const method = message.method;

    if (isNotification) {
      // `notifications/initialized` and friends need no reply.
      return undefined;
    }

    try {
      const result = await this.dispatch(method, paramsOf(message));
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (err instanceof LocalDirectoryError) {
        // A filesystem problem is a TOOL result, not a protocol error, so the
        // model sees the reason and can act on it.
        return { jsonrpc: '2.0', id, result: errorResult(err.message) };
      }
      if (err instanceof MethodNotFound) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${err.message}` },
        };
      }
      const unknown = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: unknown },
      };
    }
  }

  private async dispatch(
    method: string | undefined,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = stringParam(params, 'protocolVersion');
        return {
          protocolVersion: requested ?? LOCAL_FILES_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: LOCAL_FILES_SERVER_NAME,
            version: LOCAL_FILES_SERVER_VERSION,
          },
          instructions: `The "${this.fs.name}" directory is on the user's own machine, reachable only through these tools. Paths are relative to that directory.`,
        };
      }
      case 'tools/list':
        return { tools: buildTools(this.fs.name) };
      case 'tools/call':
        return this.callTool(
          stringParam(params, 'name') ?? '',
          recordOf(params['arguments']),
        );
      case 'prompts/list':
        return { prompts: [] };
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'ping':
        return {};
      default:
        throw new MethodNotFound(String(method ?? '(none)'));
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      switch (name) {
        case 'list_directory': {
          const listing = await this.fs.list(
            stringParam(args, 'path') ?? '',
            numberParam(args, 'limit'),
          );
          return textResult(formatListing(listing));
        }
        case 'read_file': {
          const path = stringParam(args, 'path');
          if (path === undefined) {
            return errorResult('`path` is required.');
          }
          const result = await this.fs.read(
            path,
            numberParam(args, 'offset') ?? 0,
            numberParam(args, 'limit'),
          );
          const note = result.truncated
            ? `\n\n(showing ${result.returnedLines} of ${result.totalLines} lines; pass ` +
              '`offset`/`limit` to page further)'
            : '';
          return textResult(`${result.content}${note}`);
        }
        case 'write_file': {
          const path = stringParam(args, 'path');
          const content = stringParam(args, 'content');
          if (path === undefined) {
            return errorResult('`path` is required.');
          }
          if (content === undefined) {
            return errorResult(
              '`content` is required. write_file replaces the whole file, so pass its complete new content.',
            );
          }
          const result: LocalWriteResult = await this.fs.write(path, content);
          return textResult(
            `${result.created ? 'Created' : 'Wrote'} ${result.path} (${result.bytes} bytes) on the user's machine.`,
          );
        }
        case 'search_files': {
          const pattern = stringParam(args, 'pattern');
          if (pattern === undefined || pattern === '') {
            return errorResult('`pattern` is required and must not be empty.');
          }
          const path = stringParam(args, 'path');
          const result = await this.fs.search(pattern, {
            ...(path === undefined ? {} : { path }),
            ...(numberParam(args, 'maxFiles') === undefined
              ? {}
              : { maxFiles: numberParam(args, 'maxFiles') }),
            ...(numberParam(args, 'maxBytes') === undefined
              ? {}
              : { maxBytes: numberParam(args, 'maxBytes') }),
          });
          return textResult(formatHits(result));
        }
        default:
          return errorResult(`Unknown tool "${name}".`);
      }
    } catch (err) {
      if (err instanceof LocalDirectoryError) return errorResult(err.message);
      throw err;
    }
  }
}
