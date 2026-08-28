/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import process from 'node:process';
import {
  AuthType,
  probeImageSupport,
  readProbeResult,
  withProbeResult,
  type AvailableModel as CoreAvailableModel,
  type InputModalities,
  type ModalityProbeVerdict,
  type ModalitySource,
} from '@qwen-code/qwen-code-core';
import {
  type LoadedSettings,
  type SettingScope,
} from '../../config/settings.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

/** A /model dialog entry the probe operates on — the subset of the dialog's
 * entry shape the hook reads (dialog entries satisfy it structurally). */
export interface ProbeTargetEntry {
  readonly authType: AuthType;
  readonly model: CoreAvailableModel;
  readonly isRuntime?: boolean;
}

export interface UseImageSupportProbeParams {
  /** The currently highlighted dialog entry, if any. */
  readonly highlightedEntry: ProbeTargetEntry | undefined;
  /** Selection key of `highlightedEntry`, owned by the dialog (it keys the
   * option list, highlight, and selection handling); reused as the probe's
   * displacement-guard key. */
  readonly highlightedEntryKey: string | null;
  readonly settings: LoadedSettings;
  /** Pre-resolved scope the probe write persists under. */
  readonly scope: SettingScope;
  /** The dialog's error channel: cleared when a probe starts, fed when a
   * verdict write fails. */
  readonly setErrorMessage: (message: string | null) => void;
}

export interface UseImageSupportProbeResult {
  /** Whether the `t` action may trigger a probe for the highlighted entry. */
  readonly canTestImageSupport: boolean;
  /** Fire-and-forget probe handler; own guard clauses make it a no-op when
   * `canTestImageSupport` is false. */
  readonly handleTestImageSupport: () => Promise<void>;
  /** Modality value + provenance to render in the details panel. */
  readonly displayedModalities: InputModalities | undefined;
  readonly displayedModalitiesSource: ModalitySource | undefined;
  /** Feedback row for the highlighted entry's probe, if one is on screen. */
  readonly probeFeedback:
    | { readonly text: string; readonly color: string }
    | undefined;
}

/** Settings-backed keys are not in process.env until hydrated, so mid-session
 * settings.env keys work without a restart. The API key is read from the
 * environment at action time only — never displayed, never logged, never
 * persisted. */
export function hydrateApiKeyEnvFromSettings(
  settings: LoadedSettings,
  envKey: string | undefined,
): void {
  if (!envKey || process.env[envKey]) {
    return;
  }
  const settingsEnvValue = (
    settings?.merged?.env as Record<string, unknown> | undefined
  )?.[envKey];
  if (
    typeof settingsEnvValue === 'string' &&
    settingsEnvValue.trim().length > 0
  ) {
    process.env[envKey] = settingsEnvValue;
  }
}

/** One-shot image modality probe (issue #10309, phase 1) for the /model
 * dialog: owns the probe state machine, the live verdict read, the t-action
 * gating, and the derived badge/modality/feedback presentation. The dialog
 * keeps only rendering and key binding. */
