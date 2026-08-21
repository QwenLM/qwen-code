// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonWorkspaceActions } from '@qwen-code/webui/daemon-react-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { CodeReviewArtifactDetail } from './CodeReviewArtifactDetail';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

const reviewDocument = {
  schemaVersion: 1,
  target: 'PR #123',
  effort: 'high',
  verdict: {
    event: 'REQUEST_CHANGES',
    verdictLine: 'Verdict: Request changes — C=9 S=4',
    baseEvent: 'REQUEST_CHANGES',
    cappedBy: ['coverage'],
    downgraded: false,
    downgradedFrom: null,
  },
  findings: [
    {
      id: 'R1-1',
      severity: 'Critical',
      confidence: 'high',
      source: 'test',
      summary: 'The request can overwrite another workspace.',
      shortSummary: 'Cross-workspace overwrite',
      failureScenario:
        'Open workspace B and submit a request from workspace A.',
      witness: 'BASE: overwrote workspace B / PR: refused — probe flipped',
      suggestedFix: 'Resolve the runtime before writing.',
      category: 'security',
      locations: [{ file: 'src/write.ts', line: 42, anchor: 'writeFile()' }],
      assets: ['https://example.com/evidence.png', 'javascript:alert(1)'],
      outcome: 'skipped',
      outcomeNote: 'Outside the reviewed diff.',
    },
    {
      id: 'R1-2',
      severity: 'Suggestion',
      confidence: 'low',
      source: 'review',
      summary: 'The label is ambiguous.',
      shortSummary: 'Ambiguous label',
      failureScenario: 'A user cannot distinguish changes from review results.',
      locations: [{ file: 'src/panel.tsx' }],
      heldByMeasurement: { file: 'src/panel.test.tsx' },
    },
    {
      id: 'R1-3',
      severity: 'Nice to have',
      confidence: 'high',
      source: 'review',
      summary: 'The empty state could be shorter.',
      shortSummary: 'Shorten empty state',
      failureScenario: 'The panel uses more vertical space than necessary.',
      locations: [{ file: 'src/empty.tsx' }],
    },
  ],
  counts: {
    total: 14,
    bySeverity: { Critical: 9, Suggestion: 4, 'Nice to have': 1 },
    byConfidence: { high: 11, low: 3 },
    byOutcome: { fixed: 0, skipped: 1, no_change_needed: 0 },
    held: 2,
  },
  outcomesRecorded: false,
  markdownReportPath: '.qwen/reviews/pr-123.md',
};

function renderWith(
  content: string,
  report = '# Durable report',
  language: 'en' | 'zh-CN' = 'en',
) {
  const actions = {
    readWorkspaceFile: vi.fn((path: string) =>
      Promise.resolve({
        content: path.endsWith('.md') ? report : content,
        truncated: false,
      }),
    ),
  } as unknown as DaemonWorkspaceActions;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <CodeReviewArtifactDetail
          workspacePath=".qwen/reviews/pr-123.json"
          workspaceActions={actions}
        />
      </I18nProvider>,
    );
  });
  return { actions, container };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
});

