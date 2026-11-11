/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionResumeData, StartupWarning } from '@qwen-code/core';
import type { SessionHandle } from '../../session/session.js';
import type { StartupCoordinator } from '../startupCoordinator.js';
import type { WorktreeStartupRequest } from '../../utils/worktreeStartupRequest.js';
import type { SessionBrowserOpenOptions } from '../../ui/hooks/useSessionBrowser.js';

import type { RebuildInteractiveProject } from '../../interactiveProjectRuntime.js';
import type { SessionUiBinding } from '../../ui/session/prepareSessionUi.js';

export interface RuntimeRouteRunnerOptions {
  startupCoordinator: StartupCoordinator;
  themeError: string | null;
  startupWarnings: StartupWarning[];
  resumedSessionData?: SessionResumeData;
  session?: SessionHandle;
  initialSessionBrowserOptions?: SessionBrowserOpenOptions;
  worktreeStartupRequest?: WorktreeStartupRequest;
  initialSessionTitle?: string;
  rebuildProject?: RebuildInteractiveProject;
  sessionUi?: SessionUiBinding;
}
