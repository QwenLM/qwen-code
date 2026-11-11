/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Layout tests for the /crontab task table.
 *
 * These assert column geometry from the rendered frame, which is what the
 * feature is actually about. Eyeballing a terminal cannot prove that a CJK row
 * and an ASCII row put their EXPIRY value in the same column; comparing
 * character offsets can.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { CrontabDialog } from './CrontabDialog.js';

const NOW = Date.now();

/**
 * Terminal width the component sees. Mutated per test rather than passed
 * through the render harness, because the component reads its width from
 * useTerminalSize and that is the input whose effect we are asserting.
 */
let mockCols = 160;

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: mockCols, rows: 40 }),
}));

const tasks = [
  {
    id: 'aaaa1111',
    cron: '30 14 * * *',
    // Deliberately CJK: double-width characters are what broke padEnd-based
    // alignment, so the fixture has to contain them.
    prompt: '测试任务 C（持久化 / 每天 14:30）：检查工作区状态并汇总',
    createdAt: NOW,
    recurring: true,
    expiresAt: NOW + 30 * 86_400_000,
    // Has run, cost money, and carries both ceilings, so the usage cell has a
    // spend-against-limit to render.
    fireCount: 3,
    creditsUsed: 12.5,
    maxTurns: 10,
    maxCredits: 50,
  },
  {
    id: 'bbbb2222',
    cron: '0 9 * * 1',
    prompt: 'Short ASCII prompt',
    createdAt: NOW,
    recurring: true,
    permanent: true,
    // Exactly one of each, to catch the singular. formatCredits(1) is "1.00", so
    // a plural decided from the formatted string never reaches the singular.
    fireCount: 1,
    creditsUsed: 1,
  },
  {
    id: 'cccc3333',
    // cronToHuman cannot phrase this one, so the second schedule line must be
    // omitted rather than repeat the expression.
    cron: '0 10 15 8 *',
    prompt: 'Unphraseable schedule',
    createdAt: NOW,
  },
];

/** Session-tab tasks. Mutable so one case can populate that tab. */
let sessionTasks: unknown[] = [];

vi.mock('@qwen-code/core', async () => {
  const actual =
    await vi.importActual<typeof import('@qwen-code/core')>('@qwen-code/core');
  return {
    ...actual,
    CONFIG_DIR: 'project config',
    readCronTasks: vi.fn(async () => tasks),
  };
});

/**
 * Renders the dialog against a Config whose cron manager holds the current
 * session-tab fixture.
 *
 * The dialog no longer reads a module-level session store — it reads the one
 * belonging to the session whose Config the context hands it — so the fixture
 * has to be seeded there rather than into a mocked free function.
 */
async function renderDialog(width: number) {
  const { makeFakeConfig } = await import('@qwen-code/core');
  const config = makeFakeConfig();
  const cronManager = config.getCronManager();
  for (const task of sessionTasks) {
    cronManager.tasks.add(task as import('@qwen-code/core').CronTask);
  }
  mockCols = width;
  return renderWithProviders(<CrontabDialog onExit={() => {}} />, {
    width,
    config,
  });
}

/** Frame lines that belong to the task table, in render order. */
function tableLines(frame: string): string[] {
  return frame.split('\n');
}

function lineWith(frame: string, needle: string): string {
  const line = tableLines(frame).find((l) => l.includes(needle));
  if (line === undefined) {
    throw new Error(
      `no line containing ${JSON.stringify(needle)} in frame:\n${frame}`,
    );
  }
  return line;
}

/**
 * Column offset of a value, measured the way a terminal sees it. `indexOf`
 * counts UTF-16 units, which is exactly the mistake this feature fixes, so the
 * prefix is measured by display width instead.
 */
async function columnOf(line: string, needle: string): Promise<number> {
  const at = line.indexOf(needle);
  expect(
    at,
    `${JSON.stringify(needle)} not found in ${JSON.stringify(line)}`,
  ).toBeGreaterThanOrEqual(0);
  const { default: stringWidth } = await import('string-width');
  return stringWidth(line.slice(0, at));
}

