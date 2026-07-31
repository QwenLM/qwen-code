/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Preview } from '@storybook/react-vite';
import React from 'react';
import './preview.css';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#1e1e1e' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    layout: 'fullscreen',
    options: {
      // Set ChatViewer Playground as the default story
      storySort: {
        order: ['Chat', ['ChatViewer', ['Playground', '*']], '*'],
      },
    },
  },
  decorators: [
    (Story, context) => {
      // For ChatViewer stories, use full height container with internal scroll
      const isFullHeight =
        context.title?.includes('ChatViewer') ||
        context.parameters?.fullHeight === true;

      return React.createElement(
        'div',
        {
          className: isFullHeight
            ? 'storybook-container storybook-fullheight'
            : 'storybook-container',
          style: {
            backgroundColor: 'var(--app-background)',
            color: 'var(--app-primary-foreground)',
            height: isFullHeight ? '100vh' : 'auto',
            minHeight: isFullHeight ? '100vh' : '100px',
            padding: isFullHeight ? '0' : '16px',
            display: isFullHeight ? 'flex' : 'block',
            flexDirection: 'column',
          },
        },
        React.createElement(Story),
      );
    },
  ],
  // Set initial path to ChatViewer Playground
  initialGlobals: {
    backgrounds: { value: 'dark' },
  },
};

export default preview;
