/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StorybookConfig } from '@storybook/react-vite';

import { dirname } from 'path';

import { fileURLToPath } from 'url';

/**
 * This function is used to resolve the absolute path of a package.
 * It is needed in projects that use Yarn PnP or are set up within a monorepo.
 */
function getAbsolutePath(value: string): string {
  return dirname(fileURLToPath(import.meta.resolve(`${value}/package.json`)));
}
const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    getAbsolutePath('@chromatic-com/storybook'),
    getAbsolutePath('@storybook/addon-vitest'),
    getAbsolutePath('@storybook/addon-a11y'),
    getAbsolutePath('@storybook/addon-docs'),
    getAbsolutePath('@storybook/addon-onboarding'),
  ],
  framework: getAbsolutePath('@storybook/react-vite'),
  // Set ChatViewer Playground as default story when Storybook opens
  managerHead: (head) => `
    ${head}
    <script>
      // Redirect to ChatViewer Playground if on root path
      if (window.location.pathname === '/' || window.location.pathname === '/iframe.html') {
        const targetPath = '/?path=/story/chat-chatviewer--playground';
        if (!window.location.search.includes('path=')) {
          window.history.replaceState(null, '', targetPath);
        }
      }
    </script>
  `,
};
export default config;
