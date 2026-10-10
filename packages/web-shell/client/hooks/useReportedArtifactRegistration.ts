import { useEffect, useRef } from 'react';
import {
  useActions,
  useConnection,
  useDaemonSessionOwnerGuard,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonSessionArtifactInput,
  DaemonSessionArtifact,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';

import { requestToast } from '../components/ToastHost';
import { readReportedArtifacts } from '../adapters/reported-artifacts';
import { useI18n } from '../i18n';
import { extractErrorDetail } from '../utils/errorDetail';
import { useAnimationFrameTranscriptSnapshot } from './useAnimationFrameTranscriptBlocks';

const SESSION_ARTIFACTS_FEATURE = 'session_artifacts';

export type RegistrationErrorTranslator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * Files that slash commands reported writing, read back off the transcript.
 *
 * They ride the assistant block's raw ACP metadata, which is the only place
 * arbitrary `_meta` survives on its way to a rendered message.
 */
export function collectReportedArtifacts(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonSessionArtifactInput[] {
  const artifacts: DaemonSessionArtifactInput[] = [];
  for (const block of blocks) {
    if (block.kind !== 'assistant') continue;
    artifacts.push(...readReportedArtifacts(block.meta));
  }
  return artifacts;
}

/**
 * Registers the files slash commands reported writing with the session
 * artifact store, so they show up in the artifact panel next to the files the
 * agent produced. Wait for the catalog before registering to avoid claiming
 * an existing artifact from another browser client.
 *
 * `translateError`: App's own hook body runs above the `<I18nProvider>` it
 * renders, where the i18n context is the key-passthrough default; App passes
 * its own translator so the failure toast is localized on the main view too.
 */
export function useReportedArtifactRegistration(
  registered: readonly DaemonSessionArtifact[],
  hydrated: boolean,
  refresh: () => Promise<void>,
  translateError?: RegistrationErrorTranslator,
): void {
  const { t: contextTranslate } = useI18n();
  const t = translateError ?? contextTranslate;
  const actions = useActions();
  const connection = useConnection();
  const guard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(guard.capture());
  if (!ownerRef.current.isCurrent()) ownerRef.current = guard.capture();
  const owner = ownerRef.current;
  const { blocks } = useAnimationFrameTranscriptSnapshot();
  const sessionId = connection.sessionId;
  const attemptedRef = useRef({
    owner,
    sessionId,
    status: connection.status,
    paths: new Set<string>(),
  });
  if (
    attemptedRef.current.owner !== owner ||
    attemptedRef.current.sessionId !== sessionId ||
    attemptedRef.current.status !== connection.status
  ) {
    attemptedRef.current = {
      owner,
      sessionId,
      status: connection.status,
      paths: new Set(),
    };
  }
  const supportsArtifacts =
    connection.capabilities?.features?.includes(SESSION_ARTIFACTS_FEATURE) ??
    false;
  const ready =
    hydrated &&
    supportsArtifacts &&
    connection.status === 'connected' &&
    !connection.catchingUp &&
    Boolean(sessionId);

  useEffect(() => {
    if (!ready || !sessionId || !owner.isCurrent()) return;
    for (const artifact of collectReportedArtifacts(blocks)) {
      if (
        registered.some(
          (entry) => entry.workspacePath === artifact.workspacePath,
        )
      )
        continue;
      const key = artifact.workspacePath;
      if (!key || attemptedRef.current.paths.has(key)) continue;
      attemptedRef.current.paths.add(key);
      void actions.addArtifact(artifact).catch(async (error: unknown) => {
        if (!owner.isCurrent()) return;
        if (
          error instanceof DaemonHttpError &&
          error.status === 403 &&
          error.body &&
          typeof error.body === 'object' &&
          'code' in error.body &&
          error.body.code === 'session_artifact_forbidden'
        ) {
          // The daemon raises the cross-client 403 only after resolving an
          // existing artifact for this path, so the export IS registered.
          // Resync this client's catalog rather than reporting a failure.
          await refresh();
          return;
        }
        requestToast(
          'error',
          t('artifact.registrationFailed', {
            message: extractErrorDetail(error),
          }),
        );
      });
    }
  }, [actions, blocks, owner, ready, refresh, registered, sessionId, t]);
}
