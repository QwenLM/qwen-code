// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { parseTitle, ToolApproval } from './ToolApproval';
import type { PermissionRequest } from '../../adapters/types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('parseTitle', () => {
  it('splits short CLI-style tool prefixes', () => {
    expect(parseTitle('Bash: npm test')).toEqual({
      toolName: 'Bash',
      description: 'npm test',
    });
  });

  it('does not split descriptive titles that contain prose colons', () => {
    const title =
      'Fetching content from https://www.aliyun.com/activity (format: auto) and processing with prompt: "请列出阿里云官网当前正在进行的所有活动，包括活动名称、主要内容、优惠信息和链接"';

    expect(parseTitle(title)).toEqual({
      toolName: title,
      description: '',
    });
  });
});

describe('ToolApproval', () => {
  it('localizes the tool name in Chinese', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const request: PermissionRequest = {
      id: 'approval-1',
      toolName: 'Bash',
      title: 'Bash: npm test',
      content: [],
      options: [{ id: 'reject', label: 'Reject', kind: 'reject_once' }],
      rawInput: { command: 'npm test' },
      kind: 'bash',
    };

    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'zh-CN' },
          createElement(ToolApproval, {
            request,
            onConfirm: () => undefined,
          }),
        ),
      );
    });

    expect(container.textContent).toContain('运行命令');
    expect(container.textContent).not.toContain('?Bash');

    act(() => root.unmount());
  });

  it('prefers raw input description over the tool title', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const request: PermissionRequest = {
      id: 'approval-2',
      toolName: 'run_shell_command',
      title: 'rmdir /tmp/test (/tmp/test description)',
      content: [],
      options: [{ id: 'reject', label: 'Reject', kind: 'reject_once' }],
      rawInput: {
        command: 'rmdir /tmp/test',
        description: '删除空目录',
      },
      kind: 'execute',
    };

    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'zh-CN' },
          createElement(ToolApproval, {
            request,
            onConfirm: () => undefined,
          }),
        ),
      );
    });

    expect(container.textContent).toContain('删除空目录');
    expect(container.textContent).not.toContain('/tmp/test description');

    act(() => root.unmount());
  });

  it('treats execute shell permissions as command execution', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const request: PermissionRequest = {
      id: 'approval-3',
      toolName: 'run_shell_command',
      title: 'rmdir /tmp/test',
      content: [],
      options: [{ id: 'reject', label: 'Reject', kind: 'reject_once' }],
      rawInput: {
        command: 'rmdir /tmp/test',
        description: '删除空目录',
      },
      kind: 'execute',
    };

    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'zh-CN' },
          createElement(ToolApproval, {
            request,
            onConfirm: () => undefined,
          }),
        ),
      );
    });

    expect(container.textContent).toContain('允许执行');
    expect(container.textContent).not.toContain('是否继续');

    act(() => root.unmount());
  });

  it('orders permission options according to the product hierarchy', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const request: PermissionRequest = {
      id: 'approval-4',
      toolName: 'run_shell_command',
      title: 'Bash: npm test',
      content: [],
      options: [
        { id: 'proceed_once', label: 'Allow', kind: 'allow_once' },
        {
          id: 'proceed_always_project',
          label: 'Always Allow in project',
          kind: 'allow_always',
        },
        {
          id: 'proceed_always_server',
          label: 'Always Allow for server',
          kind: 'allow_always',
        },
        {
          id: 'proceed_always_user',
          label: 'Always Allow for user',
          kind: 'allow_always',
        },
        {
          id: 'proceed_always_tool',
          label: 'Always Allow for tool',
          kind: 'allow_always',
        },
        { id: 'cancel', label: 'Reject', kind: 'reject_once' },
      ],
      rawInput: { command: 'npm test' },
      kind: 'bash',
    };

    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'en' },
          createElement(ToolApproval, {
            request,
            onConfirm: () => undefined,
          }),
        ),
      );
    });

    const ids = Array.from(container.querySelectorAll('[data-option-id]')).map(
      (el) => el.getAttribute('data-option-id'),
    );
    expect(ids).toEqual([
      'cancel',
      'proceed_always_user',
      'proceed_always_project',
      'proceed_always_server',
      'proceed_always_tool',
      'proceed_once',
    ]);

    // The fixture's server labels deliberately differ from the i18n strings
    // (e.g. 'Always Allow in project' vs 'Always allow in this project'), so
    // asserting the rendered text proves localization overrides server labels.
    const labels = Array.from(
      container.querySelectorAll('[data-web-shell-option-label]'),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      'Reject',
      'Always allow for this user',
      'Always allow in this project',
      'Always allow for this server',
      'Always allow for this tool',
      'Yes, allow once',
    ]);

    act(() => root.unmount());
  });
});
