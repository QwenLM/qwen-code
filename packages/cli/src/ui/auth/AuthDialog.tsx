/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { t } from '../../i18n/index.js';
import {
  findProviderById,
  findProviderByCredentials,
  findExistingProviderModels,
  getDefaultModelIds,
  legacyEnvKeyAttribution,
  normalizeBaseUrlForMatching,
  resolveBaseUrl,
  customProvider,
  ALIBABA_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
  type AuthType,
  type ProviderConfig,
  type ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewLevel =
  | 'main'
  | 'alibaba-select'
  | 'thirdparty-select'
  | 'provider-setup';

type MainOption =
  | 'ALIBABA_MODELSTUDIO'
  | 'THIRD_PARTY_PROVIDERS'
  | 'CUSTOM_PROVIDER';

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const MAIN_ITEMS = [
  {
    key: 'ALIBABA_MODELSTUDIO',
    title: t('Alibaba ModelStudio'),
    label: t('Alibaba ModelStudio'),
    description: t(
      'Official recommended setup: Coding Plan, Token Plan, or Standard API Key',
    ),
    value: 'ALIBABA_MODELSTUDIO' as MainOption,
  },
  {
    key: 'THIRD_PARTY_PROVIDERS',
    title: t('Third-party Providers'),
    label: t('Third-party Providers'),
    description: t('Choose a built-in provider and connect with an API key'),
    value: 'THIRD_PARTY_PROVIDERS' as MainOption,
  },
  {
    key: 'CUSTOM_PROVIDER',
    title: t('Custom Provider'),
    label: t('Custom Provider'),
    description: t(
      'Manually connect a local server, proxy, or unsupported provider',
    ),
    value: 'CUSTOM_PROVIDER' as MainOption,
  },
];

function providerToItem(config: ProviderConfig) {
  return {
    key: config.id,
    title: t(config.label),
    label: t(config.label),
    description: (
      <Text color={theme.text.secondary} wrap="truncate">
        {t(config.description)}
      </Text>
    ),
    value: config.id,
  };
}

// ---------------------------------------------------------------------------
// Step label for provider-setup title bar
// ---------------------------------------------------------------------------

function getStepLabel(step: string | null, p: ProviderConfig): string {
  if (step === 'protocol') return t('Protocol');
  if (step === 'baseUrl') {
    if (p.uiLabels?.baseUrlStepTitle) return t(p.uiLabels.baseUrlStepTitle);
    return Array.isArray(p.baseUrl) ? t('Endpoint') : t('Base URL');
  }
  if (step === 'apiKey') return t('API Key');
  if (step === 'models') return t('Model IDs');
  if (step === 'advancedConfig') return t('Advanced Config');
  if (step === 'review') return t('Review');
  return '';
}

// ---------------------------------------------------------------------------
// View titles
// ---------------------------------------------------------------------------

const VIEW_TITLES: Record<string, string> = {
  main: t('Connect a Provider'),
  'alibaba-select': t('Alibaba ModelStudio · Access Method'),
  'thirdparty-select': t('Third-party Providers · Provider'),
};

const DEFAULT_DIALOG_HEIGHT = 24;
const MAIN_LIST_FIXED_ROWS = 10;
const SUB_MENU_LIST_FIXED_ROWS = 7;
const LIST_ITEM_ROWS = 3;
// Two arrow rows plus the two extra gaps itemGap adds around them.
const SCROLL_AFFORDANCE_ROWS = 4;

interface AuthDialogProps {
  availableTerminalHeight?: number;
  initialViewLevel?: Exclude<ViewLevel, 'provider-setup'>;
}

export function getMaxItemsToShow(
  dialogHeight: number,
  itemCount: number,
  fixedRows: number,
): number {
  if (itemCount === 0) return 1;
  if (fixedRows + itemCount * LIST_ITEM_ROWS <= dialogHeight) {
    return itemCount;
  }
  return Math.max(
    1,
    Math.floor(
      (dialogHeight - fixedRows - SCROLL_AFFORDANCE_ROWS) / LIST_ITEM_ROWS,
    ),
  );
}

/**
 * Shared preserve computation for `getExistingProviderSetup` and
 * `getProtocolSetups` — the two flatMaps were verbatim twins, and the
 * dialog reads whichever view `start()` prefers, so fixing one without the
 * other left the behavior unchanged (R43-3).
 *
 * A baseUrl-less legacy entry carries its endpoint only in its env key
 * (`legacyEnvKeyAttribution`):
 * - Attributable to the restored endpoint (`namesSelectedEndpoint`): seeded
 *   STAMPED at that endpoint, and its id emitted in
 *   `migratedLegacyModelIds` so buildInstallPlan claims the stored
 *   original and the pair collapses to the stamped copy instead of
 *   persisting as a permanent duplicate (the dialog route produced no
 *   `migratedLegacyModelIds` at all before R43-3).
 * - Fail-closed (a shared/sibling key, R41-4): never seeded, never
 *   stamped, never claimed. Merge-provider install plans scope ownsModel to
 *   the submitted endpoint, so such an entry survives unseeded; non-merge
 *   providers' plans carry the UNSCOPED ownsModel predicate, so the entry
 *   must be carried through UNSTAMPED — omission alone deletes it via
 *   prepend-and-remove-owned.
 */
function computePreservedModels(
  providerConfig: ProviderConfig,
  protocol: AuthType,
  restoredBaseUrl: string,
  savedModels: readonly ProviderModelConfig[],
): {
  preserveModels: ProviderModelConfig[];
  migratedLegacyModelIds: string[];
} {
  const restoredEndpoint = normalizeBaseUrlForMatching(restoredBaseUrl);
  const { endpointEnvKey, namesSelectedEndpoint, namesSiblingEndpoint } =
    legacyEnvKeyAttribution(providerConfig, protocol, restoredBaseUrl);
  const restoredDefaults = new Set(
    getDefaultModelIds(providerConfig, restoredBaseUrl),
  );
  // Ids that already have a stamped entry at the restored endpoint. A
  // same-id baseUrl-less legacy entry must not be carried beside its twin:
  // nothing downstream dedups preserved-against-preserved, so the pair would
  // persist as two permanent duplicate (id, baseUrl) entries (R39-7 — the
  // collapse the ACP/serve routes apply in their connect paths).
  const stampedIdsAtRestoredEndpoint = new Set(
    savedModels
      .filter(
        (model) =>
          model.baseUrl !== undefined &&
          normalizeBaseUrlForMatching(model.baseUrl) === restoredEndpoint,
      )
      .map((model) => model.id),
  );
  const migratedLegacyModelIds: string[] = [];
  const preserveModels = savedModels.flatMap((model) => {
    if (model.baseUrl === undefined) {
      if (!namesSelectedEndpoint(model)) {
        if (
          !providerConfig.mergeModelsByIdentity &&
          namesSiblingEndpoint(model)
        ) {
          return [model];
        }
        return [];
      }
      migratedLegacyModelIds.push(model.id);
      // A default id is regenerated stamped at the restored endpoint; the
      // claim above collapses the stored original into it.
      if (restoredDefaults.has(model.id)) return [];
      // A stamped twin at the restored endpoint wins (R39-7); the claim
      // above collapses the stored original into the twin, so the stamped
      // copy must not be carried a second time.
      if (stampedIdsAtRestoredEndpoint.has(model.id)) return [];
      return [
        {
          ...model,
          baseUrl: restoredBaseUrl,
          // Stamping migrates the entry to the restored endpoint; its env
          // key must follow so the entry points at the key this install
          // writes, not at the pre-migration one (R39-6).
          ...(endpointEnvKey ? { envKey: endpointEnvKey } : {}),
        },
      ];
    }
    const belongsToAnotherEndpoint =
      normalizeBaseUrlForMatching(model.baseUrl) !== restoredEndpoint;
    const endpointDefaults = new Set(
      getDefaultModelIds(providerConfig, model.baseUrl),
    );
    const shouldPreserve =
      (!providerConfig.mergeModelsByIdentity && belongsToAnotherEndpoint) ||
      // A non-merge ARRAY-baseUrl provider owns every endpoint under one
      // unscoped ownsModel, so the restored endpoint's DEFAULT entries must
      // be carried too: when the user switches endpoint before submitting,
      // nothing regenerates them and the remove-owned merge deletes them
      // (the sibling-carry branch in buildCurrentInputs can only carry what
      // reaches preserveModelsRef). Same-endpoint submits stay unchanged —
      // buildCurrentInputs' final branch still drops default ids there, so
      // they are regenerated from the field. String-baseUrl providers keep
      // the replace-on-move semantics (no sibling endpoints exist; the
      // update path rebuilds them the same way). Merge providers are
      // unaffected (endpoint-scoped ownsModel never deletes a sibling).
      (!providerConfig.mergeModelsByIdentity &&
        Array.isArray(providerConfig.baseUrl)) ||
      // Custom models of every saved endpoint are carried: submitting at a
      // sibling endpoint must rebuild its models from these rich entries,
      // otherwise their stored generationConfig is silently reset. Sibling
      // entries keep their own baseUrl and are written back unchanged.
      !endpointDefaults.has(model.id);
    return shouldPreserve ? [model] : [];
  });
  return { preserveModels, migratedLegacyModelIds };
}

export function getExistingProviderSetup(
  providerConfig: ProviderConfig,
  modelProviders: Record<string, unknown> | undefined,
): {
  initialProtocol: ProviderConfig['protocol'] | undefined;
  initialBaseUrl: string | undefined;
  customModelIds: string[];
  trimmedDefaultModelIds: string[];
  modelIdsByBaseUrl: ReadonlyMap<string, readonly string[]>;
  preserveModels?: ProviderModelConfig[];
  migratedLegacyModelIds?: string[];
  floatingLegacyModels?: ProviderModelConfig[];
} {
  const saved = findExistingProviderModels(providerConfig, modelProviders);
  const savedBaseUrl = saved?.models[0]?.baseUrl;
  // Array-baseUrl providers pass the first saved model's baseUrl through
  // UNRESOLVED: the restored seed and the per-endpoint maps must reflect the
  // entry's actual (possibly stale/hand-edited) URL so custom models saved
  // there are still surfaced and prefilled. The duplicate that a divergent
  // submission endpoint would create is closed at submit time instead:
  // useProviderSetupFlow.buildCurrentInputs re-stamps such entries at the
  // submission endpoint and emits their ids in migratedLegacyModelIds, and
  // buildInstallPlan claims the stale original through its stale-stamped
  // clause (an entry stamped at a URL matching no preset option).
  const initialBaseUrl = saved
    ? typeof providerConfig.baseUrl === 'string' || savedBaseUrl === undefined
      ? resolveBaseUrl(providerConfig, savedBaseUrl)
      : savedBaseUrl
    : undefined;
  // Attribution gate for baseUrl-less legacy entries (R43-3): only entries
  // the restored endpoint unambiguously owns participate in the restored
  // seed (models field and per-endpoint maps); shared/sibling keys fail
  // closed and stay invisible to the dialog — seeding them let the preserve
  // computation stamp them into the restored endpoint and buildInstallPlan
  // write a re-homed copy the stored original never collapsed into.
  const restoredAttribution =
    saved === undefined || initialBaseUrl === undefined
      ? undefined
      : legacyEnvKeyAttribution(providerConfig, saved.protocol, initialBaseUrl);
  const restoredLegacyAttributed = (model: ProviderModelConfig): boolean =>
    model.baseUrl !== undefined ||
    (restoredAttribution !== undefined &&
      restoredAttribution.namesSelectedEndpoint(model));
  // FLOATING baseUrl-less legacy entries (env key names NO endpoint, so they
  // fail attribution at every endpoint and never reach the seed or
  // preserveModels). Threading them to the flow lets a submission that
  // explicitly types one of their ids adopt it through
  // adoptedFloatingModelIds — without the channel the stamped copy is
  // written while the stored original can never be claimed, a permanent
  // duplicate (twin of the ACP/serve/VS Code adoption channel).
  const floatingLegacyModels =
    saved?.models.filter(
      (model) =>
        model.baseUrl === undefined &&
        restoredAttribution !== undefined &&
        !restoredAttribution.namesSelectedEndpoint(model) &&
        !restoredAttribution.namesSiblingEndpoint(model),
    ) ?? [];
  const modelIdsByBaseUrl = new Map<string, string[]>();
  for (const model of saved?.models ?? []) {
    if (!restoredLegacyAttributed(model)) continue;
    const modelBaseUrl = model.baseUrl ?? initialBaseUrl;
    if (modelBaseUrl === undefined) continue;
    // A stamped entry of an array-baseUrl provider that matches no preset
    // option is stale (hand-edited settings, an earlier iteration's stamp):
    // key it under its OWN URL instead of letting resolveBaseUrl snap it to
    // the first option — re-keying it there polluted that option's id map
    // (a protocol-switch stash would pre-fill the stale id under the real
    // option). The stale URL is never a selectable endpoint, so the entry
    // stays inert in the per-endpoint maps while its id is still prefilled
    // through restoredModelIds.
    const matchesAnOption =
      !Array.isArray(providerConfig.baseUrl) ||
      model.baseUrl === undefined ||
      providerConfig.baseUrl.some(
        (option) =>
          normalizeBaseUrlForMatching(option.url) ===
          normalizeBaseUrlForMatching(model.baseUrl),
      );
    const resolvedBaseUrl = matchesAnOption
      ? normalizeBaseUrlForMatching(
          resolveBaseUrl(providerConfig, modelBaseUrl),
        )
      : normalizeBaseUrlForMatching(modelBaseUrl);
    const modelIds = modelIdsByBaseUrl.get(resolvedBaseUrl) ?? [];
    if (!modelIds.includes(model.id)) modelIds.push(model.id);
    modelIdsByBaseUrl.set(resolvedBaseUrl, modelIds);
  }
  // Scope built-ins to the restored endpoint: a saved model whose id collides
  // with a *sibling* endpoint's built-in is user data for this endpoint, and
  // dropping it here lets the prepend-and-remove-owned merge delete it on the
  // next no-op resubmit.
  const builtinIds = new Set(
    getDefaultModelIds(providerConfig, initialBaseUrl),
  );
  const restoredModelIds =
    saved?.models
      .filter(
        (model) =>
          restoredLegacyAttributed(model) &&
          (model.baseUrl === undefined ||
            normalizeBaseUrlForMatching(model.baseUrl) ===
              normalizeBaseUrlForMatching(initialBaseUrl)),
      )
      .map((model) => model.id) ?? [];
  const { preserveModels, migratedLegacyModelIds } =
    saved === undefined || initialBaseUrl === undefined
      ? {
          preserveModels: [] as ProviderModelConfig[],
          migratedLegacyModelIds: [] as string[],
        }
      : computePreservedModels(
          providerConfig,
          saved.protocol,
          initialBaseUrl,
          saved.models,
        );
  const restoredModelIdSet = new Set(restoredModelIds);
  return {
    initialProtocol: saved?.protocol,
    initialBaseUrl,
    // The form restores the first saved model's endpoint, so seed only that
    // endpoint's custom models; siblings are retained as exact model objects.
    customModelIds: restoredModelIds.filter((id) => !builtinIds.has(id)),
    trimmedDefaultModelIds: saved
      ? [...builtinIds].filter((id) => !restoredModelIdSet.has(id))
      : [],
    modelIdsByBaseUrl,
    ...(preserveModels.length > 0 ? { preserveModels } : {}),
    ...(migratedLegacyModelIds.length > 0 ? { migratedLegacyModelIds } : {}),
    ...(floatingLegacyModels.length > 0 ? { floatingLegacyModels } : {}),
  };
}

/**
 * Per-protocol saved-state views. The same baseUrl can be connected under
 * several protocol buckets (LiteLLM-style proxies are the stated Custom
 * Provider use case). Seeding only the first bucket means switching protocol
 * then submitting deletes the selected bucket's saved models (their ids never
 * reach preserveModels) and pre-fills the wrong protocol's ids (R34-2/
 * R35-12). Compute each supported protocol's saved state so the flow can
 * swap on protocol change.
 */
export function getProtocolSetups(
  providerConfig: ProviderConfig,
  modelProviders: Record<string, unknown> | undefined,
): {
  modelIdsByBaseUrlByProtocol: ReadonlyMap<
    AuthType,
    ReadonlyMap<string, readonly string[]>
  >;
  preserveModelsByProtocol: ReadonlyMap<
    AuthType,
    readonly ProviderModelConfig[]
  >;
  migratedLegacyModelIdsByProtocol: ReadonlyMap<AuthType, readonly string[]>;
  baseUrlByProtocol: ReadonlyMap<AuthType, string>;
  floatingLegacyModelsByProtocol: ReadonlyMap<
    AuthType,
    readonly ProviderModelConfig[]
  >;
} {
  const supportedProtocols = providerConfig.protocolOptions?.length
    ? providerConfig.protocolOptions
    : [providerConfig.protocol];
  const modelIdsByBaseUrlByProtocol = new Map<
    AuthType,
    Map<string, string[]>
  >();
  const preserveModelsByProtocol = new Map<AuthType, ProviderModelConfig[]>();
  const migratedLegacyModelIdsByProtocol = new Map<AuthType, string[]>();
  const baseUrlByProtocol = new Map<AuthType, string>();
  const floatingLegacyModelsByProtocol = new Map<
    AuthType,
    ProviderModelConfig[]
  >();
  for (const proto of supportedProtocols) {
    const savedForProto = findExistingProviderModels(
      providerConfig,
      modelProviders,
      proto,
    );
    if (!savedForProto || savedForProto.models.length === 0) continue;
    const protoFirstBaseUrl = savedForProto.models[0]?.baseUrl;
    const protoBaseUrl =
      typeof providerConfig.baseUrl === 'string' ||
      protoFirstBaseUrl === undefined
        ? resolveBaseUrl(providerConfig, protoFirstBaseUrl)
        : protoFirstBaseUrl;
    if (protoBaseUrl) {
      baseUrlByProtocol.set(proto, protoBaseUrl);
    }
    // Same attribution gate as getExistingProviderSetup (R43-3): this is
    // the view useProviderSetupFlow.start() prefers, so it must enforce the
    // identical fail-closed seeding. Computed UNCONDITIONALLY — protoBaseUrl
    // is always a string, and a free-form bucket whose first saved model has
    // no baseUrl resolves to '' here exactly like initialBaseUrl does in the
    // flat view; gating on truthiness skipped the attribution and the
    // preserve computation for that bucket, so a protocol switch-and-back
    // emptied preserveModels while the flat view had computed it (the two
    // views diverged on gate shape).
    const protoAttribution = legacyEnvKeyAttribution(
      providerConfig,
      proto,
      protoBaseUrl,
    );
    const protoLegacyAttributed = (model: ProviderModelConfig): boolean =>
      model.baseUrl !== undefined ||
      protoAttribution.namesSelectedEndpoint(model);
    const protoFloating = savedForProto.models.filter(
      (model) =>
        model.baseUrl === undefined &&
        !protoAttribution.namesSelectedEndpoint(model) &&
        !protoAttribution.namesSiblingEndpoint(model),
    );
    if (protoFloating.length > 0) {
      floatingLegacyModelsByProtocol.set(proto, protoFloating);
    }
    const protoModelIdsByBaseUrl = new Map<string, string[]>();
    for (const model of savedForProto.models) {
      if (!protoLegacyAttributed(model)) continue;
      const modelBaseUrl = model.baseUrl ?? protoBaseUrl;
      if (modelBaseUrl === undefined) continue;
      // Stale-URL guard: see getExistingProviderSetup — an array-baseUrl
      // entry matching no option is keyed under its own URL, never re-keyed
      // under the first option.
      const matchesAnOption =
        !Array.isArray(providerConfig.baseUrl) ||
        model.baseUrl === undefined ||
        providerConfig.baseUrl.some(
          (option) =>
            normalizeBaseUrlForMatching(option.url) ===
            normalizeBaseUrlForMatching(model.baseUrl),
        );
      const resolvedModelBaseUrl = matchesAnOption
        ? normalizeBaseUrlForMatching(
            resolveBaseUrl(providerConfig, modelBaseUrl),
          )
        : normalizeBaseUrlForMatching(modelBaseUrl);
      const ids = protoModelIdsByBaseUrl.get(resolvedModelBaseUrl) ?? [];
      if (!ids.includes(model.id)) ids.push(model.id);
      protoModelIdsByBaseUrl.set(resolvedModelBaseUrl, ids);
    }
    modelIdsByBaseUrlByProtocol.set(proto, protoModelIdsByBaseUrl);
    const {
      preserveModels: protoPreserveModels,
      migratedLegacyModelIds: protoMigratedIds,
    } = computePreservedModels(
      providerConfig,
      proto,
      protoBaseUrl,
      savedForProto.models,
    );
    if (protoPreserveModels.length > 0) {
      preserveModelsByProtocol.set(proto, protoPreserveModels);
    }
    if (protoMigratedIds.length > 0) {
      migratedLegacyModelIdsByProtocol.set(proto, protoMigratedIds);
    }
  }
  return {
    modelIdsByBaseUrlByProtocol,
    preserveModelsByProtocol,
    migratedLegacyModelIdsByProtocol,
    baseUrlByProtocol,
    floatingLegacyModelsByProtocol,
  };
}

// ---------------------------------------------------------------------------
// AuthDialog
// ---------------------------------------------------------------------------

export function AuthDialog({
  availableTerminalHeight,
  initialViewLevel = 'main',
}: AuthDialogProps = {}): React.JSX.Element {
  const {
    auth: { authError },
  } = useUIState();
  const {
    auth: { closeAuthDialog, handleProviderSubmit, onAuthError },
  } = useUIActions();
  const config = useConfig();
  const settings = useSettings();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>(initialViewLevel);
  const [_viewStack, setViewStack] = useState<ViewLevel[]>([]);

  const [mainIndex, setMainIndex] = useState<number | null>(null);
  const [subMenuIndex, setSubMenuIndex] = useState<Record<string, number>>({});

  const setupFlow = useProviderSetupFlow(handleProviderSubmit);

  // -- Navigation -----------------------------------------------------------

  const clearErrors = () => {
    setErrorMessage(null);
    onAuthError(null);
  };

  const pushView = (view: ViewLevel) => {
    setViewStack((prev) => [...prev, viewLevel]);
    setViewLevel(view);
  };

  const goBack = () => {
    clearErrors();

    if (viewLevel === 'provider-setup') {
      if (setupFlow.goBack()) return;
    }

    setViewStack((prev) => {
      const next = [...prev];
      const parent = next.pop() ?? 'main';
      setViewLevel(parent);
      return next;
    });
  };

  // -- Sub-menu definitions (data-driven) -----------------------------------

  const alibabaItems = useMemo(() => ALIBABA_PROVIDERS.map(providerToItem), []);
  const thirdPartyItems = useMemo(
    () => THIRD_PARTY_PROVIDERS.map(providerToItem),
    [],
  );

  const existingEnv = (settings.merged.env ?? {}) as Record<string, string>;

  const handleProviderSelect = (providerId: string) => {
    clearErrors();
    const providerConfig = findProviderById(providerId);
    if (!providerConfig) return;
    const mergedModelProviders = settings.merged.modelProviders as
      | Record<string, unknown>
      | undefined;
    const existingSetup = getExistingProviderSetup(
      providerConfig,
      mergedModelProviders,
    );
    const protocolSetups = getProtocolSetups(
      providerConfig,
      mergedModelProviders,
    );
    setupFlow.start(
      providerConfig,
      existingSetup.initialProtocol,
      existingEnv,
      existingSetup.customModelIds,
      existingSetup.initialBaseUrl,
      existingSetup.trimmedDefaultModelIds,
      existingSetup.modelIdsByBaseUrl,
      existingSetup.preserveModels,
      protocolSetups.modelIdsByBaseUrlByProtocol,
      protocolSetups.preserveModelsByProtocol,
      protocolSetups.baseUrlByProtocol,
      existingSetup.migratedLegacyModelIds,
      protocolSetups.migratedLegacyModelIdsByProtocol,
      existingSetup.floatingLegacyModels,
      protocolSetups.floatingLegacyModelsByProtocol,
    );
    pushView('provider-setup');
  };

  const subMenus: Record<
    string,
    {
      items: Array<ReturnType<typeof providerToItem>>;
      onSelect: (v: string) => void;
    }
  > = {
    'alibaba-select': {
      items: alibabaItems,
      onSelect: handleProviderSelect,
    },
    'thirdparty-select': {
      items: thirdPartyItems,
      onSelect: handleProviderSelect,
    },
  };

  const activeSubMenu = subMenus[viewLevel];
  const dialogHeight = availableTerminalHeight ?? DEFAULT_DIALOG_HEIGHT;
  const listHeight = dialogHeight - (authError || errorMessage ? 2 : 0);
  const maxMainItems = getMaxItemsToShow(
    listHeight,
    MAIN_ITEMS.length,
    MAIN_LIST_FIXED_ROWS,
  );
  const maxSubMenuItems = getMaxItemsToShow(
    listHeight,
    activeSubMenu?.items.length ?? 0,
    SUB_MENU_LIST_FIXED_ROWS,
  );

  // -- Default main index from current auth state ---------------------------

  const contentGenConfig = config.getContentGeneratorConfig();
  const matchedProvider = findProviderByCredentials(
    contentGenConfig?.baseUrl,
    contentGenConfig?.apiKeyEnvKey,
  );

  // Land on the tab that matches the active provider's uiGroup so a DeepSeek
  // / MiniMax / OpenRouter user opens Third-party Providers, not Alibaba.
  // (resolveMetadataKey returns config.id for *any* provider with a static
  // models[], so it can't be used to detect "Alibaba" specifically.)
  const defaultMainIndex = useMemo(() => {
    if (matchedProvider?.uiGroup === 'third-party') return 1;
    if (matchedProvider?.uiGroup === 'custom') return 2;
    return 0;
  }, [matchedProvider]);

  // -- Handlers -------------------------------------------------------------

  const handleMainSelect = (value: MainOption) => {
    clearErrors();
    switch (value) {
      case 'ALIBABA_MODELSTUDIO':
        pushView('alibaba-select');
        break;
      case 'THIRD_PARTY_PROVIDERS':
        pushView('thirdparty-select');
        break;
      case 'CUSTOM_PROVIDER': {
        const customModelProviders = settings.merged.modelProviders as
          | Record<string, unknown>
          | undefined;
        const existingSetup = getExistingProviderSetup(
          customProvider,
          customModelProviders,
        );
        const customProtocolSetups = getProtocolSetups(
          customProvider,
          customModelProviders,
        );
        setupFlow.start(
          customProvider,
          existingSetup.initialProtocol,
          existingEnv,
          existingSetup.customModelIds,
          existingSetup.initialBaseUrl,
          existingSetup.trimmedDefaultModelIds,
          existingSetup.modelIdsByBaseUrl,
          existingSetup.preserveModels,
          customProtocolSetups.modelIdsByBaseUrlByProtocol,
          customProtocolSetups.preserveModelsByProtocol,
          customProtocolSetups.baseUrlByProtocol,
          existingSetup.migratedLegacyModelIds,
          customProtocolSetups.migratedLegacyModelIdsByProtocol,
          existingSetup.floatingLegacyModels,
          customProtocolSetups.floatingLegacyModelsByProtocol,
        );
        pushView('provider-setup');
        break;
      }
      default:
        break;
    }
  };

  // -- Keyboard handling ----------------------------------------------------

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (viewLevel !== 'main') {
          goBack();
          return;
        }
        if (errorMessage) return;
        if (config.getAuthType() === undefined) {
          setErrorMessage(
            t(
              'You must connect a provider to proceed. Press Ctrl+C again to exit.',
            ),
          );
          return;
        }
        closeAuthDialog();
      }
    },
    { isActive: true },
  );

  // -- View title -----------------------------------------------------------

  const viewTitle = useMemo(() => {
    if (viewLevel !== 'provider-setup') {
      return VIEW_TITLES[viewLevel] ?? VIEW_TITLES['main'];
    }
    const p = setupFlow.state.provider;
    if (!p) return t('Provider Setup');
    const flowTitle = p.uiLabels?.flowTitle ?? p.label;
    const { stepIndex, totalSteps, step } = setupFlow.state;
    return t('{{flowTitle}} · Step {{step}}/{{total}} · {{stepLabel}}', {
      flowTitle,
      step: String(stepIndex),
      total: String(totalSteps),
      stepLabel: getStepLabel(step, p),
    });
  }, [viewLevel, setupFlow.state]);

  // -- Render ---------------------------------------------------------------

  return (
    <Box
      borderStyle="single"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold wrap="truncate">
        {viewTitle}
      </Text>

      {viewLevel === 'main' && (
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={MAIN_ITEMS}
            initialIndex={mainIndex != null ? mainIndex : defaultMainIndex}
            onSelect={handleMainSelect}
            onHighlight={(value) => {
              setMainIndex(
                MAIN_ITEMS.findIndex((item) => item.value === value),
              );
            }}
            itemGap={1}
            maxItemsToShow={maxMainItems}
            showScrollArrows={
              MAIN_ITEMS.length > maxMainItems &&
              listHeight >=
                MAIN_LIST_FIXED_ROWS + LIST_ITEM_ROWS + SCROLL_AFFORDANCE_ROWS
            }
          />
        </Box>
      )}

      {activeSubMenu && (
        <>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={activeSubMenu.items}
              initialIndex={subMenuIndex[viewLevel] ?? 0}
              onSelect={activeSubMenu.onSelect}
              onHighlight={(value) => {
                setSubMenuIndex((prev) => ({
                  ...prev,
                  [viewLevel]: activeSubMenu.items.findIndex(
                    (i) => i.value === value,
                  ),
                }));
              }}
              itemGap={1}
              maxItemsToShow={maxSubMenuItems}
              showScrollArrows={
                activeSubMenu.items.length > maxSubMenuItems &&
                listHeight >=
                  SUB_MENU_LIST_FIXED_ROWS +
                    LIST_ITEM_ROWS +
                    SCROLL_AFFORDANCE_ROWS
              }
            />
          </Box>
          <Box marginTop={1}>
            <Text color={theme?.text?.secondary} wrap="truncate">
              {t('Enter to select, ↑↓ to navigate, Esc to go back')}
            </Text>
          </Box>
        </>
      )}

      {viewLevel === 'provider-setup' && (
        <ProviderSetupSteps flow={setupFlow} />
      )}

      {(authError || errorMessage) && (
        <Box marginTop={1}>
          <Text color={theme.status.error} wrap="truncate">
            {authError || errorMessage}
          </Text>
        </Box>
      )}

      {viewLevel === 'main' && (
        <>
          <Box marginY={1}>
            <Text color={theme.border.default} wrap="truncate">
              {'─'.repeat(80)}
            </Text>
          </Box>
          <Box>
            <Text color={theme.text.primary} wrap="truncate">
              {t('Terms of Services and Privacy Notice')}:
            </Text>
          </Box>
          <Box>
            <Link
              url="https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/"
              fallback={false}
            >
              <Text color={theme.text.secondary} underline wrap="truncate">
                https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/
              </Text>
            </Link>
          </Box>
        </>
      )}
    </Box>
  );
}
