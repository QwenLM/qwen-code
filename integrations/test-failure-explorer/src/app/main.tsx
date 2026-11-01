/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';
import {
  readQueryData,
  readToolData,
  showSchema,
  type ShowData,
  type ReportQuery,
  type QueryData,
} from '../app-contract.js';
import { ReportApp } from './App.js';
import { analysisRequestText, type SendAnalysis } from './analysis-request.js';
import './styles.css';

const app = new App(
  { name: 'test-failure-explorer', version: '1.0.0' },
  {},
  { strict: true, autoResize: true },
);
const root = createRoot(globalThis.document.getElementById('root')!);
let report: ShowData | undefined;
let query:
  | ((input: ReportQuery, signal: AbortSignal) => Promise<QueryData>)
  | undefined;
let connected = false;
let stopped = false;
let notice = 'Connecting to the report host…';
let sendAnalysis: SendAnalysis | undefined;
let knownFailureIds = new Set<string>();
const lifetime = new AbortController();

function render() {
  if (stopped) return;
  root.render(
    report ? (
      <ReportApp
        key={`${report.reportId}:${report.viewResolution.mode === 'generated' ? report.viewResolution.digest : 'fixed'}`}
        report={report}
        query={
          connected && app.getHostCapabilities()?.serverTools
            ? query
            : undefined
        }
        sendAnalysis={
          connected && app.getHostCapabilities()?.message?.text
            ? sendAnalysis
            : undefined
        }
        connectionNotice={notice}
      />
    ) : (
      <p role="status">{notice || 'Waiting for a saved report…'}</p>
    ),
  );
}

function theme() {
  const current = app.getHostContext()?.theme;
  if (current) applyDocumentTheme(current);
}

app.addEventListener('toolresult', (result) => {
  try {
    const parsed = showSchema.safeParse(readToolData(result));
    if (!parsed.success)
      throw new Error(
        'Unsupported or invalid saved report. Show this report again from the conversation.',
      );
    if (report?.reportId !== parsed.data.reportId) knownFailureIds = new Set();
    report = parsed.data;
    const reportId = report.reportId;
    const failures = knownFailureIds;
    for (const item of report.firstPage?.items ?? []) {
      if (item.status === 'failed') failures.add(item.itemId);
    }
    query = async (input, signal) => {
      const result = readQueryData(
        readToolData(
          await app.callServerTool(
            {
              name: 'test_report_query',
              arguments: { reportId, query: input },
            },
            { signal },
          ),
        ),
        reportId,
        input,
      );
      if (result.kind === 'list') {
        for (const item of result.items) {
          if (item.status === 'failed') failures.add(item.itemId);
        }
      }
      return result;
    };
    sendAnalysis = async (failureIds, signal) => {
      if (
        stopped ||
        !connected ||
        report?.reportId !== reportId ||
        !app.getHostCapabilities()?.message?.text ||
        signal.aborted ||
        failureIds.some((id) => !failures.has(id))
      ) {
        throw new Error(
          'This report request is unavailable. Check the host and original conversation.',
        );
      }
      return app.sendMessage(
        {
          role: 'user',
          content: [
            { type: 'text', text: analysisRequestText(reportId, failureIds) },
          ],
        },
        {
          signal: AbortSignal.any([signal, lifetime.signal]),
          timeout: 120_000,
        },
      );
    };
    notice = '';
  } catch (error) {
    notice =
      error instanceof Error
        ? error.message
        : 'The saved report is unavailable.';
  }
  render();
});
app.addEventListener('hostcontextchanged', theme);
app.onclose = () => {
  connected = false;
  lifetime.abort();
  notice =
    'Connection closed. Saved report evidence is still shown; reopen this card to reconnect.';
  render();
};
app.onteardown = async () => {
  stopped = true;
  connected = false;
  lifetime.abort();
  root.unmount();
  return {};
};
render();
app
  .connect()
  .then(() => {
    if (stopped || lifetime.signal.aborted) return;
    connected = true;
    if (notice === 'Connecting to the report host…') notice = '';
    theme();
    render();
  })
  .catch(() => {
    notice =
      'Unable to connect to the report host. Use the text result in the conversation.';
    render();
  });
