/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { LocationsList } from './LayoutComponents.js';

/**
 * LocationsList displays a list of file locations with clickable links.
 */
const meta: Meta<typeof LocationsList> = {
  title: 'ToolCalls/Shared/LocationsList',
  component: LocationsList,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleFile: Story = {
  args: {
    locations: [{ path: 'src/App.tsx', line: 10 }],
  },
};

export const MultipleFiles: Story = {
  args: {
    locations: [
      { path: 'src/App.tsx', line: 10 },
      { path: 'src/components/Header.tsx', line: 25 },
      { path: 'src/utils/helpers.ts', line: 42 },
    ],
  },
};

export const WithoutLineNumbers: Story = {
  args: {
    locations: [{ path: 'package.json' }, { path: 'tsconfig.json' }],
  },
};
