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

function render() {
  if (stopped) return;
  root.render(
    report ? (
      <ReportApp
        key={report.reportId}
        report={report}
        query={
          connected && app.getHostCapabilities()?.serverTools
            ? query
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
    report = parsed.data;
    const reportId = report.reportId;
    query = async (input, signal) =>
      readQueryData(
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
  notice =
    'Connection closed. Saved report evidence is still shown; reopen this card to reconnect.';
  render();
};
app.onteardown = async () => {
  stopped = true;
  root.unmount();
  return {};
};
render();
app
  .connect()
  .then(() => {
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
