/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  useReportedArtifactRegistration,
  type RegistrationErrorTranslator,
} from '../hooks/useReportedArtifactRegistration';

/**
 * Registers the files slash commands reported writing with the session
 * artifact store. Rendered inside the shell's portal-root provider so the
 * failure toast is scoped to this shell: App calls useSessionArtifacts in
 * its own body, above the provider it returns, so the registration cannot
 * ride along inside that hook without reading an unpopulated context.
 *
 * Mounted once per session consumer: App for the main session, ChatPane for
 * split panes and side tasks, SubagentDetailContent for subagent sessions —
 * each of those runs under its own DaemonSessionProvider, so a single mount
 * in App would leave their reported artifacts unregistered.
 */
export function ReportedArtifactRegistration({
  registered,
  hydrated,
  refresh,
  translateError,
}: {
  registered: readonly DaemonSessionArtifact[];
  hydrated: boolean;
  refresh: () => Promise<void>;
  translateError?: RegistrationErrorTranslator;
}) {
  useReportedArtifactRegistration(
    registered,
    hydrated,
    refresh,
    translateError,
  );
  return null;
}
