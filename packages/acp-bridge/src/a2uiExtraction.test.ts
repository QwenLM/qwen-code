/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  splitA2uiText,
  isA2uiToolMeta,
  extractA2uiToolUpdate,
} from './bridgeClient.js';

type Params = Parameters<typeof extractA2uiToolUpdate>[0];

function toolUpdate(opts: {
  toolName?: string;
  serverId?: string;
  text?: string;
  rawOutput?: string;
  sessionUpdate?: string;
}): Params {
  return {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: opts.sessionUpdate ?? 'tool_call_update',
      toolCallId: 'call-1',
      _meta: { toolName: opts.toolName, serverId: opts.serverId },
      ...(opts.text !== undefined
        ? {
            content: [
              { type: 'content', content: { type: 'text', text: opts.text } },
            ],
          }
        : {}),
      ...(opts.rawOutput !== undefined ? { rawOutput: opts.rawOutput } : {}),
    },
  } as unknown as Params;
}

const CMD = (surfaceId: string, kind = 'updateComponents') =>
  `{"version":"v0.9","${kind}":{"surfaceId":"${surfaceId}","components":[]}}`;

describe('splitA2uiText', () => {
  it('extracts a leading array and returns the remaining fallback text', () => {
    const out = splitA2uiText(`[${CMD('s1')}]\nrendered a card`);
    expect(out).not.toBeNull();
    const [commands, fallback] = out!;
    expect(commands).toHaveLength(1);
    expect(fallback).toBe('rendered a card');
  });

  it('tolerates leading whitespace and empty fallback', () => {
    const out = splitA2uiText(`  \n[${CMD('s1')}]`);
    expect(out).not.toBeNull();
    expect(out![1]).toBe('');
  });

  it('handles nested arrays and escaped quotes inside strings', () => {
    const text =
      '[{"version":"v0.9","updateDataModel":{"surfaceId":"s1","path":"/","value":{"rows":[[1,2],[3,4]],"note":"a \\"quoted\\" ] bracket"}}}] tail';
    const out = splitA2uiText(text);
    expect(out).not.toBeNull();
    const [commands, fallback] = out!;
    expect(commands).toHaveLength(1);
    expect(fallback).toBe('tail');
  });

  it('returns null for text not starting with an array', () => {
    expect(splitA2uiText('hello [1,2]')).toBeNull();
    expect(splitA2uiText('{"a":1}')).toBeNull();
  });

  it('returns null for unbalanced brackets', () => {
    expect(splitA2uiText('[{"a":[1,2}')).toBeNull();
  });

  it('returns null for an empty array or invalid JSON', () => {
    expect(splitA2uiText('[] tail')).toBeNull();
    expect(splitA2uiText('[{"a":}] tail')).toBeNull();
  });
});

describe('isA2uiToolMeta', () => {
  it('matches when serverId contains "a2ui" regardless of tool name', () => {
    expect(isA2uiToolMeta({ serverId: 'a2ui-ui', toolName: 'anything' })).toBe(
      true,
    );
    expect(
      isA2uiToolMeta({
        serverId: 'dq-A2UI',
        toolName: 'present_quality_report',
      }),
    ).toBe(true);
  });

  it('falls back to known tool names when serverId is absent', () => {
    expect(isA2uiToolMeta({ toolName: 'mcp__legacy__present_ui' })).toBe(true);
    expect(isA2uiToolMeta({ toolName: 'present_choices' })).toBe(true);
  });

  it('rejects unrelated tools and missing meta', () => {
    expect(
      isA2uiToolMeta({ serverId: 'github', toolName: 'create_issue' }),
    ).toBe(false);
    expect(isA2uiToolMeta(undefined)).toBe(false);
  });
});

describe('extractA2uiToolUpdate', () => {
  it('ignores non tool_call_update notifications and non-a2ui tools', () => {
    expect(
      extractA2uiToolUpdate(
        toolUpdate({
          toolName: 'present_ui',
          serverId: 'a2ui-ui',
          text: `[${CMD('s1')}]`,
          sessionUpdate: 'tool_call',
        }),
      ),
    ).toBeNull();
    expect(
      extractA2uiToolUpdate(
        toolUpdate({ toolName: 'run_shell_command', text: `[${CMD('s1')}]` }),
      ),
    ).toBeNull();
  });

  it('extracts commands, groups by surface, and sanitizes the original frame', () => {
    const text = `[${CMD('s1', 'createSurface')},${CMD('s1')},${CMD('s2')}]\nfallback summary`;
    const result = extractA2uiToolUpdate(
      toolUpdate({
        serverId: 'a2ui-ui',
        toolName: 'mcp__a2ui-ui__present_ui',
        text,
        rawOutput: text,
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.callId).toBe('call-1');
    expect(result!.surfaces.map((s) => s.surfaceId)).toEqual(['s1', 's2']);
    expect(result!.surfaces[0].commands).toHaveLength(2);
    expect(result!.surfaces[1].commands).toHaveLength(1);
    const sanitized = result!.sanitizedParams as unknown as {
      update: {
        content: Array<{ content: { text: string } }>;
        rawOutput: string;
      };
    };
    expect(sanitized.update.content[0].content.text).toBe('fallback summary');
    expect(sanitized.update.rawOutput).toBe('fallback summary');
    expect(sanitized.update.content[0].content.text).not.toContain(
      'createSurface',
    );
  });

  it('accepts updateDataModel-only results and uses the placeholder when fallback is empty', () => {
    const text = `[{"version":"v0.9","updateDataModel":{"surfaceId":"s9","path":"/x","value":1}}]`;
    const result = extractA2uiToolUpdate(
      toolUpdate({ serverId: 'a2ui-ui', text }),
    );
    expect(result).not.toBeNull();
    expect(result!.surfaces).toEqual([
      {
        surfaceId: 's9',
        commands: [
          {
            version: 'v0.9',
            updateDataModel: { surfaceId: 's9', path: '/x', value: 1 },
          },
        ],
      },
    ]);
    const sanitized = result!.sanitizedParams as unknown as {
      update: { content: Array<{ content: { text: string } }> };
    };
    expect(sanitized.update.content[0].content.text).toBe(
      '[A2UI surface rendered]',
    );
  });

  it('returns null when no command carries a surfaceId or text is not a2ui', () => {
    expect(
      extractA2uiToolUpdate(
        toolUpdate({
          serverId: 'a2ui-ui',
          text: '[{"version":"v0.9","noop":{}}]',
        }),
      ),
    ).toBeNull();
    expect(
      extractA2uiToolUpdate(
        toolUpdate({ serverId: 'a2ui-ui', text: 'plain text result' }),
      ),
    ).toBeNull();
  });
});
