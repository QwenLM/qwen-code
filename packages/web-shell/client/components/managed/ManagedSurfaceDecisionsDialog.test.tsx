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
        id: 'settings',
        category: 'configuration',
        issue: 15084,
        label: ['Settings panel', '设置面板'],
        reason: [
          'Managed has no daemon-style general Settings panel. Eligible Managed Sessions have their own model, approval, Plan and permission-rule controls.',
          'Managed 没有 daemon 风格的通用设置面板。支持相应能力的 Managed 会话分别提供模型、审批模式、Plan 模式和权限规则控件。',
        ],
      },
      {
        id: 'workspace-preflight',
        category: 'configuration',
        issue: 15084,
        label: [
          'Workspace env, preflight and init',
          '工作区 env、preflight 与 init',
        ],
        reason: [
          'SSH registration can check directory and runtime prerequisites. The daemon workspace environment editing and initialization surfaces have no Managed equivalents.',
          'SSH 注册支持目录和运行时前置检查。daemon 工作区环境编辑和初始化界面没有 Managed 对应功能。',
        ],
      },
      {
        id: 'workspace-identity',
        category: 'configuration',
        issue: 15084,
        label: [
          'Workspace directories, clone source and identity',
          '工作区目录、克隆来源与身份',
        ],
        reason: [
          'Managed creates named empty Workspaces and can bind an existing authorized directory with a display name used in navigation. Each Workspace exposes one registered root. Extra-directory lists, Git clone sources and custom ordering are unavailable.',
          'Managed 可创建命名的空 Workspace，也可选择授权 root 下的已有目录，并提供用于导航的显示名。每个 Workspace 暴露一个注册 root。额外目录列表、Git clone 来源和自定义排序不可用。',
        ],
      },
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
        id: 'skill-management',
        category: 'knowledge',
        issue: 15084,
        label: ['Skill settings and installation', 'Skill 设置与安装'],
        reason: [
          'Managed provides read-only Session Skills, reviewed archive installation through v1 preparation, runtime import and default Workspace pins at creation. Per-Skill enable/disable, batch toggles and daemon-style activation management are unavailable.',
          'Managed 提供只读会话 Skills、经 v1 preparation 流程审查并安装归档、运行时导入和创建时的默认工作区固定。逐 Skill 启停、批量开关和 daemon 风格的激活管理不可用。',
        ],
      },
      {
        id: 'live-state',
        category: 'runtime',
        issue: 15084,
        label: [
          'Live state and background-work indicator',
          '实时状态与后台工作指示',
        ],
        reason: [
          'Managed polls unselected running Sessions and shows running indicators in the sidebar. Daemon aggregate live-state snapshots and its particular background-task indicator are unavailable.',
          'Managed 会轮询未选中的运行中会话，并在侧栏显示运行中指示。daemon 的聚合实时状态快照及其特定后台任务指示不可用。',
        ],
      },
      {
        id: 'session-probes',
        category: 'runtime',
        issue: 15084,
        label: [
          'Session refresh, status, commands and context',
          '会话刷新、状态、命令与上下文',
        ],
        reason: [
          'Managed reads Sessions and Turns through list/get and supports context-usage queries and idle-only context compression. Daemon refresh, status probes, supported-commands and the daemon session-context route are unavailable.',
          'Managed 通过 list/get 读取会话和轮次，并支持上下文用量查询和仅供空闲 Session 的上下文压缩。daemon 的会话刷新、状态探针、支持命令列表和 session-context 路由不可用。',
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
        reason: [
          'Managed cannot delete committed transcript messages. Queued and recovery-blocked user inputs can be withdrawn, and queued inputs can also be edited.',
          'Managed 不能删除已提交的对话历史消息。排队和 recovery_blocked 用户输入可以撤回，排队输入还可以编辑。',
        ],
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
        id: 'session-organization',
        category: 'conversation',
        issue: 15084,
        label: ['Session organization and metadata', '会话组织与元数据'],
        reason: [
          'Managed supports renaming and, where capability permits, archiving/unarchiving with an archived-list view. It has no general metadata bag or daemon-style Session organization.',
          'Managed 支持重命名，并在能力允许时归档/取消归档及查看归档列表。没有通用元数据袋或 daemon 风格的会话组织功能。',
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
          'workspace-preflight',
          'workspace-identity',
          'session-organization',
          'settings',
          'skill-management',
          'live-state',
          'session-probes',
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
      description:
        'Daemon surfaces that differ in Managed, with their current owner. Tracked makes a gap visible; it does not mean permanent exclusion.',
      search: 'Search surfaces',
      empty: 'No surfaces match this search.',
      tracked: 'Tracked',
      trackedIn: 'Tracked in',
      categories: [
        'Configuration and workspace identity',
        'Knowledge, Skills and extensions',
        'Conversation editing',
        'Files, artifacts and sources',
        'Runtime and tooling',
      ],
      close: 'close',
    },
    {
      language: 'zh-CN',
      title: 'Managed 功能说明',
      description:
        '此处列出 Managed 与 daemon 的界面差异及当前归属。「已跟踪」表示缺口可见，不表示永久排除。',
      search: '搜索界面',
      empty: '没有符合搜索条件的界面。',
      tracked: '已跟踪',
      trackedIn: '跟踪于',
      categories: [
        '配置与工作区身份',
        '知识、Skills 与扩展',
        '会话编辑',
        '文件、产物与来源',
        '运行时与工具',
      ],
      close: '关闭',
    },
    {
      language: 'zh-TW',
      title: 'Managed 功能說明',
      description:
        '此處列出 Managed 與 daemon 的介面差異及目前歸屬。「已追蹤」表示缺口可見，不表示永久排除。',
      search: '搜尋介面',
      empty: '沒有符合搜尋條件的介面。',
      tracked: '已追蹤',
      trackedIn: '追蹤於',
      categories: [
        '設定與工作區身份',
        '知識、Skills 與擴充',
        '對話編輯',
        '檔案、產物與來源',
        '執行環境與工具',
      ],
      close: '關閉',
    },
    {
      language: 'ru',
      title: 'Возможности Managed',
      description:
        'Различия интерфейсов daemon и Managed с текущим владельцем. «Отслеживается» показывает пробел, а не окончательное исключение.',
      search: 'Поиск интерфейсов',
      empty: 'Интерфейсы по этому запросу не найдены.',
      tracked: 'Отслеживается',
      trackedIn: 'Отслеживается в',
      categories: [
        'Конфигурация и идентичность рабочей области',
        'Знания, Skills и расширения',
        'Редактирование диалога',
        'Файлы, артефакты и источники',
        'Среда выполнения и инструменты',
      ],
      close: 'закрыть',
    },
  ] as const)('localizes the dialog chrome for $language', async (expected) => {
    const trigger = await open(expected.language);
    expect(trigger.textContent).toBe(expected.title);
    expect(
      portal.querySelector('[data-slot="dialog-title"]')?.textContent,
    ).toBe(expected.title);
    expect(
      portal.querySelector('[data-slot="dialog-description"]')?.textContent,
    ).toBe(expected.description);
    const search = portal.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    expect(search.placeholder).toBe(expected.search);
    expect(
      [...portal.querySelectorAll('h3')].map((heading) => heading.textContent),
    ).toEqual(expected.categories);
    const firstRow = portal.querySelector('[data-managed-surface="settings"]')!;
    expect(firstRow.querySelector('h4')?.textContent).toBe(
      expected.language === 'zh-CN' ? '设置面板' : 'Settings panel',
    );
    expect(firstRow.querySelector('h4 + span')?.textContent).toBe(
      expected.tracked,
    );
    expect(firstRow.querySelector('p')?.textContent).toBe(
      expected.language === 'zh-CN'
        ? 'Managed 没有 daemon 风格的通用设置面板。支持相应能力的 Managed 会话分别提供模型、审批模式、Plan 模式和权限规则控件。'
        : 'Managed has no daemon-style general Settings panel. Eligible Managed Sessions have their own model, approval, Plan and permission-rule controls.',
    );
    expect(firstRow.querySelector('a')?.textContent).toBe(
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

  it('uses the desktop opener for issue links without changing browser behavior', async () => {
    await open();
    const link = portal.querySelector<HTMLAnchorElement>(
      '[data-managed-surface="workspace-identity"] a',
    )!;
    const browserClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      link.dispatchEvent(browserClick);
    });
    expect(browserClick.defaultPrevented).toBe(false);

    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('__TAURI__', { core: { invoke } });
    const desktopClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      link.dispatchEvent(desktopClick);
    });
    expect(desktopClick.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://github.com/QwenLM/qwen-code/issues/15084',
    });
  });

  it('uses locale-independent casing for inventory search', async () => {
    const localeLower = String.prototype.toLocaleLowerCase;
    const spy = vi
      .spyOn(String.prototype, 'toLocaleLowerCase')
      .mockImplementation(function (this: string) {
        return localeLower.call(this, 'tr-TR');
      });
    try {
      await open();
      spy.mockClear();
      const search = portal.querySelector<HTMLInputElement>(
        'input[type="search"]',
      )!;
      await setFilterValue(search, 'generated ui');
      expect(
        portal.querySelector('[data-managed-surface="generated-ui-state"]'),
      ).not.toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(localeLower.call('Generated UI view state', 'tr-TR')).toBe(
        'generated uı view state',
      );
    } finally {
      spy.mockRestore();
    }
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
      ['cross-session artifact library', 1, 'workspace-artifacts'],
    ] as const) {
      await setFilterValue(search, query);
      expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(
        count,
      );
      expect(
        portal.querySelector(`[data-managed-surface="${id}"]`),
      ).not.toBeNull();
    }
    expect(search.value).toBe('cross-session artifact library');
  });

  it('keeps committed results during IME composition and filters on commit', async () => {
    await open();
    const search = portal.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    await setFilterValue(search, 'voice');
    expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(1);
    await act(async () =>
      search.dispatchEvent(new Event('compositionstart', { bubbles: true })),
    );
    await setFilterValue(search, 'xiaoxishanchu');
    expect(search.value).toBe('xiaoxishanchu');
    expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(1);
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

  it('preserves both composition Escape variants but closes on a plain Escape', async () => {
    await open();
    const search = portal.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    await setFilterValue(search, 'voice');
    for (const event of [
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        keyCode: 229,
      }),
    ]) {
      await act(async () => {
        search.dispatchEvent(new Event('compositionstart', { bubbles: true }));
        search.dispatchEvent(event);
      });
      expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
      expect(event.defaultPrevented).toBe(false);
      expect(event.key).toBe('Escape');
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(search, 'voice');
        search.dispatchEvent(new Event('compositionend', { bubbles: true }));
      });
      expect(search.value).toBe('voice');
      expect(portal.querySelectorAll('[data-managed-surface]')).toHaveLength(1);
    }
    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(portal.querySelector('[role="dialog"]')).toBeNull();
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
    expect(
      [...portal.querySelectorAll('h3')].map((heading) => heading.textContent),
    ).toEqual(['Files, artifacts and sources']);
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
