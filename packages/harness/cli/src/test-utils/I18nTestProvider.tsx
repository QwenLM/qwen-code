/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo } from 'react';
import {
  DefaultI18nService,
  type I18nService,
  type UiLocale,
} from '@qwen-code/core';
import { useSettings } from '../ui/contexts/SettingsContext.js';
import { registerCliUiMessages } from '../ui/i18n/register.js';
import { bindI18nSettings } from '../ui/i18n/bindI18nSettings.js';
import { I18nServiceProvider } from '../ui/i18n/I18nServiceContext.js';

/** Test-only ownership; production instances always come from the Framework. */
export function I18nTestProvider({
  children,
  service,
  forcedLocale,
  systemLocale,
  dynamicContentEnabled = true,
}: {
  children: React.ReactNode;
  service?: I18nService;
  forcedLocale?: UiLocale;
  systemLocale?: string;
  dynamicContentEnabled?: boolean;
}) {
  const settings = useSettings();
  const binding = useMemo(() => {
    const instance = service ?? new DefaultI18nService();
    if (!service) registerCliUiMessages(instance);
    const stop = bindI18nSettings(instance, settings, {
      forcedLocale,
      systemLocale,
      dynamicContentEnabled,
    });
    return { instance, stop };
  }, [service, settings, forcedLocale, systemLocale, dynamicContentEnabled]);
  useEffect(() => binding.stop, [binding]);
  return (
    <I18nServiceProvider service={binding.instance}>
      {children}
    </I18nServiceProvider>
  );
}
