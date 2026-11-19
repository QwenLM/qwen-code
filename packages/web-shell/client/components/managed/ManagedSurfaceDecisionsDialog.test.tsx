// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { ManagedSurfaceDecisionsDialog } from './ManagedSurfaceDecisionsDialog';
import {
  MANAGED_SURFACE_CATEGORY_LABELS,
  MANAGED_SURFACE_DECISIONS,
} from './managed-surface-decisions';

const EXPECTED_SURFACE_IDS = [
  'settings',
  'providers',
  'workspace-preflight',
  'tool-toggle',
  'language-sync',
  'workspace-identity',
  'github',
  'workspace-permissions',
  'memory',
  'agents',
  'skill-management',
  'extension-management',
  'hooks',
  'channels',
  'scheduled-tasks',
  'message-deletion',
  'rewind',
  'session-branches',
  'worktree-operations',
  'session-organization',
  'workspace-artifacts',
  'file-mutations',
  'raw-file-reads',
  'attachments',
  'generated-ui-state',
  'session-sources',
  'right-panels',
  'voice',
  'browser-automation',
  'mcp-pool',
  'lsp',
  'sub-session-send',
  'mid-turn-send-now',
  'live-state',
  'session-probes',
] as const;

const SPECIFIC_ISSUE_OWNERS: Readonly<Record<string, 13396 | 16546>> = {
  memory: 13396,
  agents: 16546,
  'extension-management': 16546,
  hooks: 16546,
  channels: 16546,
  'scheduled-tasks': 16546,
};

let root: Root;
let container: HTMLDivElement;
let portal: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  portal = document.createElement('div');
  document.body.append(container, portal);
  root = createRoot(container);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  portal.remove();
  vi.unstubAllGlobals();
});

async function render(language: 'en' | 'zh-CN' | 'zh-TW' | 'ru' = 'en') {
  await act(async () =>
    root.render(
      <I18nProvider language={language}>
        <WebShellPortalRootContext.Provider value={portal}>
          <ManagedSurfaceDecisionsDialog />
        </WebShellPortalRootContext.Provider>
      </I18nProvider>,
    ),
  );
}

