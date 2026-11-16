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
import type { SendAnalysis } from './analysis-request.js';

const bridge = vi.hoisted(() => ({
  events: new Map<string, (value: unknown) => void>(),
  connect: vi.fn(),
  callServerTool: vi.fn(),
  sendMessage: vi.fn(),
  getHostCapabilities: vi.fn(),
  getHostContext: vi.fn(),
  onclose: undefined as (() => void) | undefined,
  onteardown: undefined as (() => Promise<object>) | undefined,
  props: undefined as
    | {
        report: ShowData;
        query?: (input: ReportQuery, signal: AbortSignal) => Promise<QueryData>;
        connectionNotice?: string;
        sendAnalysis?: SendAnalysis;
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
  bridge.sendMessage.mockReset().mockResolvedValue({});
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
  it('restores the saved effective view and keeps group queries bound to its report', async () => {
    await boot();
    const view = {
      schemaVersion: 1,
      reportId: snapshot.reportId,
      sections: [
        { kind: 'failure-list', groupBy: 'file', columns: ['duration'] },
      ],
    };
    await act(async () =>
      bridge.events.get('toolresult')!(showResult(snapshot, view)),
    );
    expect(bridge.props?.report.view).toEqual(view);
    const query = {
      kind: 'list',
      collection: 'failures',
      failureIds: ['f0:a1'],
    } as const;
    const input: ReportQuery = { ...query, failureIds: [...query.failureIds] };
    bridge.callServerTool.mockResolvedValue(queryReport(snapshot, input));
    await bridge.props!.query!(input, new AbortController().signal);
    expect(bridge.callServerTool.mock.calls[0][0]).toEqual({
      name: 'test_report_query',
      arguments: { reportId: snapshot.reportId, query: input },
    });
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps unknown saved layouts readable without host query or message capabilities', async () => {
    bridge.getHostCapabilities.mockReturnValue({});
    await boot();
    const fixed = showResult(snapshot).structuredContent!;
    await act(async () =>
      bridge.events.get('toolresult')!({
        structuredContent: {
          ...fixed,
          viewResolution: { mode: 'generated', digest: 'c'.repeat(64) },
          view: {
            schemaVersion: 99,
            reportId: snapshot.reportId,
            sections: [],
          },
        },
      }),
    );
    expect(bridge.props?.report.viewResolution).toEqual({
      mode: 'fixed',
      reason: 'unsupported-view',
    });
    expect(bridge.props?.report.summary).toEqual(fixed['summary']);
    expect(bridge.props?.report.firstPage).toBeUndefined();
    expect(bridge.props?.query).toBeUndefined();
    expect(bridge.props?.sendAnalysis).toBeUndefined();
    expect(bridge.callServerTool).not.toHaveBeenCalled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

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

  it.each([{}, { message: {} }, { message: { image: {} } }])(
    'keeps copying as the only handoff without explicit text message capability: %j',
    async (capabilities) => {
      bridge.getHostCapabilities.mockReturnValue(capabilities);
      await boot();
      expect(bridge.props?.sendAnalysis).toBeUndefined();
      expect(bridge.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('calls standard ui/message with one user text block, a 120-second timeout and a cancellable signal', async () => {
    bridge.getHostCapabilities.mockReturnValue({ message: { text: {} } });
    await boot();
    expect(bridge.props?.query).toBeUndefined();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    const controller = new AbortController();
    await expect(
      bridge.props!.sendAnalysis!(['f0:a1'], controller.signal),
    ).resolves.toEqual({});
    const [message, options] = bridge.sendMessage.mock.calls[0] as [
      { role: string; content: Array<{ type: string; text: string }> },
      { timeout: number; signal: AbortSignal },
    ];
    expect(message.role).toBe('user');
    expect(message.content).toHaveLength(1);
    expect(message.content[0].type).toBe('text');
    expect(message.content[0].text).toContain(
      'do not modify files or rerun tests',
    );
    expect(message.content[0].text).not.toContain(
      'preserves the failing assertion',
    );
    expect(message.content[0].text).not.toContain('/fixture-workspace');
    expect(
      JSON.parse(
        message.content[0].text.slice(message.content[0].text.indexOf('\n')),
      ),
    ).toEqual({ reportId: snapshot.reportId, itemIds: ['f0:a1'] });
    expect(options.timeout).toBe(120_000);
    expect(options.signal.aborted).toBe(false);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });

  it('accepts 20 observed failures across pages and rejects 21 without silently dropping IDs', async () => {
    const failure = snapshot.files
      .flatMap((file) => file.items)
      .find((item) => item.status === 'failed')!;
    const many: ReportSnapshot = {
      ...snapshot,
      computed: {
        ...snapshot.computed,
        fileEntries: 1,
        passedFiles: 0,
        failedFiles: 1,
        assertions: 21,
        failures: 21,
        statuses: { ...snapshot.computed.statuses, passed: 0, failed: 21 },
      },
      reported: {
        ...snapshot.reported,
        numTotalTestSuites: 1,
        numPassedTestSuites: 0,
        numFailedTestSuites: 1,
        numTotalTests: 21,
        numPassedTests: 0,
        numFailedTests: 21,
      },
      files: [
        {
          ...snapshot.files[0],
          items: Array.from({ length: 21 }, (_, index) => ({
            ...failure,
            itemId: `f0:a${index}`,
            assertionIndex: index,
            path: 'fixture.ts',
            fullName: `failure ${index}`,
            title: `failure ${index}`,
          })),
        },
      ],
    };
    bridge.getHostCapabilities.mockReturnValue({
      serverTools: {},
      message: { text: {} },
    });
    bridge.connect.mockImplementation(async () =>
      bridge.events.get('toolresult')!(showResult(many)),
    );
    await boot();
    const query = { kind: 'list', collection: 'failures', limit: 50 } as const;
    bridge.callServerTool.mockResolvedValue(queryReport(many, query));
    await bridge.props!.query!(query, new AbortController().signal);
    const twenty = Array.from({ length: 20 }, (_, index) => `f0:a${index}`);
    await expect(
      bridge.props!.sendAnalysis!(twenty, new AbortController().signal),
    ).resolves.toEqual({});
    const text = (
      bridge.sendMessage.mock.calls[0][0] as {
        content: Array<{ text: string }>;
      }
    ).content[0].text;
    expect(JSON.parse(text.slice(text.indexOf('\n'))).itemIds).toEqual(twenty);
    await expect(
      bridge.props!.sendAnalysis!(
        [...twenty, 'f0:a20'],
        new AbortController().signal,
      ),
    ).rejects.toThrow('1–20 unique');
    expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ids: ['f0:a0'] },
    { ids: ['f9:error'] },
    { ids: ['f0:a1', 'f0:a1'] },
  ])(
    'rejects passed, unknown or duplicated failure references: $ids',
    async ({ ids }) => {
      bridge.getHostCapabilities.mockReturnValue({ message: { text: {} } });
      await boot();
      await expect(
        bridge.props!.sendAnalysis!(ids, new AbortController().signal),
      ).rejects.toThrow();
      expect(bridge.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('does not rebind an old sender to a new report', async () => {
    bridge.getHostCapabilities.mockReturnValue({ message: { text: {} } });
    await boot();
    const oldSender = bridge.props!.sendAnalysis!;
    await act(async () =>
      bridge.events.get('toolresult')!(
        showResult({ ...snapshot, reportId: `r1_${'d'.repeat(64)}` }),
      ),
    );
    await expect(
      oldSender(['f0:a1'], new AbortController().signal),
    ).rejects.toThrow('unavailable');
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['close', 'teardown'] as const)(
    'aborts message requests on %s and rejects stale send callbacks',
    async (event) => {
      bridge.getHostCapabilities.mockReturnValue({ message: { text: {} } });
      bridge.sendMessage.mockImplementation(
        (_message: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(new Error('Request aborted')),
              { once: true },
            );
          }),
      );
      await boot();
      const sender = bridge.props!.sendAnalysis!;
      const pending = sender(['f0:a1'], new AbortController().signal);
      const outcome = pending.then(
        () => ({ status: 'resolved' }),
        (error: unknown) => ({ status: 'rejected', error }),
      );
      await act(async () => {
        if (event === 'close') bridge.onclose!();
        else await bridge.onteardown!();
      });
      expect(await outcome).toEqual({
        status: 'rejected',
        error: new Error('Request aborted'),
      });
      expect(bridge.sendMessage.mock.calls[0][1].signal.aborted).toBe(true);
      if (event === 'close') expect(bridge.props?.sendAnalysis).toBeUndefined();
      await expect(
        sender(['f0:a1'], new AbortController().signal),
      ).rejects.toThrow('unavailable');
      expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it('passes rejection and timeout outcomes through without repeating message requests', async () => {
    bridge.getHostCapabilities.mockReturnValue({ message: { text: {} } });
    await boot();
    bridge.sendMessage.mockResolvedValueOnce({ isError: true });
    await expect(
      bridge.props!.sendAnalysis!(['f0:a1'], new AbortController().signal),
    ).resolves.toEqual({ isError: true });
    bridge.sendMessage.mockRejectedValueOnce(new Error('Request timed out'));
    await expect(
      bridge.props!.sendAnalysis!(['f0:a1'], new AbortController().signal),
    ).rejects.toThrow('Request timed out');
    expect(bridge.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not restore message capability when connect settles after transport closure', async () => {
    let finishConnect!: () => void;
    bridge.getHostCapabilities.mockReturnValue({ message: { text: {} } });
    bridge.connect.mockImplementation(() => {
      bridge.events.get('toolresult')!(showResult(snapshot));
      return new Promise<void>((resolve) => {
        finishConnect = resolve;
      });
    });
    await boot();
    await act(async () => bridge.onclose!());
    await act(async () => finishConnect());
    expect(bridge.props?.sendAnalysis).toBeUndefined();
    expect(bridge.props?.connectionNotice).toContain('Connection closed');
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });
});
