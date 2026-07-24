/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Terminal } from '@xterm/headless';

export type XtermHeadlessModule = {
  Terminal: typeof Terminal;
};

let xtermHeadlessModulePromise: Promise<XtermHeadlessModule> | undefined;

export function loadXtermHeadless(): Promise<XtermHeadlessModule> {
  xtermHeadlessModulePromise ??= import('@xterm/headless').then((module) => {
    const candidate =
      'Terminal' in module
        ? module
        : (module as unknown as { default: XtermHeadlessModule }).default;
    return candidate as XtermHeadlessModule;
  });
  return xtermHeadlessModulePromise;
}
