#!/usr/bin/env bun
/**
 * browser-tool (secondary path)
 *
 * CLI helper for browser automation workflows in Craft Agents.
 *
 * This helper is intentionally thin and deterministic:
 * - It provides command discovery via --help
 * - It emits structured browser_* tool call templates as JSON
 * - Execution still happens through native browser_* tools in sessions
 */

type CommandSpec = {
  name: string;
  args?: string;
  description: string;
  example: string;
};

type Io = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const COMMANDS: CommandSpec[] = [
  { name: 'help', description: 'Show usage', example: 'browser-tool --help' },
  { name: 'list', description: 'List supported browser_* operations', example: 'browser-tool list' },
  { name: 'template', args: '<operation>', description: 'Print JSON template for one browser_* operation', example: 'browser-tool template browser_navigate' },
  { name: 'all-templates', description: 'Print JSON templates for all browser_* operations', example: 'browser-tool all-templates' },
  { name: 'parse-url', args: '<url>', description: 'Parse a URL and print structured fields for debugging', example: 'browser-tool parse-url file:///tmp/report.html' },
];

const TOOL_TEMPLATES: Record<string, Record<string, unknown>> = {
  browser_open: {},
  browser_navigate: { url: 'https://example.com' },
  browser_snapshot: {},
  browser_click: { ref: '@e1', waitFor: 'network-idle', timeoutMs: 8000 },
  browser_fill: { ref: '@e5', value: 'hello world' },
  browser_select: { ref: '@e3', value: 'option_value' },
  browser_screenshot: {},
  browser_screenshot_region: { ref: '@e12', padding: 8 },
  browser_console: { level: 'warn', limit: 50 },
  browser_window_resize: { width: 1280, height: 720 },
  browser_network: { limit: 50, status: 'failed' },
  browser_wait: { kind: 'network-idle', timeoutMs: 8000 },
  browser_key: { key: 'Enter' },
  browser_downloads: { action: 'list', limit: 20 },
  browser_scroll: { direction: 'down', amount: 500 },
  browser_back: {},
  browser_forward: {},
  browser_evaluate: { expression: 'document.title' },
};

function printHelp(io: Io): void {
  io.log('browser-tool - Browser automation helper for Craft Agents');
  io.log('');
  io.log('Usage:');
  io.log('  bun run browser-tool <command> [args]');
  io.log('  bun run browser-tool --help');
  io.log('');
  io.log('Commands:');
  for (const cmd of COMMANDS) {
    const sig = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
    io.log(`  ${sig.padEnd(28)} ${cmd.description}`);
  }
  io.log('');
  io.log('Notes:');
  io.log('  - Primary execution path is native browser_* tools in sessions.');
  io.log('  - This CLI is a secondary helper for discovery and templating.');
  io.log('');
  io.log('Examples:');
  for (const cmd of COMMANDS) {
    io.log(`  ${cmd.example}`);
  }
}

function printJson(io: Io, value: unknown): void {
  io.log(JSON.stringify(value, null, 2));
}

function getFileBasename(pathname: string): string | null {
  const decodedPath = decodeURIComponent(pathname || '');
  const normalizedPath = decodedPath.replace(/\/+$/, '');
  if (!normalizedPath) return null;
  return normalizedPath.split('/').filter(Boolean).at(-1) || null;
}

export function parseUrlDetails(rawUrl: string): Record<string, unknown> {
  const parsed = new URL(rawUrl);
  const isFile = parsed.protocol === 'file:';

  return {
    href: parsed.href,
    protocol: parsed.protocol,
    host: parsed.host,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    origin: parsed.origin,
    ...(isFile
      ? {
          decodedPath: decodeURIComponent(parsed.pathname || ''),
          basename: getFileBasename(parsed.pathname),
        }
      : {}),
  };
}

export function runBrowserToolCli(argv: string[], io: Io = console): number {
  const args = argv.slice(2);
  const [command = 'help', op] = args;

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp(io);
    return 0;
  }

  if (command === 'list') {
    printJson(io, { operations: Object.keys(TOOL_TEMPLATES) });
    return 0;
  }

  if (command === 'template') {
    if (!op) {
      io.error('Error: template requires <operation>');
      return 1;
    }
    const input = TOOL_TEMPLATES[op];
    if (!input) {
      io.error(`Error: unknown operation "${op}"`);
      return 1;
    }
    printJson(io, { tool: op, input });
    return 0;
  }

  if (command === 'all-templates') {
    const out = Object.entries(TOOL_TEMPLATES).map(([tool, input]) => ({ tool, input }));
    printJson(io, { templates: out });
    return 0;
  }

  if (command === 'parse-url') {
    if (!op) {
      io.error('Error: parse-url requires <url>');
      return 1;
    }

    try {
      printJson(io, { parsed: parseUrlDetails(op) });
      return 0;
    } catch (error) {
      io.error(`Error: invalid URL "${op}"`);
      io.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  io.error(`Error: unknown command "${command}"\n`);
  printHelp(io);
  return 1;
}

if (import.meta.main) {
  process.exit(runBrowserToolCli(process.argv));
}
