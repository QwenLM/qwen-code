/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ComponentType, MutableRefObject } from 'react';
import type {
  Config,
  SessionResumeData,
  StartupWarning,
} from '@qwen-code/core';
import type { WorktreeStartupRequest } from '../utils/worktreeStartupRequest.js';
import type { SessionBrowserOpenOptions } from './hooks/useSessionBrowser.js';
import type {
  ProjectResumeHandler,
  SessionResumeOptions,
} from './hooks/useSessionResume.js';
import type { SessionGate } from './sessionGate.js';
import type { SessionUiBinding } from './session/prepareSessionUi.js';

export interface AppContainerProps {
  config: Config;
  /** Product session gate mounted above every other control. */
  SessionGate?: SessionGate;
  startupWarnings?: StartupWarning[];
  version: string;
  themeError: string | null;
  resumedSessionData?: SessionResumeData;
  sessionUi?: SessionUiBinding;
  initialSessionTitle?: string;
  initialSessionBrowserOptions?: SessionBrowserOpenOptions;
  worktreeStartupRequest?: WorktreeStartupRequest;
  onProjectResume?: ProjectResumeHandler;
  initialResumeOptions?: SessionResumeOptions;
  onInitialResumeComplete?: (success: boolean) => void;
  initialPromptSubmittedRef?: MutableRefObject<boolean>;
}

export type AppContainerComponent = ComponentType<AppContainerProps>;
