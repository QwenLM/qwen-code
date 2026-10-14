/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVitestReport } from '../vitest-report.js';
import { queryReport, showResult } from '../report-query.js';
import type { ReportSnapshot } from '../contracts.js';
import type { QueryData, ReportQuery, ShowData } from '../app-contract.js';

const bridge = vi.hoisted(() => ({
  events: new Map<string, (value: unknown) => void>(),
  connect: vi.fn(),
  callServerTool: vi.fn(),
  getHostCapabilities: vi.fn(),
  getHostContext: vi.fn(),
  onclose: undefined as (() => void) | undefined,
  onteardown: undefined as (() => Promise<object>) | undefined,
  props: undefined as
    | {
        report: ShowData;
        query?: (input: ReportQuery, signal: AbortSignal) => Promise<QueryData>;
        connectionNotice?: string;
      }
    | undefined,
  options: undefined as { autoResize?: boolean; strict?: boolean } | undefined,
}));
vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: class {
    constructor(
      _info: unknown,
      _capabilities: unknown,
      options: typeof bridge.options,
    ) {
      bridge.options = options;
      return {
        ...bridge,
        addEventListener: (name: string, callback: (value: unknown) => void) =>
          bridge.events.set(name, callback),
        set onclose(callback: () => void) {
          bridge.onclose = callback;
        },
        set onteardown(callback: () => Promise<object>) {
          bridge.onteardown = callback;
        },
      };
    }
  },
  applyDocumentTheme: vi.fn(),
}));
vi.mock('./App.js', () => ({
  ReportApp: (props: typeof bridge.props) => {
    bridge.props = props;
    return null;
  },
}));

const snapshot: ReportSnapshot = {
  ...parseVitestReport(
    JSON.parse(readFileSync('test-fixtures/mixed.json', 'utf8')),
  ),
  schemaVersion: 1,
  reportId: `r1_${'a'.repeat(64)}`,
  source: { relativePath: 'report.json', sha256: 'b'.repeat(64), bytes: 100 },
  importedAt: '2026-10-11T00:00:00.000Z',
  snapshotChecksum: 'c'.repeat(64),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  bridge.events.clear();
  bridge.props = undefined;
  bridge.getHostCapabilities.mockReturnValue({ serverTools: {} });
  bridge.getHostContext.mockReturnValue({ theme: 'dark' });
  bridge.connect.mockImplementation(async () => {
    expect(bridge.events.has('toolresult')).toBe(true);
    bridge.events.get('toolresult')!(showResult(snapshot));
  });
  globalThis.document.body.innerHTML = '<div id="root"></div>';
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await act(async () => {
    await bridge.onteardown?.();
  });
  globalThis.document.body.replaceChildren();
});

async function boot() {
  await act(async () => {
    await import('./main.js');
  });
}

describe('MCP App bridge', () => {
  it('enables SDK resize notifications when supplying strict connection options', async () => {
    await boot();
    // SDK 1.7.5 defaults autoResize only when the entire options argument is omitted.
    expect(bridge.options?.autoResize).toBe(true);
  });

  it('accepts the initial result during connect and binds queries to that report', async () => {
    await boot();
    expect(bridge.props?.report.reportId).toBe(snapshot.reportId);
    const query = { kind: 'list', collection: 'failures' } as const;
    bridge.callServerTool.mockResolvedValue(queryReport(snapshot, query));
    const controller = new AbortController();
    await expect(
      bridge.props!.query!(query, controller.signal),
    ).resolves.toMatchObject({ reportId: snapshot.reportId, kind: 'list' });
    expect(bridge.callServerTool).toHaveBeenCalledWith(
      {
        name: 'test_report_query',
        arguments: { reportId: snapshot.reportId, query },
      },
      { signal: controller.signal },
    );
  });

  it('keeps a saved result read-only without serverTools capability', async () => {
    bridge.getHostCapabilities.mockReturnValue({});
    await boot();
    expect(bridge.props?.report.reportId).toBe(snapshot.reportId);
    expect(bridge.props?.query).toBeUndefined();
    expect(bridge.callServerTool).not.toHaveBeenCalled();
  });

  it('retains evidence and disables queries after the transport closes', async () => {
    await boot();
    await act(async () => {
      bridge.onclose!();
    });
    expect(bridge.props?.report.reportId).toBe(snapshot.reportId);
    expect(bridge.props?.query).toBeUndefined();
    expect(bridge.props?.connectionNotice).toContain('Connection closed');
  });

  it('does not erase invalid initial-result errors when connect resolves', async () => {
    bridge.connect.mockImplementation(async () => {
      bridge.events.get('toolresult')!({
        structuredContent: {
          ...showResult(snapshot).structuredContent,
          protocolVersion: 2,
        },
      });
    });
    await boot();
    expect(bridge.props).toBeUndefined();
    expect(globalThis.document.body.textContent).toContain(
      'Unsupported or invalid saved report',
    );
  });
});