describe('CodeReviewArtifactDetail', () => {
  it('renders authoritative verdict, counts and finding details without recomputing them', async () => {
    const { container } = renderWith(JSON.stringify(reviewDocument));
    await flush();

    expect(container.textContent).toContain(
      'Verdict: Request changes — C=9 S=4',
    );
    expect(container.textContent).toContain('14Total');
    expect(container.textContent).toContain('9Critical');
    expect(container.textContent).toContain('1Nice to have');
    expect(container.textContent).toContain(
      'The empty state could be shorter.',
    );
    expect(container.textContent).toContain('coverage');
    expect(container.textContent).toContain('Source: test');
    expect(container.textContent).toContain('Failure scenario');
    // The executed evidence is the field the witness rule exists to deliver
    // to the author; parsing it and dropping it from display was the measured
    // gap (PR 9065 review R1-3).
    expect(container.textContent).toContain('Witness');
    expect(container.textContent).toContain(
      'BASE: overwrote workspace B / PR: refused — probe flipped',
    );
    expect(container.textContent).toContain('Suggested fix');
    expect(container.textContent).toContain(
      'skipped — Outside the reviewed diff.',
    );
    expect(container.textContent).toContain('src/write.ts:42');
    expect(container.textContent).toContain(
      'Held back from Critical by measurement',
    );
    expect(container.textContent).toContain('src/panel.test.tsx');
  });

  it('localizes the review chrome without translating canonical finding data', async () => {
    const { container } = renderWith(
      JSON.stringify(reviewDocument),
      '# Durable report',
      'zh-CN',
    );
    await flush();

    expect(container.textContent).toContain('权威裁决');
    expect(container.textContent).toContain('打开 Markdown 报告');
    expect(container.textContent).toContain('严重级别');
    expect(container.textContent).toContain('失败场景');
    expect(container.textContent).toContain(
      'The request can overwrite another workspace.',
    );
  });

  it('filters findings by severity and confidence while preserving authoritative counts', async () => {
    const { container } = renderWith(JSON.stringify(reviewDocument));
    await flush();

    const severity = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Severity"]',
    );
    await act(async () => {
      if (severity) {
        severity.value = 'Suggestion';
        severity.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(container.textContent).not.toContain('Cross-workspace overwrite');
    expect(container.textContent).toContain('The label is ambiguous.');
    expect(container.textContent).toContain('9Critical');

    const confidence = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Confidence"]',
    );
    await act(async () => {
      if (confidence) {
        confidence.value = 'high';
        confidence.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(container.textContent).toContain('No findings match these filters.');
  });

  it('allows only safe evidence links', async () => {
    const { container } = renderWith(JSON.stringify(reviewDocument));
    await flush();

    const safe = container.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/evidence.png"]',
    );
    expect(safe?.target).toBe('_blank');
    expect(safe?.rel).toBe('noopener noreferrer');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.textContent).toContain('javascript:alert(1) (not linked)');
  });

  it('opens the Markdown report through workspace actions', async () => {
    const { actions, container } = renderWith(JSON.stringify(reviewDocument));
    await flush();

    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Open Markdown report',
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actions.readWorkspaceFile).toHaveBeenCalledWith(
      '.qwen/reviews/pr-123.md',
    );
    expect(container.textContent).toContain('Durable report');
    expect(
      container.querySelector('a[href=".qwen/reviews/pr-123.md"]'),
    ).toBeNull();
  });

  it('ignores a stale Markdown response after switching artifacts', async () => {
    let resolveReport:
      | ((value: { content: string; truncated: false }) => void)
      | undefined;
    const nextDocument = {
      ...reviewDocument,
      target: 'PR #456',
      verdict: {
        ...reviewDocument.verdict,
        verdictLine: 'Verdict: Approve — current artifact',
      },
    };
    const actions = {
      readWorkspaceFile: vi.fn((path: string) => {
        if (path === '.qwen/reviews/pr-123.json') {
          return Promise.resolve({
            content: JSON.stringify(reviewDocument),
            truncated: false,
          });
        }
        if (path === '.qwen/reviews/pr-123.md') {
          return new Promise<{ content: string; truncated: false }>(
            (resolve) => {
              resolveReport = resolve;
            },
          );
        }
        return Promise.resolve({
          content: JSON.stringify(nextDocument),
          truncated: false,
        });
      }),
    } as unknown as DaemonWorkspaceActions;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <CodeReviewArtifactDetail
            workspacePath=".qwen/reviews/pr-123.json"
            artifactVersion="1"
            workspaceActions={actions}
          />
        </I18nProvider>,
      );
    });
    await flush();
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((item) => item.textContent === 'Open Markdown report')
        ?.click();
    });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <CodeReviewArtifactDetail
            workspacePath=".qwen/reviews/pr-456.json"
            artifactVersion="2"
            workspaceActions={actions}
          />
        </I18nProvider>,
      );
    });
    await flush();
    await act(async () => {
      resolveReport?.({ content: '# Stale report', truncated: false });
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'Verdict: Approve — current artifact',
    );
    expect(container.textContent).not.toContain('Stale report');
  });

  it.each([
    ['malformed JSON', '{not-json', 'Malformed code review JSON'],
    [
      'unsupported version',
      JSON.stringify({ ...reviewDocument, schemaVersion: 2 }),
      'Unsupported code review schemaVersion',
    ],
    [
      'invalid structure',
      JSON.stringify({ ...reviewDocument, counts: { total: 2 } }),
      'counts.bySeverity must be an object',
    ],
    [
      'traversing report path',
      JSON.stringify({
        ...reviewDocument,
        markdownReportPath: '../outside.md',
      }),
      'markdownReportPath must be a relative .md path',
    ],
    [
      'absolute report path',
      JSON.stringify({
        ...reviewDocument,
        markdownReportPath: '/etc/review.md',
      }),
      'markdownReportPath must be a relative .md path',
    ],
    [
      'non-Markdown report path',
      JSON.stringify({
        ...reviewDocument,
        markdownReportPath: '.qwen/reviews/report.json',
      }),
      'markdownReportPath must be a relative .md path',
    ],
    [
      'report path outside the reviews directory',
      JSON.stringify({
        ...reviewDocument,
        markdownReportPath: 'docs/report.md',
      }),
      'markdownReportPath must be a file under .qwen/reviews/',
    ],
  ])('shows a dedicated error for %s', async (_name, content, expected) => {
    const { container } = renderWith(content);
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      expected,
    );
    expect(container.querySelector('.cm-editor')).toBeNull();
  });

  it('resets filters when switching artifacts', async () => {
    const firstDocument = JSON.stringify(reviewDocument);
    const secondDocument = JSON.stringify({
      ...reviewDocument,
      target: 'PR #456',
    });
    const actions = {
      readWorkspaceFile: vi.fn((path: string) =>
        Promise.resolve({
          content: path.endsWith('pr-123.json')
            ? firstDocument
            : secondDocument,
          truncated: false,
        }),
      ),
    } as unknown as DaemonWorkspaceActions;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <CodeReviewArtifactDetail
            workspacePath=".qwen/reviews/pr-123.json"
            artifactVersion="1"
            workspaceActions={actions}
          />
        </I18nProvider>,
      );
    });
    await flush();
    const severity = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Severity"]',
    );
    await act(async () => {
      if (severity) {
        severity.value = 'Critical';
        severity.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(severity?.value).toBe('Critical');

    act(() => {
      root.render(
        <I18nProvider language="en">
          <CodeReviewArtifactDetail
            workspacePath=".qwen/reviews/pr-456.json"
            artifactVersion="2"
            workspaceActions={actions}
          />
        </I18nProvider>,
      );
    });
    await flush();

    // A filter left over from the previous artifact would show "no matches"
    // next to a nonzero total; the switch resets both filters instead.
    expect(container.textContent).toContain('PR #456');
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Severity"]',
      )?.value,
    ).toBe('all');
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Confidence"]',
      )?.value,
    ).toBe('all');
  });

  it('renders local assetFiles as workspace images and bare paths', async () => {
    const createdUrls: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => {
        const url = `blob:evidence-${createdUrls.length}`;
        createdUrls.push(url);
        return url;
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const assetDocument = {
      ...reviewDocument,
      findings: [
        {
          ...reviewDocument.findings[2],
          assetFiles: ['.qwen/tmp/shots/evidence.png', '.qwen/tmp/notes.txt'],
        },
      ],
    };
    const actions = {
      readWorkspaceFile: vi.fn().mockResolvedValue({
        content: JSON.stringify(assetDocument),
        truncated: false,
      }),
      readFileBytes: vi.fn().mockResolvedValue({
        contentBase64: btoa('img'),
        offset: 0,
        returnedBytes: 3,
        sizeBytes: 3,
      }),
      stat: vi.fn().mockResolvedValue({ sizeBytes: 3, modifiedMs: 1 }),
    } as unknown as DaemonWorkspaceActions;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <CodeReviewArtifactDetail
            workspacePath=".qwen/reviews/pr-123.json"
            workspaceActions={actions}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const image = container.querySelector<HTMLImageElement>(
      'img[alt=".qwen/tmp/shots/evidence.png"]',
    );
    expect(image?.src).toBe('blob:evidence-0');
    expect(actions.readFileBytes).toHaveBeenCalledWith(
      '.qwen/tmp/shots/evidence.png',
      expect.objectContaining({ offset: 0 }),
    );
    // A non-image assetFile stays a bare path and is never fetched.
    expect(container.textContent).toContain('.qwen/tmp/notes.txt');
    expect(actions.readFileBytes).toHaveBeenCalledTimes(1);
  });

  it('offers the derived Markdown report when the artifact is invalid', async () => {
    const { actions, container } = renderWith('{not-json');
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Malformed code review JSON',
    );
    const fallback = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Open Markdown report',
    );
    expect(fallback).not.toBeUndefined();
    await act(async () => {
      fallback?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actions.readWorkspaceFile).toHaveBeenCalledWith(
      '.qwen/reviews/pr-123.md',
    );
    expect(container.textContent).toContain('Durable report');
  });

  it('offers the derived Markdown report when the artifact is truncated', async () => {
    const actions = {
      readWorkspaceFile: vi.fn((path: string) =>
        Promise.resolve({
          content: path.endsWith('.md') ? '# Durable report' : 'partial',
          truncated: !path.endsWith('.md'),
        }),
      ),
    } as unknown as DaemonWorkspaceActions;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <CodeReviewArtifactDetail
            workspacePath=".qwen/reviews/pr-123.json"
            workspaceActions={actions}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'truncated',
    );
    const fallback = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Open Markdown report',
    );
    await act(async () => {
      fallback?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Durable report');
  });

  it('does not re-read the artifact or reset filters on a language switch', async () => {
    const actions = {
      readWorkspaceFile: vi.fn().mockResolvedValue({
        content: JSON.stringify(reviewDocument),
        truncated: false,
      }),
    } as unknown as DaemonWorkspaceActions;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const renderAt = (language: 'en' | 'zh-CN') =>
      act(() => {
        root.render(
          <I18nProvider language={language}>
            <CodeReviewArtifactDetail
              workspacePath=".qwen/reviews/pr-123.json"
              workspaceActions={actions}
            />
          </I18nProvider>,
        );
      });

    renderAt('en');
    await flush();
    const severity = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Severity"]',
    );
    await act(async () => {
      if (severity) {
        severity.value = 'Critical';
        severity.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(severity?.value).toBe('Critical');

    renderAt('zh-CN');
    await flush();

    expect(actions.readWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('严重级别');
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="严重级别"]',
      )?.value,
    ).toBe('Critical');
  });

  it('fails closed for truncated input', async () => {
    const actions = {
      readWorkspaceFile: vi.fn().mockResolvedValue({
        content: JSON.stringify(reviewDocument),
        truncated: true,
      }),
    } as unknown as DaemonWorkspaceActions;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <CodeReviewArtifactDetail
            workspacePath=".qwen/reviews/pr-123.json"
            workspaceActions={actions}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'truncated',
    );
  });

  it('routes evidence link clicks through the desktop opener', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    try {
      const { container } = renderWith(JSON.stringify(reviewDocument));
      await flush();

      const link = Array.from(container.querySelectorAll('a')).find(
        (anchor) =>
          anchor.getAttribute('href') === 'https://example.com/evidence.png',
      );
      expect(link).toBeDefined();

      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      act(() => {
        link!.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
        url: 'https://example.com/evidence.png',
      });
    } finally {
      delete (window as { __TAURI__?: unknown }).__TAURI__;
    }
  });
});
