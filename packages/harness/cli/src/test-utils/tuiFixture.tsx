/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { CliApplicationContext } from '../ui/contexts/CliApplicationContext.js';
import { renderWithProviders } from './render.js';
import { createAppPluginFixture } from './appPluginFixture.js';
import { CLI_DISPLAY_NAME } from '../brand.js';

/** 展示测试显式注入本测试的应用视图，不登记任何全局 UI 状态。 */
export function createTuiFixture() {
  let cliDisplayName = CLI_DISPLAY_NAME;
  const plugins = createAppPluginFixture();
  const application = {
    getCliDisplayName: () => cliDisplayName,
    getAppPlugins: plugins.getAppPluginRegistry,
  };
  return {
    setCliDisplayName(value: string) {
      cliDisplayName = value;
    },
    renderWithProviders: async (
      ...[element, options]: Parameters<typeof renderWithProviders>
    ): ReturnType<typeof renderWithProviders> => {
      const wrap = (tree: typeof element) => (
        <CliApplicationContext.Provider value={application}>
          {tree}
        </CliApplicationContext.Provider>
      );
      const rendered = await renderWithProviders(wrap(element), options);
      return {
        ...rendered,
        rerender: (tree: typeof element) => rendered.rerender(wrap(tree)),
      };
    },
  };
}
