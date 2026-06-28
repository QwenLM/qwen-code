/**
 * i18n seam. The panel renders translated strings but never owns a translation
 * table — the host injects a translator (web-shell's `useI18n().t`, etc.) and
 * keeps the catalogs. Carved components call this `useI18n()` instead of the
 * host's; the default is an identity translator so the package renders (keys as
 * text) even when mounted without a provider.
 */
import { createContext, useContext } from 'react';

export type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export interface ChatPanelI18n {
  /** BCP-47-ish tag the host is rendering in (e.g. 'en', 'zh-CN'). */
  language: string;
  t: Translate;
}

const IDENTITY: ChatPanelI18n = { language: 'en', t: (key) => key };

export const I18nContext = createContext<ChatPanelI18n>(IDENTITY);

export function useI18n(): ChatPanelI18n {
  return useContext(I18nContext);
}
