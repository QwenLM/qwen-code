// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '../i18n';
import { GitBranchIndicator } from './GitBranchIndicator';

describe('GitBranchIndicator', () => {
  it('renders a read-only branch indicator with the complete name', () => {
    const branch = 'feature/a-very-long-web-shell-branch-name';
    const ariaLabel = `Current Git branch: ${branch}`;
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(<GitBranchIndicator branch={branch} ariaLabel={ariaLabel} />);
    });

    const indicator = container.querySelector(`[aria-label="${ariaLabel}"]`);
    if (!indicator) throw new Error('branch indicator was not rendered');
    expect(indicator.tagName).toBe('OUTPUT');
    expect(indicator.getAttribute('title')).toBe(branch);
    expect(indicator.textContent).toContain(branch);
    expect(container.querySelector('button')).toBeNull();

    act(() => root.unmount());
  });

  it('localizes the accessible branch label', () => {
    expect(getTranslator('en')('git.currentBranch', { branch: 'main' })).toBe(
      'Current Git branch: main',
    );
    expect(
      getTranslator('zh-CN')('git.currentBranch', { branch: 'main' }),
    ).toBe('当前 Git 分支：main');
  });
});
