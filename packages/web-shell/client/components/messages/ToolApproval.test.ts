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
});
