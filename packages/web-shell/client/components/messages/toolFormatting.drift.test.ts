import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOL_DISPLAY_NAMES } from './toolFormatting';
import { getToolDescription } from './toolFormatting';

// The web-shell is a browser bundle and deliberately does not depend on
// `@qwen-code/qwen-code-core` (see the note in toolFormatting.ts), so we
// can't import core's `ToolNames` at runtime to compare against. Instead,
// read the wire names straight from core's source and assert this map
// covers each one — a build-time drift guard equivalent to the CLI's
// `tool-display-map.test.ts`, so a tool added to core can't silently leak a
// raw internal name (e.g. `run_shell_command`) into the web panel via the
// `?? name` / verbatim fallback.
const toolNamesSource = readFileSync(
  fileURLToPath(
    new URL('../../../../core/src/tools/tool-names.ts', import.meta.url),
  ),
  'utf8',
);
const toolFormattingSource = readFileSync(
  fileURLToPath(new URL('./toolFormatting.ts', import.meta.url)),
  'utf8',
);
const coreToolNameUtilsSource = readFileSync(
  fileURLToPath(
    new URL('../../../../core/src/utils/tool-name-utils.ts', import.meta.url),
  ),
  'utf8',
);

function coreWireToolNames(): string[] {
  const block = toolNamesSource.match(
    /export const ToolNames = \{([\s\S]*?)\} as const;/,
  );
  if (!block) {
    throw new Error('could not locate `export const ToolNames` in core source');
  }
  // Each enumerated tool is a `KEY: 'wire_name',` line. Computer-use tools are
  // intentionally not enumerated in core's ToolNames, so they're out of scope
  // here too.
  return [...block[1].matchAll(/^\s*[A-Z0-9_]+:\s*'([^']+)',/gm)].map(
    (m) => m[1],
  );
}

describe('TOOL_DISPLAY_NAMES drift vs core ToolNames', () => {
  it('sanity-checks that core wire names were parsed', () => {
    const wireNames = coreWireToolNames();
    expect(wireNames).toContain('run_shell_command');
    expect(wireNames.length).toBeGreaterThan(20);
  });

  it('has a display-name entry for every core wire tool name', () => {
    const missing = coreWireToolNames().filter(
      (wire) => !(wire in TOOL_DISPLAY_NAMES),
    );
    expect(missing).toEqual([]);
  });

  it('keeps the provider-name mirror aligned for overlength MCP names', () => {
    for (const source of [toolFormattingSource, coreToolNameUtilsSource]) {
      expect(source).toContain('const MAX_TOOL_NAME_LENGTH = 63;');
      expect(source).toContain(
        'const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;',
      );
      expect(source).toContain('2166136261');
      expect(source).toContain('16777619');
      expect(source).toContain(".toString(36).padStart(7, '0')");
      expect(source).toContain('MAX_TOOL_NAME_LENGTH - suffix.length');
    }
    const toolName =
      'mcp__github-enterprise_internal_example_com__list_pull__031yve4';
    expect(
      getToolDescription({
        callId: 'drift-test',
        toolName,
        title:
          'list_pull_request_review_comments (github-enterprise.internal.example.com MCP Server): {}',
        args: {},
        status: 'completed',
      }),
    ).toBe(
      'list_pull_request_review_comments (github-enterprise.internal.example.com MCP Server)',
    );
  });
});
