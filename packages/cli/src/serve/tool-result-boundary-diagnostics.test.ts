/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createToolResultBoundaryDiagnostics,
  TOOL_RESULT_DIAGNOSTIC_LIMIT,
  type ToolResultBoundaryDiagnosticEvent,
} from './tool-result-boundary-diagnostics.js';

describe('tool-result boundary diagnostics', () => {
  it('records only privacy-safe, byte-accurate facts', () => {
    const events: unknown[] = [];
    const observe = createToolResultBoundaryDiagnostics({
      enabled: () => true,
      secret: new Uint8Array(32).fill(7),
      emit: (event) => events.push(event),
    });
    const privateText = 'PRIVATE_PROMPT /Users/private/tool-output';
    observe({
      boundary: 'producer',
      representation: { rawOutput: privateText.repeat(2000) },
      identifiers: { callId: 'call-private', toolName: 'secret_tool' },
    });

    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event['rawUtf8Bytes']).toBeGreaterThan(64 * 1024);
    expect(event['jsonUtf8Bytes']).toBeGreaterThan(64 * 1024);
    expect(JSON.stringify(event)).not.toContain(privateText);
    expect(JSON.stringify(event)).not.toContain('call-private');
    expect(JSON.stringify(event)).not.toContain('/Users/private');
  });

  it('keeps equal representations stable and changes the digest after mutation', () => {
    const events: ToolResultBoundaryDiagnosticEvent[] = [];
    const observe = createToolResultBoundaryDiagnostics({
      enabled: () => true,
      secret: new Uint8Array(32).fill(3),
      emit: (event) => events.push(event),
    });
    const representation = { rawOutput: 'x'.repeat(70_000) };
    observe({ boundary: 'producer', representation });
    observe({ boundary: 'finalizer', representation });
    observe({
      boundary: 'projection',
      representation: { rawOutput: 'y'.repeat(70_000) },
      mutated: true,
    });

    expect(events[0]?.['representationHmac']).toBe(
      events[1]?.['representationHmac'],
    );
    expect(events[2]?.['representationHmac']).not.toBe(
      events[1]?.['representationHmac'],
    );
  });

  it('reports suppressed events after the rate-limit window rolls over', () => {
    const events: ToolResultBoundaryDiagnosticEvent[] = [];
    let clock = 0;
    const observe = createToolResultBoundaryDiagnostics({
      enabled: () => true,
      now: () => clock,
      emit: (event) => events.push(event),
    });
    for (let index = 0; index < TOOL_RESULT_DIAGNOSTIC_LIMIT + 2; index++) {
      observe({ boundary: 'wire', representation: 'z'.repeat(70_000) });
    }
    clock = 60_000;
    observe({ boundary: 'wire', representation: 'z'.repeat(70_000) });

    expect(events).toHaveLength(TOOL_RESULT_DIAGNOSTIC_LIMIT + 1);
    expect(events.at(-1)?.['suppressedCount']).toBe(2);
  });
});
