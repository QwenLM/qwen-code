/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  AuthType,
  shouldShowStep,
  resolveBaseUrl,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  fetchProviderModelIds,
  mergeDiscoveredModels,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import type {
  InputModalities,
  ModelSpec,
  ProviderConfig,
  ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { normalizeModelIds, maskApiKey } from './useAuth.js';

const debugLogger = createDebugLogger('PROVIDER_SETUP');

// ---------------------------------------------------------------------------
// Setup step names (generic, config-driven)
// ---------------------------------------------------------------------------

export type SetupStep =
  | 'protocol'
  | 'baseUrl'
  | 'apiKey'
  | 'models'
  | 'advancedConfig'
  | 'review';

const STEP_ORDER: SetupStep[] = [
  'protocol',
  'baseUrl',
  'apiKey',
  'models',
  'advancedConfig',
  'review',
];

/**
 * Lifecycle of the optional `GET {baseUrl}/models` lookup that backs the
 * recommendation list. `failed` covers every reason the endpoint did not
 * answer usefully — the wizard treats them all the same way, by showing the
 * built-in list — and is never fatal to the flow.
 */
export type ModelDiscoveryStatus = 'idle' | 'loading' | 'success' | 'failed';

export interface ModelIdsEditContext {
  customModelIds: string[];
  activeCustomModelId?: string;
  /**
   * The comma-segment index of `activeCustomModelId` in the raw custom-ids
   * text. The id alone cannot identify the token being edited: the same id
   * can sit in the buffer twice, and the caret can move between the copies.
   */
  activeCustomModelSegment?: number;
  removedRecommendationId?: string;
}

function getVisibleSteps(config: ProviderConfig): SetupStep[] {
  return STEP_ORDER.filter((step) => {
    if (step === 'review') return config.showAdvancedConfig === true;
    return shouldShowStep(config, step);
  });
}

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

export interface ProviderSetupState {
  provider: ProviderConfig | null;
  step: SetupStep | null;
  stepIndex: number;
  totalSteps: number;

  // Protocol (for custom provider)
  protocol: AuthType;

  // BaseUrl
  baseUrl: string;
  baseUrlPlaceholder: string;
  baseUrlOptionIndex: number;
  baseUrlError: string | null;

  // API Key
  apiKey: string;
  apiKeyError: string | null;

  // Model IDs
  modelIds: string;
  modelIdsError: string | null;

  /**
   * Models to offer as recommendations — the live list when discovery
   * succeeded, the provider's built-in list otherwise.
   */
  recommendedModels: ModelSpec[];
  discoveryStatus: ModelDiscoveryStatus;
  /**
   * Bumped whenever `recommendedModels` is replaced, so the model step can
   * re-derive its local checkbox state from the new list.
   */
  recommendedModelsRevision: number;

  // Advanced config
  thinkingEnabled: boolean;
  modalityEnabled: boolean;
  modalityImage: boolean;
  modalityVideo: boolean;
  modalityAudio: boolean;
  modalityPdf: boolean;
  contextWindowSize: string;
  focusedConfigIndex: number;

  // Preview
  previewJson: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useProviderSetupFlow(
  onSubmit: (
    config: ProviderConfig,
    inputs: ProviderSetupInputs,
  ) => Promise<void>,
) {
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [visibleSteps, setVisibleSteps] = useState<SetupStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);

  const [protocol, setProtocol] = useState<AuthType>(AuthType.USE_OPENAI);
  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlPlaceholder, setBaseUrlPlaceholder] = useState('');
  const [baseUrlOptionIndex, setBaseUrlOptionIndex] = useState(0);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [modelIds, setModelIds] = useState('');
  const [modelIdsError, setModelIdsError] = useState<string | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [modalityEnabled, setModalityEnabled] = useState(false);
  const [modalityImage, setModalityImage] = useState(true);
  const [modalityVideo, setModalityVideo] = useState(true);
  const [modalityAudio, setModalityAudio] = useState(false);
  const [modalityPdf, setModalityPdf] = useState(false);
  const [contextWindowSize, setContextWindowSize] = useState('');
  const [focusedConfigIndex, setFocusedConfigIndex] = useState(0);
  const [discoveredModels, setDiscoveredModels] = useState<ModelSpec[] | null>(
    null,
  );
  const [discoveryStatus, setDiscoveryStatus] =
    useState<ModelDiscoveryStatus>('idle');
  const [recommendedModelsRevision, setRecommendedModelsRevision] = useState(0);
  // Discovery runs once per (baseUrl, apiKey) pair per wizard session: the
  // model step is cheap to re-enter (Esc, then Enter) and the answer cannot
  // change in between.
  const discoveryCacheRef = useRef(new Map<string, ModelSpec[]>());
  const discoveryKeyRef = useRef<string | null>(null);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  // The selection as the user authored it: the defaults `start()` checked plus
  // every later edit on the model step. Discovery derives what is checked from
  // this rather than from its own previous output — the prune can only remove
  // ids, so pruning an already-pruned value makes the result depend on which
  // pairs the session visited instead of on the pair in force.
  const authoredModelIdsRef = useRef('');
  // Mirrors `discoveredModels` so the discovery effect can tell whether the
  // displayed list actually changes without taking the state as a dependency
  // (which would re-run the effect on its own result).
  const discoveredModelsRef = useRef<ModelSpec[] | null>(null);
  // The last selection the FLOW installed — start's defaults, discovery's
  // prune, a pair-change restore. An edit arrives as the whole composed
  // selection, so recording it as authored needs a reference point to tell the
  // user's delta from what discovery had already done to it, and this is that
  // point. Keystrokes deliberately do NOT move it: an edit is a delta against
  // what the wizard last put on screen, not against the previous keystroke.
  const displayedModelIdsRef = useRef('');
  // The selection on screen right now, keystrokes included.
  const liveModelIdsRef = useRef('');
  const modelIdsEditInProgressRef = useRef(false);
  const activeCustomModelIdRef = useRef<string | undefined>(undefined);
  // The caret resting in a token is not proof the user is editing it: an
  // arrow-key move back over a comma-terminated id reports it too. Set by a
  // text edit, and a caret report holds it true only while it stays inside
  // the occurrence that edit touched — so the prune's keep clause protects
  // tokens being typed, not tokens merely navigated to.
  const activeTokenEditTouchedRef = useRef(false);
  // The token occurrence the last text edit touched, as the caret's segment
  // index in the raw custom-ids text plus the id it owned. Caret reports
  // compare against it to tell "still inside the token being typed" from
  // "moved to another token" — the id alone cannot, because the same id can
  // sit in the buffer twice.
  const editedTokenRef = useRef<{ segment: number; id: string } | null>(null);
  const customModelIdsRef = useRef<string[]>([]);
  // The id `applyDiscoveredModels` checked on the user's behalf when the prune
  // emptied the selection. It is the wizard's pick, so it is stripped back out
  // of any edit before that edit becomes the authored baseline.
  const injectedModelIdRef = useRef<string | null>(null);
  // The id the keep clause shielded during an in-flight edit, plus the
  // custom ids on screen when the shield fired and the value the shielded
  // occurrence has held since. The shield freezes it into the authorship
  // reference point; typing on past it drops it from the committed
  // selection, and the commit delta must not read that as a removal. The
  // user can also DELETE the shielded token though, which is one — so the
  // exemption is limited to growth, and the growth evidence is latched
  // into the edit stream, attributed to the occurrence: `editModelIds`
  // follows the occurrence's value edit by edit and clears the freeze at
  // the first edit where that value leaves the buffer and no successor
  // appears in that same edit. A strict extension typed into ANOTHER
  // segment sat in the buffer before the value left, so its survival is
  // not growth; a deletion followed by a fresh retype passes through an
  // edit where the value leaves with no successor, and clears the freeze.
  const frozenTokenRef = useRef<{
    id: string;
    customs: string[];
    value: string;
  } | null>(null);
  // Ids the user deleted from the screen during an edit a resolve then
  // advanced the reference point over. Such a deletion carries no
  // removedRecommendationId, and the commit delta cannot see it either —
  // `before` moves with the reference point — so the capture folds it into
  // the next commit's removed set instead.
  const pendingRemovalRef = useRef<string[]>([]);

  const setDisplayedModelIds = useCallback((value: string) => {
    displayedModelIdsRef.current = value;
    liveModelIdsRef.current = value;
    modelIdsEditInProgressRef.current = false;
    activeCustomModelIdRef.current = undefined;
    customModelIdsRef.current = [];
    setModelIds(value);
  }, []);

  /** Move the on-screen selection without moving the authorship reference. */
  const editModelIds = useCallback(
    (value: string, context?: ModelIdsEditContext) => {
      // Keep the injected-id marker until an edit is committed: a longer id can
      // pass through the injected id as a transient prefix. The custom tokens
      // at commit distinguish that from a genuine retype. An actual removal is
      // still decisive immediately so unchecking and rechecking can endorse it.
      const customModelIds = context?.customModelIds ?? [];
      const prevCustoms = customModelIdsRef.current;
      customModelIdsRef.current = customModelIds;
      // Growth evidence for a frozen token is latched here, edit by edit,
      // and attributed to the frozen occurrence. The occurrence survives
      // an edit while the buffer still holds the value it last held; when
      // that value leaves the buffer, only a value appearing in THIS edit
      // can be the occurrence edited onward — a strict extension already
      // sitting in another segment is a different token, and its survival
      // does not shield the occurrence's deletion. A deletion therefore
      // clears the freeze, and a later retype cannot read as growth the
      // freeze never saw.
      const frozen = frozenTokenRef.current;
      if (frozen !== null && !customModelIds.includes(frozen.value)) {
        const grown = customModelIds.find(
          (custom) =>
            custom.startsWith(frozen.id) &&
            (custom === frozen.id ||
              (!frozen.customs.includes(custom) &&
                !prevCustoms.includes(custom))),
        );
        if (grown === undefined) {
          frozenTokenRef.current = null;
        } else {
          frozen.value = grown;
        }
      }
      const injected = injectedModelIdRef.current;
      if (injected !== null && !normalizeModelIds(value).includes(injected)) {
        injectedModelIdRef.current = null;
      }
      const removed = context?.removedRecommendationId;
      if (removed && !customModelIds.includes(removed)) {
        authoredModelIdsRef.current = normalizeModelIds(
          authoredModelIdsRef.current,
        )
          .filter((id) => id !== removed)
          .join(', ');
      }
      modelIdsEditInProgressRef.current = true;
      activeCustomModelIdRef.current = context?.activeCustomModelId;
      activeTokenEditTouchedRef.current = true;
      editedTokenRef.current =
        context?.activeCustomModelSegment !== undefined &&
        context.activeCustomModelId !== undefined
          ? {
              segment: context.activeCustomModelSegment,
              id: context.activeCustomModelId,
            }
          : null;
      liveModelIdsRef.current = value;
      setModelIds(value);
    },
    [],
  );

  /**
   * Fold the selection on screen into the authored baseline. The step composes
   * the whole selection, which by then also carries discovery's own edits: ids
   * the prune removed are absent and the fallback the wizard checked is
   * present. Recording that verbatim would bake this pair's endpoint into the
   * baseline, so it is applied as a delta against what the flow last put on
   * screen instead — ids the user never saw stay untouched, and the wizard's
   * fallback never reads as typed.
   *
   * R11-1: this is called when an edit is COMMITTED — submitted, or left
   * behind by stepping off `models`, or overtaken by a discovery result — and
   * deliberately not on every keystroke. A per-keystroke delta cannot tell a
   * removal from a token still being typed: while the user types
   * `qwen3.5-plus-latest`, the buffer passes through exactly `qwen3.5-plus`,
   * so the very next keystroke saw that id leave the composed selection and
   * deleted it from the baseline — although the user never saw or unchecked
   * it. It is an unserved built-in, pruned from the display but still in the
   * baseline, and the next pair change restored a selection missing it: a
   * default the new endpoint serves came back unchecked. Judging keystrokes
   * only by whether the vanished token was a strict prefix does not work
   * either — the additions half of this delta accumulated every intermediate
   * prefix into the baseline.
   */
  const recordAuthoredModelIds = useCallback((value?: string) => {
    const committed = value ?? liveModelIdsRef.current;
    const injected = injectedModelIdRef.current;
    const injectedWasAuthored =
      injected !== null && customModelIdsRef.current.includes(injected);
    const strip = (ids: string[]) =>
      injected === null || injectedWasAuthored
        ? ids
        : ids.filter((id) => id !== injected);
    const before = strip(normalizeModelIds(displayedModelIdsRef.current));
    const after = strip(normalizeModelIds(committed));
    // A token the keep clause shielded during an in-flight edit was frozen
    // into the reference point; typing on past it drops it from the
    // committed selection. That is growth, not a removal — the user never
    // unchecked anything. The shielded token can also be deleted outright,
    // though, and that IS a removal: the exemption rests on the freeze
    // surviving to here, which the latch in `editModelIds` maintains — a
    // deletion passes through an edit where the occurrence's value leaves
    // the buffer with no successor appearing in its place, and clears the
    // freeze on the spot. Provenance, not string shape: a removed id that
    // merely prefixes a surviving one is a rename or a deleted prefix
    // twin, and both are genuine removals.
    const frozen = frozenTokenRef.current;
    const exemptFrozenId = frozen !== null ? frozen.id : null;
    const removed = new Set(
      before.filter((id) => !after.includes(id) && id !== exemptFrozenId),
    );
    // An edit overtaken by a resolve loses its deletion half when the
    // reference point advances over it; fold the capture in, unless the
    // committed selection re-endorses an id since.
    for (const id of pendingRemovalRef.current) {
      if (!after.includes(id)) {
        removed.add(id);
      }
    }
    const authored = normalizeModelIds(authoredModelIdsRef.current).filter(
      (id) => !removed.has(id),
    );
    for (const id of after) {
      if (!authored.includes(id)) authored.push(id);
    }
    authoredModelIdsRef.current = authored.join(', ');
    // The commit is the new reference point: recording it twice would read the
    // second pass's `before` as ids the user had removed. The edit markers go
    // with it: the frozen id was folded into the baseline, and the token the
    // last edit touched no longer has any claim on the keep clause.
    displayedModelIdsRef.current = committed;
    liveModelIdsRef.current = committed;
    modelIdsEditInProgressRef.current = false;
    activeCustomModelIdRef.current = undefined;
    activeTokenEditTouchedRef.current = false;
    editedTokenRef.current = null;
    frozenTokenRef.current = null;
    pendingRemovalRef.current = [];
  }, []);

  const currentStep = visibleSteps[stepIndex] ?? null;

  // -- Model discovery ------------------------------------------------------

  const resetDiscovery = useCallback(() => {
    discoveryAbortRef.current?.abort();
    discoveryAbortRef.current = null;
    discoveryKeyRef.current = null;
    discoveredModelsRef.current = null;
    injectedModelIdRef.current = null;
    setDiscoveredModels(null);
    setDiscoveryStatus('idle');
  }, []);

  /**
   * Swap the recommendation list the model step renders. The revision bump is
   * what remounts `ModelIdsStep` so its checkbox and custom-input state is
   * re-derived; it is skipped when neither the list nor the selection changed,
   * because a spurious remount would wipe the user's in-progress search and
   * focus for nothing. A cache hit re-serves the same list yet can still prune
   * the selection, and the step derives its checkboxes only at mount — so the
   * caller passes `selectionChanged` for that case.
   */
  const replaceRecommendations = useCallback(
    (models: ModelSpec[] | null, selectionChanged = false) => {
      const previous = discoveredModelsRef.current;
      discoveredModelsRef.current = models;
      setDiscoveredModels(models);
      if (previous !== models || selectionChanged) {
        setRecommendedModelsRevision((revision) => revision + 1);
      }
    },
    [],
  );

  // Abort an in-flight lookup when the dialog goes away — nothing is left to
  // render its result into.
  useEffect(() => () => discoveryAbortRef.current?.abort(), []);

  const applyDiscoveredModels = useCallback(
    (config: ProviderConfig, models: ModelSpec[]) => {
      // Drop built-in ids the endpoint no longer serves from the pending
      // selection — leaving them checked would install exactly the stale
      // entries discovery exists to avoid. An unserved built-in id is dropped
      // whether it was checked by default or typed: the step composes both
      // into one string, so they are indistinguishable here. Ids outside the
      // built-in list are left alone; they may be legitimately unlisted
      // (private deployments, aliases).
      // A lookup can resolve while the user is typing into the step it is
      // about to replace, and an edit in progress is not a commit. R12-1:
      // folding that buffer into the baseline re-opens the R11-1 hazard from
      // the other side — while a longer custom id is typed the buffer passes
      // through shorter ids as exact prefixes, so a transient token reads as
      // BOTH halves of the delta. The user's uncheck never lands, the prune
      // keeps the id, and the swap below hands the checkbox back ticked over
      // the top of their half-typed text. Intermediate prefixes of an id that
      // is not a built-in get banked as authored the same way.
      const editInProgress = modelIdsEditInProgressRef.current;
      if (!editInProgress) {
        recordAuthoredModelIds();
      } else {
        // The resolve below installs a new reference point over the
        // uncommitted edit. Capture what the edit already deleted from the
        // screen first: once the reference point moves, the commit delta
        // reads `before === after` and the deletion has no other channel.
        const liveIds = normalizeModelIds(liveModelIdsRef.current);
        pendingRemovalRef.current = normalizeModelIds(
          displayedModelIdsRef.current,
        ).filter((id) => !liveIds.includes(id));
      }
      const served = new Set(models.map((model) => model.id));
      const builtIn = new Set(getDefaultModelIds(config));
      // Prune whatever is on screen. With a settled buffer that IS the
      // baseline — the pair-change release above puts it back — so the old
      // guarantee holds: the result depends on the pair in force, not on which
      // pairs the session visited. With an edit in flight it is the user's own
      // text, and pruning that rather than the baseline is what keeps their
      // keystrokes instead of overwriting them with a stale value. Either way
      // the baseline is left for the step's next real commit to move, which
      // sees the delta against the reference point set below.
      // The exemption branch is the only way an unserved built-in survives,
      // so record the id that survives through it: the freeze puts it into
      // the reference point installed below, and the commit that folds this
      // edit must not read its later disappearance as a removal.
      frozenTokenRef.current = null;
      const kept: string[] = [];
      for (const id of normalizeModelIds(
        editInProgress ? liveModelIdsRef.current : authoredModelIdsRef.current,
      )) {
        if (served.has(id) || !builtIn.has(id)) {
          kept.push(id);
        } else if (
          editInProgress &&
          activeTokenEditTouchedRef.current &&
          id === activeCustomModelIdRef.current
        ) {
          frozenTokenRef.current = {
            id,
            customs: customModelIdsRef.current,
            value: id,
          };
          kept.push(id);
        }
      }
      // Pruning everything would leave the step with nothing checked and no
      // way to submit; fall back to the provider's first live model. That is
      // the wizard's pick, not the user's, so it stays out of the authored
      // baseline: carried into the next pair it would read as a typed id,
      // survive a prune the endpoint does not serve it through, and suppress
      // that pair's own fallback.
      injectedModelIdRef.current = null;
      if (kept.length === 0 && models[0]) {
        injectedModelIdRef.current = models[0].id;
        kept.push(models[0].id);
      }
      const next = kept.join(', ');
      replaceRecommendations(models, next !== displayedModelIdsRef.current);
      setDiscoveryStatus('success');
      setDisplayedModelIds(next);
    },
    [recordAuthoredModelIds, replaceRecommendations, setDisplayedModelIds],
  );

  useEffect(() => {
    if (!provider?.supportsModelDiscovery) return;

    const resolvedBaseUrl = baseUrl.trim();
    const resolvedApiKey = apiKey.trim();
    // The cached list is merged against the fetching provider's built-in
    // specs, so it is only an answer for that provider — two providers can
    // share an endpoint and key within one dialog session.
    const discoveryKey = resolvedBaseUrl
      ? JSON.stringify([provider.id, resolvedBaseUrl, resolvedApiKey])
      : null;

    // Pair-change detection sits above the step guard on purpose. Changing the
    // key one step back (Esc off the model step, then retype) re-runs this
    // effect only while the user is off-step, so detecting it below the guard
    // would leave the abandoned lookup running with its key still claimed —
    // and both continuation guards would then pass when it resolved, applying
    // the pair the user moved off.
    if (
      discoveryKeyRef.current !== null &&
      discoveryKeyRef.current !== discoveryKey
    ) {
      if (currentStep === 'models') {
        // The run below claims the new pair in the same effect and installs
        // its own list, notice and selection, so only the key is released
        // here — replacing the display state twice would remount the step for
        // nothing.
        discoveryAbortRef.current?.abort();
        discoveryAbortRef.current = null;
        discoveryKeyRef.current = null;
      } else {
        // D4-1/D7-9: off-step there is no such run — this effect returns at
        // the guard below and does not come back until the user does. So the
        // list, the notice and the pruned selection would sit there still
        // describing the pair the user left, and `ModelIdsStep` reads them as
        // it mounts, one committed render before the re-entry can replace
        // them. A base-url change after a successful lookup therefore
        // re-entered the step showing the OLD endpoint's catalog under a
        // "success" notice, and a checkbox ticked in that render submitted an
        // id the new endpoint was never asked about. Release the display
        // state with the key, and put the selection back to what the user
        // authored — the previous pair's prune is not an answer for this one.
        resetDiscovery();
        setDisplayedModelIds(authoredModelIdsRef.current);
      }
    }

    if (currentStep !== 'models') return;
    if (!discoveryKey) return;
    if (discoveryKeyRef.current === discoveryKey) return;
    discoveryKeyRef.current = discoveryKey;

    const cached = discoveryCacheRef.current.get(discoveryKey);
    if (cached) {
      applyDiscoveredModels(provider, cached);
      return;
    }

    const controller = new AbortController();
    discoveryAbortRef.current = controller;
    // Until this pair answers, the previous pair's list is not an answer for
    // it — keep the notice ("fetching…") honest by falling back to the
    // built-ins, and bump the revision so the mounted step re-derives its
    // checkbox state against what is actually on screen.
    replaceRecommendations(null);
    // The selection goes back with the list. Leaving the previous pair's
    // prune in place would show the full built-in list over a selection
    // missing ids from it — and if this pair's lookup fails, nothing else
    // ever re-derives the selection.
    injectedModelIdRef.current = null;
    setDisplayedModelIds(authoredModelIdsRef.current);
    setDiscoveryStatus('loading');

    void (async () => {
      const result = await fetchProviderModelIds({
        baseUrl: resolvedBaseUrl,
        apiKey: resolvedApiKey,
        signal: controller.signal,
      });
      // `aborted` covers unmount; the key check covers a pair change that
      // raced this continuation — the release above happens on the next effect
      // run, which can land after this await resolved.
      if (controller.signal.aborted) return;
      if (discoveryKeyRef.current !== discoveryKey) return;
      if (!result.ok) {
        // Every failure mode lands here on purpose: the built-in list is a
        // working answer, so the step stays usable and says so quietly.
        // Quietly for the user, not for the log — the notice cannot say which
        // of six reasons applied without turning a non-event into an error.
        debugLogger.debug(
          `Model discovery failed (${result.reason}): ${result.message}`,
        );
        // The list on screen changes back to the built-ins, so the mounted
        // step must re-derive rather than keep checkbox state pointing at ids
        // the built-in list does not offer.
        replaceRecommendations(null);
        setDiscoveryStatus('failed');
        // A failure caches nothing, so releasing the pair key lets a later
        // re-entry retry it. Claiming the key for the session would freeze a
        // transient 429/timeout into "built-ins only" with no way back.
        discoveryKeyRef.current = null;
        return;
      }
      const merged = mergeDiscoveredModels(provider.models, result.ids);
      discoveryCacheRef.current.set(discoveryKey, merged);
      applyDiscoveredModels(provider, merged);
    })();
  }, [
    currentStep,
    provider,
    baseUrl,
    apiKey,
    applyDiscoveredModels,
    replaceRecommendations,
    resetDiscovery,
    setDisplayedModelIds,
  ]);

  // -- Lifecycle ------------------------------------------------------------

  const start = useCallback(
    (
      config: ProviderConfig,
      initialProtocol?: AuthType,
      existingEnv?: Record<string, string>,
      existingModelIds?: string[],
    ) => {
      setProvider(config);
      const steps = getVisibleSteps(config);
      setVisibleSteps(steps);
      setStepIndex(0);

      const proto = initialProtocol ?? config.protocol;
      setProtocol(proto);
      // For presets the baseUrl is fixed (string) or selected from options;
      // for the custom provider it's empty and the placeholder hints at the
      // default endpoint for the chosen protocol.
      const resolved = resolveBaseUrl(config);
      setBaseUrl(resolved);
      setBaseUrlPlaceholder(
        resolved ? '' : getDefaultBaseUrlForProtocol(proto),
      );
      setBaseUrlOptionIndex(0);
      setBaseUrlError(null);

      let prefillKey = '';
      if (existingEnv) {
        const envKeyName =
          typeof config.envKey === 'function'
            ? config.envKey(proto, resolved)
            : config.envKey;
        prefillKey = existingEnv[envKeyName] ?? '';
      }
      setApiKey(prefillKey);

      setApiKeyError(null);
      // Built-in defaults go to the recommended list (checked), user-added
      // custom IDs go to the input box. The ModelIdsStep component splits
      // flow.state.modelIds automatically based on config.models.
      const defaultIds = getDefaultModelIds(config);
      const customIds = existingModelIds ?? [];
      const initialModelIds = [...defaultIds, ...customIds].join(', ');
      authoredModelIdsRef.current = initialModelIds;
      injectedModelIdRef.current = null;
      frozenTokenRef.current = null;
      pendingRemovalRef.current = [];
      setDisplayedModelIds(initialModelIds);
      setModelIdsError(null);
      setThinkingEnabled(false);
      setModalityEnabled(false);
      setModalityImage(true);
      setModalityVideo(true);
      setModalityAudio(false);
      setModalityPdf(false);
      setContextWindowSize('');
      setFocusedConfigIndex(0);
      resetDiscovery();
    },
    [resetDiscovery, setDisplayedModelIds],
  );

  const reset = useCallback(() => {
    setProvider(null);
    setVisibleSteps([]);
    setStepIndex(0);
    resetDiscovery();
  }, [resetDiscovery]);

  const goBack = useCallback((): boolean => {
    // Stepping off `models` commits whatever was typed there: the pair change
    // this Esc usually precedes restores the selection FROM the baseline, so
    // an edit still sitting only on screen would be silently dropped.
    if (currentStep === 'models') recordAuthoredModelIds();
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
      return true;
    }
    reset();
    return false;
  }, [currentStep, recordAuthoredModelIds, stepIndex, reset]);

  const goNext = useCallback(() => {
    setStepIndex((i) => Math.min(i + 1, visibleSteps.length - 1));
  }, [visibleSteps]);

  // -- Step handlers --------------------------------------------------------

  const selectProtocol = useCallback(
    (selectedProtocol: AuthType) => {
      setProtocol(selectedProtocol);
      // Clear baseUrl so the user types fresh; show the protocol's default
      // endpoint as a placeholder (used if they submit blank).
      setBaseUrl('');
      setBaseUrlPlaceholder(getDefaultBaseUrlForProtocol(selectedProtocol));
      setApiKey('');
      setApiKeyError(null);
      goNext();
    },
    [goNext],
  );

  const selectBaseUrl = useCallback(
    (selectedUrl: string) => {
      setBaseUrl(selectedUrl);
      setBaseUrlError(null);
      goNext();
    },
    [goNext],
  );

  const submitBaseUrl = useCallback((): boolean => {
    // Empty input falls back to the placeholder default so the visible hint
    // matches what gets written.
    const effective = baseUrl.trim() || baseUrlPlaceholder.trim();
    if (!effective) {
      setBaseUrlError(t('Base URL cannot be empty.'));
      return false;
    }
    if (!/^https?:\/\//i.test(effective)) {
      setBaseUrlError(t('Base URL must start with http:// or https://.'));
      return false;
    }
    if (!baseUrl.trim()) {
      setBaseUrl(effective);
    }
    setBaseUrlError(null);
    goNext();
    return true;
  }, [baseUrl, baseUrlPlaceholder, goNext]);

  const changeBaseUrl = useCallback((value: string) => {
    setBaseUrl(value);
    setBaseUrlError(null);
  }, []);

  const changeApiKey = useCallback((value: string) => {
    setApiKey(value);
    setApiKeyError(null);
  }, []);

  // Shared helper: assemble ProviderSetupInputs from current form state
  const buildCurrentInputs = useCallback(
    (overrides?: Partial<ProviderSetupInputs>): ProviderSetupInputs => ({
      protocol: provider?.protocolOptions ? protocol : undefined,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      modelIds: normalizeModelIds(modelIds),
      ...overrides,
    }),
    [provider, protocol, baseUrl, apiKey, modelIds],
  );

  const submitOrNext = useCallback(
    (overrides?: Partial<ProviderSetupInputs>) => {
      if (stepIndex >= visibleSteps.length - 1) {
        if (provider) void onSubmit(provider, buildCurrentInputs(overrides));
      } else {
        goNext();
      }
    },
    [stepIndex, visibleSteps, provider, onSubmit, buildCurrentInputs, goNext],
  );

  const submitApiKey = useCallback(
    (keyOverride?: string): boolean => {
      const trimmed = (keyOverride ?? apiKey).trim();
      if (!trimmed) {
        setApiKeyError(t('API key cannot be empty.'));
        return false;
      }
      if (provider?.validateApiKey) {
        const err = provider.validateApiKey(trimmed, baseUrl);
        if (err) {
          setApiKeyError(err);
          return false;
        }
      }
      setApiKeyError(null);
      setApiKey(trimmed);
      submitOrNext({ apiKey: trimmed });
      return true;
    },
    [apiKey, provider, baseUrl, submitOrNext],
  );

  const highlightBaseUrl = useCallback(
    (url: string) => {
      if (provider && Array.isArray(provider.baseUrl)) {
        const idx = provider.baseUrl.findIndex((o) => o.url === url);
        setBaseUrlOptionIndex(idx >= 0 ? idx : 0);
      }
    },
    [provider],
  );

  const changeModelIds = useCallback(
    (value: string, context?: ModelIdsEditContext) => {
      editModelIds(value, context);
      setModelIdsError(null);
    },
    [editModelIds],
  );

  const changeActiveCustomModelId = useCallback(
    (value?: string, segment?: number) => {
      activeCustomModelIdRef.current = value;
      // Focus leaving (the undefined report with no segment) drops the
      // edited-occurrence marker for good: the tab/up paths back into the
      // input re-report the id at the unchanged caret offset, and a marker
      // that survived the leave would let that pure navigation re-arm the
      // latch below. A caret move into an EMPTY segment also reports an
      // undefined id, but with a numeric segment — that is navigation
      // inside the edit, not a leave, and the marker must survive it or
      // the latch cannot re-arm when the caret returns to the occurrence.
      // The next real edit sets the marker again either way.
      if (value === undefined && segment === undefined) {
        editedTokenRef.current = null;
      }
      // Navigation is not editing — except inside the very occurrence the
      // last text edit touched: that edit is still alive, and a lookup
      // landing before the next keystroke must keep shielding the token.
      // Any other report — another occurrence of the same id, a terminated
      // neighbour, focus leaving — ends the protection.
      const edited = editedTokenRef.current;
      activeTokenEditTouchedRef.current =
        edited !== null && segment === edited.segment && value === edited.id;
    },
    [],
  );

  const submitModelIds = useCallback(
    (overrides?: Partial<ProviderSetupInputs>): boolean => {
      const normalized = overrides?.modelIds ?? normalizeModelIds(modelIds);
      if (normalized.length === 0) {
        setModelIdsError(t('Model IDs cannot be empty.'));
        return false;
      }
      const submitted = normalized.join(', ');
      recordAuthoredModelIds(submitted);
      // What is installed is the selection on screen, pruned; the baseline
      // above only decides what a later pair change restores.
      setDisplayedModelIds(submitted);
      setModelIdsError(null);
      submitOrNext({ ...overrides, modelIds: normalized });
      return true;
    },
    [modelIds, recordAuthoredModelIds, setDisplayedModelIds, submitOrNext],
  );

  const advancedOptionCount = modalityEnabled ? 7 : 3;

  const moveAdvancedFocusUp = useCallback(() => {
    setFocusedConfigIndex((v) => (v <= 0 ? advancedOptionCount - 1 : v - 1));
  }, [advancedOptionCount]);

  const moveAdvancedFocusDown = useCallback(() => {
    setFocusedConfigIndex((v) => (v >= advancedOptionCount - 1 ? 0 : v + 1));
  }, [advancedOptionCount]);

  const toggleFocusedAdvancedOption = useCallback(() => {
    switch (focusedConfigIndex) {
      case 0:
        setThinkingEnabled((v) => !v);
        break;
      case 1:
        setModalityEnabled((v) => !v);
        break;
      case 2:
        setModalityImage((v) => !v);
        break;
      case 3:
        setModalityVideo((v) => !v);
        break;
      case 4:
        setModalityAudio((v) => !v);
        break;
      case 5:
        setModalityPdf((v) => !v);
        break;
      default:
        break;
    }
  }, [focusedConfigIndex]);

  const submitAdvancedConfig = useCallback(() => {
    goNext();
  }, [goNext]);

  // -- Final submit ---------------------------------------------------------

  const changeContextWindowSize = useCallback((value: string) => {
    setContextWindowSize(value.replace(/[^0-9]/g, ''));
  }, []);

  const submit = useCallback(() => {
    if (!provider) return;
    const multimodal: InputModalities | undefined = modalityEnabled
      ? {
          image: modalityImage || undefined,
          video: modalityVideo || undefined,
          audio: modalityAudio || undefined,
          pdf: modalityPdf || undefined,
        }
      : undefined;
    const ctxSize = parseInt(contextWindowSize, 10);
    // TODO: add maxTokens input field — type and buildInstallPlan support it but UI is deferred
    const hasAdvanced =
      thinkingEnabled || modalityEnabled || (ctxSize > 0 && !isNaN(ctxSize));
    const advancedConfig = hasAdvanced
      ? {
          enableThinking: thinkingEnabled || undefined,
          multimodal,
          contextWindowSize:
            ctxSize > 0 && !isNaN(ctxSize) ? ctxSize : undefined,
        }
      : undefined;
    void onSubmit(provider, buildCurrentInputs({ advancedConfig }));
  }, [
    provider,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    onSubmit,
    buildCurrentInputs,
  ]);

  // -- Preview JSON (for review step) ---------------------------------------

  const getPreviewJson = useCallback((): string => {
    if (!provider) return '';
    const envKey =
      typeof provider.envKey === 'function'
        ? provider.envKey(protocol, baseUrl.trim())
        : provider.envKey;
    const normalizedIds = normalizeModelIds(modelIds);
    const masked = maskApiKey(apiKey);

    const genConfig: Record<string, unknown> = {};
    if (thinkingEnabled) genConfig['extra_body'] = { enable_thinking: true };
    if (modalityEnabled) {
      const mod: Record<string, boolean> = {};
      if (modalityImage) mod['image'] = true;
      if (modalityVideo) mod['video'] = true;
      if (modalityAudio) mod['audio'] = true;
      if (modalityPdf) mod['pdf'] = true;
      if (Object.keys(mod).length > 0) genConfig['modalities'] = mod;
    }
    const ctxSize = parseInt(contextWindowSize, 10);
    if (ctxSize > 0 && !isNaN(ctxSize))
      genConfig['contextWindowSize'] = ctxSize;
    const hasGenConfig = Object.keys(genConfig).length > 0;

    const models = normalizedIds.map((id) => {
      const entry: Record<string, unknown> = {
        id,
        name: id,
        baseUrl: baseUrl.trim(),
        envKey,
      };
      if (hasGenConfig) entry['generationConfig'] = genConfig;
      return entry;
    });

    return JSON.stringify(
      {
        env: { [envKey]: masked },
        modelProviders: { [protocol]: models },
        security: { auth: { selectedType: protocol } },
        model: { name: normalizedIds[0] },
      },
      null,
      2,
    );
  }, [
    provider,
    protocol,
    baseUrl,
    apiKey,
    modelIds,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
  ]);

  // -- State ----------------------------------------------------------------

  const state: ProviderSetupState = {
    provider,
    step: currentStep,
    stepIndex: stepIndex + 1, // 1-based for display
    totalSteps: visibleSteps.length,
    protocol,
    baseUrl,
    baseUrlPlaceholder,
    baseUrlOptionIndex,
    baseUrlError,
    apiKey,
    apiKeyError,
    modelIds,
    modelIdsError,
    recommendedModels: discoveredModels ?? provider?.models ?? [],
    discoveryStatus,
    recommendedModelsRevision,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    focusedConfigIndex,
    previewJson: currentStep === 'review' ? getPreviewJson() : '',
  };

  return {
    state,
    start,
    reset,
    goBack,
    selectProtocol,
    selectBaseUrl,
    highlightBaseUrl,
    submitBaseUrl,
    changeBaseUrl,
    changeApiKey,
    submitApiKey,
    changeModelIds,
    changeActiveCustomModelId,
    submitModelIds,
    moveAdvancedFocusUp,
    moveAdvancedFocusDown,
    toggleFocusedAdvancedOption,
    changeContextWindowSize,
    submitAdvancedConfig,
    submit,
  };
}

export type ProviderSetupFlow = ReturnType<typeof useProviderSetupFlow>;