async function click(button: Element) {
  await act(async () =>
    button.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
}

async function setFilterValue(search: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(search, value);
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function open(language: 'en' | 'zh-CN' | 'zh-TW' | 'ru' = 'en') {
  await render(language);
  const trigger = container.querySelector(
    '[data-managed-surface-decisions-trigger]',
  )!;
  await click(trigger);
  return trigger;
}

describe('ManagedSurfaceDecisionsDialog', () => {
  it('inventories all 35 unique groups in five categories with explicit owners', () => {
    expect(MANAGED_SURFACE_DECISIONS).toHaveLength(35);
    expect(
      new Set(MANAGED_SURFACE_DECISIONS.map((surface) => surface.id)),
    ).toEqual(new Set(EXPECTED_SURFACE_IDS));
    expect(MANAGED_SURFACE_DECISIONS.map((surface) => surface.id)).toEqual(
      EXPECTED_SURFACE_IDS,
    );
    expect(
      Object.fromEntries(
        Object.keys(MANAGED_SURFACE_CATEGORY_LABELS).map((category) => [
          category,
          MANAGED_SURFACE_DECISIONS.filter(
            (surface) => surface.category === category,
          ).length,
        ]),
      ),
    ).toEqual({
      configuration: 8,
      knowledge: 7,
      conversation: 5,
      files: 7,
      runtime: 8,
    });
    for (const surface of MANAGED_SURFACE_DECISIONS) {
      expect(surface.label[0].trim()).not.toBe('');
      expect(surface.label[1].trim()).not.toBe('');
      expect(surface.reason[0].trim()).not.toBe('');
      expect(surface.reason[1].trim()).not.toBe('');
      expect(surface.issue).toBe(SPECIFIC_ISSUE_OWNERS[surface.id] ?? 15084);
    }
  });

  it('keeps all 35 decision texts independently pinned', () => {
    expect(MANAGED_SURFACE_DECISIONS).toMatchSnapshot();
  });

  it('keeps reviewed surface explanations independently pinned', () => {
    const pinned = [
      {
        id: 'github',
        category: 'configuration',
        issue: 15084,
        label: ['GitHub setup and pull requests', 'GitHub 设置与 Pull Request'],
        reason: [
          'Managed has no GitHub setup, pull-request list or pull-request files surface.',
          'Managed 没有 GitHub 设置、Pull Request 列表或 Pull Request 文件界面。',
        ],
      },
      {
        id: 'voice',
        category: 'runtime',
        issue: 15084,
        label: ['Voice and transcription', '语音与转写'],
        reason: [
          'Managed has no voice, live-voice or transcription surface.',
          'Managed 没有语音、实时语音或转写界面。',
        ],
      },
      {
        id: 'message-deletion',
        category: 'conversation',
        issue: 15084,
        label: ['Message deletion', '消息删除'],
        reason: ['Managed cannot delete messages.', 'Managed 不能删除消息。'],
      },
      {
        id: 'file-mutations',
        category: 'files',
        issue: 15084,
        label: ['File and directory mutation', '文件与目录变更'],
        reason: [
          'Managed supports query, read and upload, but not file deletion, directory creation or directory deletion.',
          'Managed 支持查询、读取和上传，但不支持删除文件、创建目录或删除目录。',
        ],
      },
      {
        id: 'worktree-operations',
        category: 'conversation',
        issue: 15084,
        label: [
          'Worktree reset, branch and handoff',
          '工作树 reset、建分支与 handoff',
        ],
        reason: [
          'Managed creates and inspects Session-owned worktrees with an initial branch and supports cleanup. Ownership-transfer reset, post-create branch creation and work-carrying handoff are unavailable.',
          'Managed 可创建并检查带初始分支的会话工作树，也支持清理。所有权转移 reset、创建后建分支和携带工作的 handoff 不可用。',
        ],
      },
    ].sort((left, right) => left.id.localeCompare(right.id));
    expect(
      MANAGED_SURFACE_DECISIONS.filter((surface) =>
        [
          'github',
          'voice',
          'message-deletion',
          'file-mutations',
          'worktree-operations',
        ].includes(surface.id),
      ).sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(pinned);
  });

  it('renders every English reason and source issue without a backend request', async () => {
    await open();
    expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(35);
    for (const surface of MANAGED_SURFACE_DECISIONS) {
      const row = portal.querySelector(
        `[data-managed-surface="${surface.id}"]`,
      )!;
      expect(row.textContent).toContain(surface.label[0]);
      expect(row.textContent).toContain(surface.reason[0]);
      expect(row.querySelector('a')?.href).toBe(
        `https://github.com/QwenLM/qwen-code/issues/${surface.issue}`,
      );
      expect(row.querySelector('a')?.rel).toBe('noreferrer');
    }
    expect(
      portal.querySelector('[data-managed-surface="workspace-artifacts"]')
        ?.textContent,
    ).toContain('cross-session artifact library');
    expect(
      portal.querySelector('[data-managed-surface="attachments"]')?.textContent,
    ).toContain('inline text/images');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders every zh-CN label and reason with unchanged ownership', async () => {
    await open('zh-CN');
    for (const surface of MANAGED_SURFACE_DECISIONS) {
      const row = portal.querySelector(
        `[data-managed-surface="${surface.id}"]`,
      )!;
      expect(row.textContent).toContain(surface.label[1]);
      expect(row.textContent).toContain(surface.reason[1]);
      expect(row.querySelector('a')?.href).toBe(
        `https://github.com/QwenLM/qwen-code/issues/${surface.issue}`,
      );
    }
  });

  it.each([
    {
      language: 'en',
      title: 'Managed capabilities',
      search: 'Search surfaces',
      empty: 'No surfaces match this search.',
      trackedIn: 'Tracked in',
      category: 'Configuration and workspace identity',
      close: 'close',
    },
    {
      language: 'zh-CN',
      title: 'Managed 功能说明',
      search: '搜索界面',
      empty: '没有符合搜索条件的界面。',
      trackedIn: '跟踪于',
      category: '配置与工作区身份',
      close: '关闭',
    },
    {
      language: 'zh-TW',
      title: 'Managed 功能說明',
      search: '搜尋介面',
      empty: '沒有符合搜尋條件的介面。',
      trackedIn: '追蹤於',
      category: '組態與工作區身分識別',
      close: '關閉',
    },
    {
      language: 'ru',
      title: 'Возможности Managed',
      search: 'Поиск интерфейсов',
      empty: 'Интерфейсы по этому запросу не найдены.',
      trackedIn: 'Отслеживается в',
      category: 'Конфигурация и идентичность рабочей области',
      close: 'закрыть',
    },
  ] as const)('localizes the dialog chrome for $language', async (expected) => {
    const trigger = await open(expected.language);
    expect(trigger.textContent).toBe(expected.title);
    expect(
      portal.querySelector('[data-slot="dialog-title"]')?.textContent,
    ).toBe(expected.title);
    const search = portal.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    expect(search.placeholder).toBe(expected.search);
    expect(portal.querySelector('h3')?.textContent).toBe(expected.category);
    expect(portal.querySelector('li a')?.textContent).toBe(
      `${expected.trackedIn} #15084`,
    );
    expect(
      portal.querySelector('[data-slot="dialog-close"]')?.textContent,
    ).toBe(expected.close);
    await setFilterValue(search, 'no matching surface');
    expect(portal.querySelector('[role="status"]')?.textContent).toBe(
      expected.empty,
    );
  });

  it('searches visible owners, tracking chrome and category titles', async () => {
    await open();
    const search = portal.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    for (const [query, count, id] of [
      ['15084', 29, 'settings'],
      ['Tracked in', 35, 'settings'],
      ['#13396', 1, 'memory'],
      ['Configuration and workspace identity', 8, 'settings'],
    ] as const) {
      await setFilterValue(search, query);
      expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(
        count,
      );
      expect(
        portal.querySelector(`[data-managed-surface="${id}"]`),
      ).not.toBeNull();
    }
    expect(search.value).toBe('Configuration and workspace identity');
  });

  it('keeps committed results during IME composition and filters on commit', async () => {
    await open();
    const search = portal.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    await act(async () =>
      search.dispatchEvent(new Event('compositionstart', { bubbles: true })),
    );
    await setFilterValue(search, 'xiaoxishanchu');
    expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(35);
    expect(portal.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(search, '消息删除');
      search.dispatchEvent(new Event('compositionend', { bubbles: true }));
    });
    expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(1);
    expect(
      portal.querySelector('[data-managed-surface="message-deletion"]'),
    ).not.toBeNull();
    expect(search.value).toBe('消息删除');
  });

  it('filters locally, reports an empty result and resets on close', async () => {
    const trigger = await open();
    const search = portal.querySelector('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(search, 'Generated UI');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(1);
    expect(
      portal.querySelector('[data-managed-surface="generated-ui-state"]'),
    ).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(search, 'no matching surface');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(0);
    expect(portal.textContent).toContain('No surfaces match this search.');
    await click(portal.querySelector('[data-slot="dialog-close"]')!);
    expect(portal.querySelector('[role="dialog"]')).toBeNull();
    await click(trigger);
    expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(35);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
