# ACP model display metadata

## Problem

Long `[provider] id` strings in availableModels[].name truncate in narrow clients (e.g. Paseo).

## Non-goals

- Do not change modelProviders persisted names or ownsModel.
- Do not change ACP route modelId encoding (see acp-model-route-identity.md).
- CLI ModelDialog is a separate follow-up.
- Do not change packages/core/src/providers/\*\*.

## Wire contract

- modelId: unchanged route selector
- name: bare model.id when unique in the emission list; on duplicate ids, "{id} · {badge}"
- description: providerLabel when model.description empty; else preserve
- \_meta.contextLimit: existing
- \_meta.qwen (nested object): providerLabel, legacyName (when label !== name)
- Omit v1: providerId, regionId

## Derivation

- AvailableModel has no providerId today
- Parse bracket prefix from label at ACP/serve boundary only
- Short badge map for ModelStudio plans; Intl folded into badge text
- Single helper: packages/cli/src/acp-integration/acp-model-display.ts

## Call sites

- buildAvailableModels, buildConfigOptions, acpAgent workspace status, workspace-providers-status

## Compatibility

- set_model uses modelId only
- Clients ignoring \_meta get short name (+ collision suffix)
- legacyName for transition / dumb-client migration notes
- Disambiguation for smart clients: \_meta.qwen.providerLabel + distinct modelId, not name alone

## Relation to route identity

Display-only. Discriminator continues to use internal model.label unchanged.
