// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { I18nProvider } from '../../i18n';
import { useManagedWorktreeText } from './managed-worktree-messages';

describe('managed worktree copy', () => {
  it('reads the zh-TW table rather than the Simplified or English one', () => {
    const { result } = renderHook(() => useManagedWorktreeText(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <I18nProvider language="zh-TW">{children}</I18nProvider>
      ),
    });
    const t = result.current;
    expect(t('mode')).toBe('會話檔案');
    expect(t('cleanup')).toBe('刪除 worktree 目錄');
    expect(t('unsupported')).toBe('當前部署或執行環境不支援會話 worktree。');
    expect(t('sessionActive')).toBe('請先關閉會話，再刪除它的 worktree。');
  });
  it('preserves the Arabic table after adding Traditional Chinese', () => {
    const { result } = renderHook(() => useManagedWorktreeText(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <I18nProvider language="ar">{children}</I18nProvider>
      ),
    });
    expect(result.current('mode')).toBe('ملفات الجلسة');
    expect(result.current('cleanup')).toBe('إزالة مجلد worktree');
  });
});