export function useImageSupportProbe({
  highlightedEntry,
  highlightedEntryKey,
  settings,
  scope,
  setErrorMessage,
}: UseImageSupportProbeParams): UseImageSupportProbeResult {
  // `probeTargetKey` remembers WHICH entry a pending/finished verdict belongs
  // to, so moving the highlight mid-probe never shows another entry's result.
  const [probeState, setProbeState] = useState<
    'idle' | 'probing' | ModalityProbeVerdict
  >('idle');
  const [probeTargetKey, setProbeTargetKey] = useState<string | null>(null);

  const activeProbeState =
    probeTargetKey !== null && probeTargetKey === highlightedEntryKey
      ? probeState
      : 'idle';

  // Live probe-verdict source: the registry caches modalitiesSource at
  // registration/reload time (a plain settings.setValue does NOT refresh
  // already-registered entries), so a verdict concluded earlier in this
  // session — or written by an earlier dialog session — is visible here only
  // through the settings store itself. Keyed the same way the write path
  // keys it (declared/resolved entry baseUrl). Read-side hardening mirrors
  // the registry: only verdicts exactly 'image'/'text_only' are honored;
  // hand-edited garbage abstains to the entry's own source.
  //
  // The live read only applies to STILL-PATTERN-CACHED entries. An
  // 'explicit'-stamped entry got there because the user hand-wrote
  // modelProviders modalities — the phase-1 remediation exit for a wrong
  // verdict — and a stale probe record must not shadow it in the UI. A
  // 'probe'-stamped entry loses nothing either: phase 1 has no re-probe
  // path, so the live store can never hold a newer conclusion than the
  // registration-time stamp.
  const liveRawVerdict =
    highlightedEntry &&
    !highlightedEntry.isRuntime &&
    highlightedEntry.model.modalitiesSource === 'pattern'
      ? readProbeResult(
          settings.merged?.probeResults,
          highlightedEntry.authType,
          highlightedEntry.model.id,
          highlightedEntry.model.baseUrl,
        )?.verdict
      : undefined;
  const liveProbeVerdict: 'image' | 'text_only' | undefined =
    liveRawVerdict === 'image' || liveRawVerdict === 'text_only'
      ? liveRawVerdict
      : undefined;

  // The `t` action only applies to regex-guessed (pattern-source)
  // modalities: explicit declarations need no probe, and entries carrying a
  // conclusion — registry-stamped 'probe' source OR a live settings hit for
  // a still-pattern-cached entry — need none; QWEN_OAUTH's two probe-key
  // spellings diverge in phase 1 (see probe-store.ts), so it is excluded.
  // Runtime models have no modalitiesSource and are excluded by the same
  // check. A probe in flight disables re-trigger globally so two concurrent
  // probes can never race the whole-map read-modify-write, and a CONCLUDED
  // local verdict hides the action too ('unknown' keeps it — retry is the
  // only recourse for an inconclusive probe in phase 1).
  const canTestImageSupport =
    !!highlightedEntry &&
    !highlightedEntry.isRuntime &&
    highlightedEntry.authType !== AuthType.QWEN_OAUTH &&
    (liveProbeVerdict === undefined
      ? highlightedEntry.model.modalitiesSource
      : 'probe') === 'pattern' &&
    probeState !== 'probing' &&
    activeProbeState !== 'image' &&
    activeProbeState !== 'text_only';

  const handleTestImageSupport = useCallback(async () => {
    if (!highlightedEntry || probeState === 'probing') return;
    const { model } = highlightedEntry;
    setErrorMessage(null);
    setProbeState('probing');
    setProbeTargetKey(highlightedEntryKey);
    hydrateApiKeyEnvFromSettings(settings, model.envKey);
    const apiKey = model.envKey ? process.env[model.envKey] : undefined;
    if (!apiKey || !model.baseUrl) {
      setProbeState('unknown');
      return;
    }
    const result = await probeImageSupport({
      model: model.id,
      baseUrl: model.baseUrl,
      apiKey,
    });
    if (result.verdict !== 'unknown') {
      // Read the TARGET scope's own map (not the merged view) so records
      // from other scopes never bleed into this write, and always write the
      // WHOLE map under the single 'probeResults' key — composite probe
      // keys embed dots and '|' that settings' dotted-path addressing would
      // mis-nest.
      try {
        settings.setValue(
          scope,
          'probeResults',
          withProbeResult(
            settings.forScope(scope).settings.probeResults,
            highlightedEntry.authType,
            model.id,
            model.baseUrl,
            { verdict: result.verdict, probedAt: new Date().toISOString() },
          ),
        );
      } catch (e) {
        // setValue can throw (saveSettings re-throws fs errors) and this
        // handler runs fire-and-forget, so an uncaught throw would be an
        // unhandled rejection while the UI shows success. Surface the
        // failure through the dialog's error channel (the same ✕ box
        // handleSelect uses) and reset the probe display: the feedback row
        // is hidden and the badge falls back to the entry's own (registry)
        // source, which stays truthful because nothing was persisted.
        const message = e instanceof Error ? e.message : String(e);
        setProbeState('idle');
        setErrorMessage(
          `${t('Image probe verdict could not be saved.')}\n\n${message}`,
        );
        return;
      }
    }
    setProbeState(result.verdict);
  }, [
    highlightedEntry,
    highlightedEntryKey,
    probeState,
    scope,
    setErrorMessage,
    settings,
  ]);

  // Modality badge/value provenance is a two-layer source. Layer 1 is the
  // registry's registration-time cache (`modalitiesSource`), which a plain
  // settings.setValue does not refresh without a registry reload — and we
  // deliberately do NOT reload mid-dialog. Layer 2 is the live settings
  // store (`probeResults`), read on every render for the highlighted entry
  // — but ONLY while that entry is still pattern-cached; 'explicit' and
  // 'probe' stamps show their own value (a hand-written explicit
  // declaration is the phase-1 way out of a wrong verdict, so it must not
  // be shadowed by the stale probe record underneath). A local verdict from
  // THIS dialog's probe overrides both, so the panel never contradicts
  // itself mid-feedback (e.g. `text-only · probe-tested` above
  // `accepts images`).
  const displayedProbeVerdict: 'image' | 'text_only' | undefined =
    activeProbeState === 'image' || activeProbeState === 'text_only'
      ? activeProbeState
      : liveProbeVerdict;
  const displayedModalitiesSource: ModalitySource | undefined =
    displayedProbeVerdict !== undefined
      ? 'probe'
      : highlightedEntry?.model.modalitiesSource;
  const displayedModalities: InputModalities | undefined =
    displayedProbeVerdict === 'image'
      ? { ...highlightedEntry?.model.modalities, image: true }
      : displayedProbeVerdict === 'text_only' &&
          highlightedEntry?.model.modalities
        ? { ...highlightedEntry.model.modalities, image: false }
        : highlightedEntry?.model.modalities;

  const probeFeedback: { text: string; color: string } | undefined =
    activeProbeState === 'probing'
      ? { text: t('testing…'), color: theme.text.secondary }
      : activeProbeState === 'unknown'
        ? {
            text: t('inconclusive (auth/rate-limit/timeout) — nothing written'),
            color: theme.status.warning,
          }
        : activeProbeState === 'image'
          ? { text: t('accepts images'), color: theme.status.success }
          : activeProbeState === 'text_only'
            ? { text: t('text only'), color: theme.text.secondary }
            : undefined;

  return {
    canTestImageSupport,
    handleTestImageSupport,
    displayedModalities,
    displayedModalitiesSource,
    probeFeedback,
  };
}
