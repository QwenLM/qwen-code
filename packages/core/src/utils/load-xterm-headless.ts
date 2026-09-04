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

function isXtermHeadlessModule(
  candidate: Partial<XtermHeadlessModule> | undefined,
): candidate is XtermHeadlessModule {
  return (
    candidate !== undefined &&
    'Terminal' in candidate &&
    typeof candidate.Terminal === 'function'
  );
}

export function loadXtermHeadless(): Promise<XtermHeadlessModule> {
  xtermHeadlessModulePromise ??= import('@xterm/headless').then((module) => {
    const imported = module as unknown as Partial<XtermHeadlessModule> & {
      default?: XtermHeadlessModule;
    };
    const candidate = isXtermHeadlessModule(imported)
      ? imported
      : 'default' in imported
        ? imported.default
        : undefined;
    if (!isXtermHeadlessModule(candidate)) {
      throw new Error('@xterm/headless module does not match the expected API');
    }
    return candidate;
  });
  return xtermHeadlessModulePromise;
}
