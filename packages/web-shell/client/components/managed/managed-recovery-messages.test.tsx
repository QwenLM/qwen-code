// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { I18nProvider } from '../../i18n';
import {
  MANAGED_RECOVERY_MESSAGES_EN,
  useManagedRecoveryText,
} from './managed-recovery-messages';
import { SIMPLIFIED_ONLY_GLYPHS } from '../../test/zh-tw-glyphs';

describe('managed recovery copy', () => {
  it('reads the zh-TW table, and every entry in it is Traditional', () => {
    const { result } = renderHook(() => useManagedRecoveryText(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <I18nProvider language="zh-TW">{children}</I18nProvider>
      ),
    });
    const t = result.current;
    expect(t('managed.recovery.title')).toBe('會話恢復');
    expect(t('managed.recovery.handoff')).toBe('在新會話繼續');
    for (const key of Object.keys(MANAGED_RECOVERY_MESSAGES_EN) as Array<
      keyof typeof MANAGED_RECOVERY_MESSAGES_EN
    >) {
      expect(`${key}: ${t(key)}`).not.toMatch(SIMPLIFIED_ONLY_GLYPHS);
    }
  });
});