/**
 * Wait until the rendered frame satisfies `ready`.
 *
 * The dialog loads its tasks asynchronously, so a fixed sleep races the load
 * and made this suite intermittently see an empty table.
 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  ready: (frame: string) => boolean,
  what: string,
): Promise<string> {
  const deadline = Date.now() + 3000;
  let frame = lastFrame() ?? '';
  while (!ready(frame)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last frame:\n${frame}`);
    }
    await new Promise((r) => setTimeout(r, 10));
    frame = lastFrame() ?? '';
  }
  return frame;
}

describe('CrontabDialog task table layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionTasks = [];
  });

  async function renderPersistentTab(width: number) {
    const { lastFrame, unmount, stdin } = await renderDialog(width);
    // Tab once to move from the Session tab to Persistent.
    stdin.write('\t');
    const frame = await waitForFrame(
      lastFrame,
      (f) => f.includes('SCHEDULE') && f.includes('30 14 * * *'),
      'the persistent tab to list its tasks',
    );
    unmount();
    return frame;
  }

  it('shows the configured directory for an empty persistent task list', async () => {
    const { readCronTasks } = await import('@qwen-code/core');
    vi.mocked(readCronTasks).mockResolvedValueOnce([]);
    const { lastFrame, stdin, unmount } = await renderDialog(160);
    try {
      stdin.write('\t');
      const frame = await waitForFrame(
        lastFrame,
        (text) => text.includes('No persistent tasks.'),
        'persistent empty state',
      );
      expect(frame).toContain('project config/scheduled_tasks.json');
    } finally {
      unmount();
    }
  });

  it('renders a header naming every column', async () => {
    const frame = await renderPersistentTab(160);
    const header = lineWith(frame, 'SCHEDULE');
    expect(header).toContain('TASK');
    expect(header).toContain('EXPIRY');
    expect(header).toContain('USAGE');
    expect(header).toContain('OWNER');
  });

  it('puts fires and lifetime cost under the usage heading', async () => {
    const frame = await renderPersistentTab(160);
    // The fixture's first task has run and cost something; its row must say so
    // under USAGE rather than leaving the column blank.
    const row = lineWith(frame, '30 14 * * *');
    expect(row).toContain('3/10 turns');
    // Spelled out, not abbreviated: the unit of the one number here that is money
    // should not need decoding.
    expect(row).toContain('12.5/50 credits');

    const usageCol = await columnOf(lineWith(frame, 'SCHEDULE'), 'USAGE');
    const valueCol = await columnOf(row, '3/10 turns');
    expect(valueCol).toBe(usageCol);
  });

  it('says "1 turn" and "1 credit", not "1 turns" and "1.00 credits"', async () => {
    const frame = await renderPersistentTab(170);
    const row = lineWith(frame, '0 9 * * 1');
    expect(row).toContain('1 turn ');
    expect(row).toContain('1.00 credit ');
    expect(row).not.toContain('1 turns');
    expect(row).not.toContain('credits');
  });

  it('shows an unmetered spend as a dash, not as zero', async () => {
    // Its own render with its own single task, so the assertion does not depend on
    // which row the shared fixture list happens to highlight.
    sessionTasks = [
      {
        id: 'unmetered',
        cron: '0 6 * * *',
        prompt: 'Ceiling set, never metered',
        createdAt: NOW,
        recurring: true,
        maxCredits: 40,
      },
    ];
    const { lastFrame, unmount } = await renderDialog(170);
    const frame = await waitForFrame(
      lastFrame,
      (f) => f.includes('SCHEDULE') && f.includes('0 6 * * *'),
      'the session tab to list the unmetered task',
    );
    unmount();
    sessionTasks = [];

    // "0/40" would report the task as having cost nothing, which is a different
    // claim from having no measurement. The detail view says "—" for this state
    // and the list has to agree.
    const row = lineWith(frame, '0 6 * * *');
    expect(row).toContain('—/40 credits');
    expect(row).not.toContain('0/40');
  });

  it('leaves the usage column empty for a task that has never fired', async () => {
    const frame = await renderPersistentTab(160);
    // Third fixture task has no fireCount. An unfired task must not read as
    // "0 runs · 0 cr", which would look like a task that ran and cost nothing.
    const row = lineWith(frame, '0 10 15 8 *');
    expect(row).not.toContain('turns');
    expect(row).not.toContain('credits');
  });

  it('puts the header directly above the schedule column', async () => {
    const frame = await renderPersistentTab(160);
    const headerCol = await columnOf(lineWith(frame, 'SCHEDULE'), 'SCHEDULE');
    const cronCol = await columnOf(lineWith(frame, '30 14 * * *'), '30 14');
    expect(headerCol).toBe(cronCol);
  });

  it('aligns a CJK row and an ASCII row on the same column boundaries', async () => {
    const frame = await renderPersistentTab(160);
    const cjkRow = lineWith(frame, '测试任务 C');
    const asciiRow = lineWith(frame, 'Short ASCII prompt');

    // The owner value sits after the prompt, the column whose content differs
    // in display width between these two rows. Equal offsets mean nothing
    // before it leaked out of its column. Both fixtures are unclaimed, so the
    // same marker can be compared directly.
    expect(await columnOf(cjkRow, 'unclaimed')).toBe(
      await columnOf(asciiRow, 'unclaimed'),
    );
  });

  it('shows the expression on the first line and its reading on the second', async () => {
    const frame = await renderPersistentTab(160);
    const lines = tableLines(frame);
    const cronIdx = lines.findIndex((l) => l.includes('30 14 * * *'));
    expect(cronIdx).toBeGreaterThanOrEqual(0);

    const reading = lines[cronIdx + 1] ?? '';
    expect(reading).toContain('Every day at 2:30 PM');
    // The reading is indented into the schedule column, not the gutter.
    expect(await columnOf(reading, 'Every day')).toBe(
      await columnOf(lines[cronIdx], '30 14'),
    );
  });

  it('omits the second line when cronToHuman only echoes the expression', async () => {
    const frame = await renderPersistentTab(160);
    const lines = tableLines(frame);
    const idx = lines.findIndex((l) => l.includes('Unphraseable schedule'));
    expect(idx).toBeGreaterThanOrEqual(0);
    // Whatever follows must not repeat the expression as a reading.
    const next = lines[idx + 1] ?? '';
    expect(next.includes('0 10 15 8 *')).toBe(false);
  });

  it('gives every expression a reading', async () => {
    // cronToHuman covers all valid expressions now, and the reading has its own
    // full-width line, so even a long phrase shows in full rather than being
    // clipped to the schedule column.
    const frame = await renderPersistentTab(160);
    const readings = [
      'Every day at 2:30 PM', // 30 14 * * *
      'Every Monday at 9:00 AM', // 0 9 * * 1
      'At 10:00 AM on the 15th in August', // 0 10 15 8 *  (shown whole)
    ];
    for (const reading of readings) {
      expect(frame, `missing reading ${reading}`).toContain(reading);
    }
  });

  it('carries the selection colour onto the reading line', async () => {
    // A selected row used to highlight the expression and prompt while leaving
    // the reading dim, which looked half-applied. Row 1 is selected by default;
    // its expression and its reading must open with the same SGR colour.
    const frame = await renderPersistentTab(160);
    const lines = frame.split('\n');
    // eslint-disable-next-line no-control-regex
    const colourOf = (s: string) => s.match(/\u001B\[([0-9;]*)m/)?.[1] ?? '';
    const exprLine = lines.find((l) => l.includes('30 14 * * *')) ?? '';
    const readingLine =
      lines.find((l) => l.includes('Every day at 2:30 PM')) ?? '';
    expect(exprLine).not.toBe('');
    expect(readingLine).not.toBe('');
    expect(colourOf(readingLine)).toBe(colourOf(exprLine));
  });

  it('keeps ambiguous-width glyphs out of the fixed-width columns', async () => {
    // U+26A0 and friends are measured as one column by ink and drawn as two by
    // many terminals, which silently shifts every column after them.
    const frame = await renderPersistentTab(160);
    for (const glyph of ['\u26A0', '\u23F0', '\uFE0F']) {
      expect(frame.includes(glyph), `frame contains ${escape(glyph)}`).toBe(
        false,
      );
    }
  });

  it('drops the widest columns on a narrow terminal but keeps the task', async () => {
    const frame = await renderPersistentTab(80);
    const header = lineWith(frame, 'SCHEDULE');
    expect(header).toContain('TASK');
    // OWNER is the widest optional column and does not fit alongside a
    // readable prompt at 80 columns.
    expect(header).not.toContain('OWNER');
    // Rows must still be present and not wrapped into extra lines.
    expect(frame).toContain('30 14 * * *');
  });

  it('keeps every column on a wide terminal', async () => {
    const frame = await renderPersistentTab(200);
    const header = lineWith(frame, 'SCHEDULE');
    for (const col of ['TASK', 'EXPIRY', 'OWNER']) {
      expect(header).toContain(col);
    }
  });

  describe('session tab', () => {
    it('uses the same table, without the expiry and owner columns', async () => {
      // The Session tab renders through the same component with showExpiry off
      // and ownership suppressed, so it needs its own coverage rather than
      // inheriting the Persistent tab's.
      sessionTasks = [
        {
          id: 'sess0001',
          cron: '*/5 * * * *',
          prompt: '检查队列深度',
          createdAt: NOW,
          recurring: true,
          // Session counters live in memory, and the panel reports them like
          // any other task's while the session is alive.
          fireCount: 2,
          creditsUsed: 0.8,
        },
      ];
      const { lastFrame, unmount } = await renderDialog(160);
      const frame = await waitForFrame(
        lastFrame,
        (f) => f.includes('SCHEDULE') && f.includes('*/5 * * * *'),
        'the session tab to list its task',
      );
      unmount();

      const header = lineWith(frame, 'SCHEDULE');
      expect(header).toContain('TASK');
      // Session tasks never expire on a schedule and are owned by definition.
      expect(header).not.toContain('EXPIRY');
      expect(header).not.toContain('OWNER');
      // Usage is not one of those: a session task runs and costs money, and the
      // in-memory counters are as worth showing as a durable task's.
      expect(header).toContain('USAGE');
      expect(lineWith(frame, '*/5 * * * *')).toContain('2 turns');

      // Header still sits above the expression, and the reading is on line two.
      expect(await columnOf(header, 'SCHEDULE')).toBe(
        await columnOf(lineWith(frame, '*/5 * * * *'), '*/5'),
      );
      const lines = tableLines(frame);
      const cronIdx = lines.findIndex((l) => l.includes('*/5 * * * *'));
      expect(lines[cronIdx + 1] ?? '').toContain('Every 5 minutes');
    });
  });

  describe('detail view', () => {
    /**
     * Persistent tab, then Enter to open the highlighted task.
     *
     * Which row starts highlighted depends on next-fire ordering, so the cases
     * below assert on fields every task has rather than on one task's values.
     */
    async function openFirstTaskDetail(width = 160) {
      const { lastFrame, unmount, stdin } = await renderDialog(width);
      stdin.write('\t');
      await waitForFrame(
        lastFrame,
        (f) => f.includes('SCHEDULE') && f.includes('30 14 * * *'),
        'the persistent tab to list its tasks',
      );
      stdin.write('\r');
      const frame = await waitForFrame(
        lastFrame,
        (f) => f.includes('Schedule') && f.includes('Prompt'),
        'the task detail view to open',
      );
      unmount();
      return frame;
    }

    it('follows the same convention as the list: expression, then reading below', async () => {
      const frame = await openFirstTaskDetail();
      const lines = tableLines(frame);
      const scheduleIdx = lines.findIndex((l) => l.includes('Schedule'));
      expect(scheduleIdx).toBeGreaterThanOrEqual(0);

      // The Schedule row carries the raw expression, not the phrasing.
      const scheduleLine = lines[scheduleIdx];
      expect(scheduleLine).toMatch(/\d+ \d+ \*/);
      // The old single-line form put the phrasing first with the expression in
      // parentheses; that must be gone.
      expect(scheduleLine).not.toContain('(');

      // The phrasing follows on the next line.
      expect(lines[scheduleIdx + 1] ?? '').toMatch(/Every /);
    });

    // The degenerate case (cronToHuman echoing the expression) is the same
    // one-line condition here as in the list, and the list covers it. A detail
    // view case would have to navigate to a specific row, and row order depends
    // on the current date, so such a test would pass vacuously whenever the
    // walk landed elsewhere.

    it('shows spend against each ceiling', async () => {
      const frame = await openFirstTaskDetail();
      const lines = tableLines(frame);

      // Asserted as a shape rather than one task's numbers: which row starts
      // highlighted depends on next-fire ordering, and a case that assumed the
      // first fixture would silently change subject as fixtures are added.
      const turnsIdx = lines.findIndex((l) => l.includes('Turns'));
      const creditsIdx = lines.findIndex((l) => l.includes('Credits'));
      // At least one of the two rows must render — every fixture either has fired
      // or carries a ceiling.
      expect(Math.max(turnsIdx, creditsIdx)).toBeGreaterThanOrEqual(0);

      // Spend and ceiling on one line where a ceiling exists: a total without its
      // limit leaves the reader guessing how much room is left.
      if (turnsIdx >= 0) {
        expect(lines[turnsIdx]).toMatch(/Turns\s+\d+( \/ \d+)?/);
      }
      if (creditsIdx >= 0) {
        expect(lines[creditsIdx]).toMatch(/Credits\s+(\d|—)/);
      }
    });
  });
});
