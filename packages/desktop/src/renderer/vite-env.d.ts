/// <reference types="vite/client" />

import type { QwenDesktopApi } from '../shared/desktopApi';

declare global {
  interface Window {
    qwenDesktop: QwenDesktopApi;
  }
}

export {};
