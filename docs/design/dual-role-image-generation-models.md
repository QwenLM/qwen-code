# Dual-role image generation models

## Status

Proposed, 2026-08-20.

This document defines a backward-compatible model configuration change that
allows one configured model route to be used both as a normal conversation
model and by the built-in `image_gen` tool.

## Summary

Add one flat optional field to model provider entries:

```json
{
  "supportsImageGeneration": true
}
```

Keep the existing `imageOnly` field, but narrow its meaning to one concern:
whether the route is excluded from normal conversation-model selection.

The effective rules are:

- `supportsImageGeneration: true` makes a route eligible for `image_gen`.
- `imageOnly: true` prevents a route from being used as a primary or other
  ordinary content-generation model.
- Legacy `imageOnly: true` entries remain eligible for `image_gen` even when
  `supportsImageGeneration` is absent.
- Both fields are optional and behave as `false` when absent, except for the
  legacy implication above.

This separates an output capability from a selector restriction without
renaming or invalidating existing settings.

## Motivation

The current model uses `imageOnly` for two independent decisions:

1. whether a route supports the image-generation service; and
2. whether that route must be excluded from normal model selectors.

That representation works for dedicated generators such as an image-only
model, but it cannot represent a route that supports both normal conversation
and image generation. Marking such a route `imageOnly: true` makes it eligible
for `/model --image`, but also removes it from the main model list and causes
primary-model selection to fail.

The two concerns must be independent:

```text
image-generation capability  !=  image-generation exclusivity
```

The name `supportsImage` is intentionally not used. Qwen Code already uses
image capability terminology for image input and visual understanding through
`capabilities.vision`, `generationConfig.modalities.image`, and
`isImageCapable()`. Image input and image output are distinct capabilities.

## Goals

- Allow a single model provider entry to be selected both as the primary model
  and as `imageModel`.
- Preserve every existing `imageOnly: true` configuration without migration.
- Keep `imageOnly` as the selector-only restriction for dedicated generators.
- Keep the public configuration flat.
- Reuse the current image-generation transport, permissions, tool registration,
  workspace file storage, and artifact behavior unchanged.
- Make every image-generation eligibility decision use one shared predicate.

## Non-goals

- Do not add a new image-generation API protocol.
- Do not add separate image-generation endpoint, credential, or model-ID
  overrides to a dual-role route.
- Do not infer image-generation capability from `capabilities.vision`,
  `modalities.image`, a model name, or any other image-input signal.
- Do not automatically select an `imageModel`.
- Do not change `image_gen` prompt, size, permission, download, storage, or
  artifact semantics.
- Do not change which models are selected as fast, voice, vision, compaction,
  Arena, or subagent models except where existing `imageOnly` behavior already
  applies.
- Do not remove or rename `imageOnly`.

## Terminology

### Image input capability

The model can receive and understand images in a normal content-generation
request. Existing signals such as `capabilities.vision` and
`generationConfig.modalities.image` describe this direction.

### Image generation capability

The configured route can satisfy the built-in `image_gen` transport contract
and produce an image from a prompt. The new `supportsImageGeneration` field
describes this direction.

### Image-only route

The configured route is reserved for the image-generation selector and must
not be used for ordinary content generation. The existing `imageOnly` field
continues to describe this restriction.

`modelProviders` entries are configured routes. Two entries may represent the
same physical provider model when they intentionally use different endpoints
or provider identities.

## Configuration contract

### Type additions

Add the flat field to `ModelConfig`, `AvailableModel`, and provider template
types that currently carry `imageOnly`:

```ts
interface ModelConfig {
  /** Whether this route can be used by the built-in image_gen tool. */
  supportsImageGeneration?: boolean;

  /** Whether this route is restricted to the image generation selector. */
  imageOnly?: boolean;
}
```

The same names and meanings must survive provider-template expansion and model
registry resolution.

### Effective capability predicate

All image-generation eligibility checks use one shared helper:

```ts
export function isImageGenerationCapable(model: {
  supportsImageGeneration?: boolean;
  imageOnly?: boolean;
}): boolean {
  return model.supportsImageGeneration === true || model.imageOnly === true;
}
```

The `imageOnly` fallback is the compatibility rule. It must not be duplicated as
ad hoc boolean expressions across callers.

### Truth table

| `supportsImageGeneration` | `imageOnly`       | Image selector / `image_gen` | Primary model |
| ------------------------- | ----------------- | ---------------------------- | ------------- |
| absent or `false`         | absent or `false` | unavailable                  | allowed       |
| `true`                    | absent or `false` | available                    | allowed       |
| `true`                    | `true`            | available                    | rejected      |
| absent or `false`         | `true`            | available for compatibility  | rejected      |

If a configuration explicitly sets `supportsImageGeneration: false` together
with `imageOnly: true`, `imageOnly` wins for backward compatibility. The route
remains image-generation-capable and image-only. No migration or warning is
required.

### Examples

Dual-role route:

```json
{
  "id": "omni-model",
  "name": "Omni Model",
  "envKey": "MODEL_API_KEY",
  "baseUrl": "https://gateway.example.com/model-api",
  "supportsImageGeneration": true
}
```

Dedicated image route using the explicit new form:

```json
{
  "id": "image-model",
  "name": "Image Model",
  "envKey": "MODEL_API_KEY",
  "baseUrl": "https://images.example.com/api/v1",
  "supportsImageGeneration": true,
  "imageOnly": true
}
```

Legacy dedicated image route, which remains valid:

```json
{
  "id": "image-model",
  "envKey": "MODEL_API_KEY",
  "baseUrl": "https://images.example.com/api/v1",
  "imageOnly": true
}
```

## Endpoint contract

This change separates selection semantics only. It does not add a second
endpoint to one provider entry.

The current image-generation service validates the selected route's explicit
HTTPS `baseUrl`, reads the route's `envKey`, and calls the existing DashScope
multimodal-generation path. A dual-role entry therefore works only when its
configured `baseUrl` and credential are valid for both its normal provider
traffic and the existing image-generation transport.

When chat and image generation require different endpoints or credentials,
configuration must continue to use two model routes: one ordinary route and
one `imageOnly` route. A future endpoint-override design may add flat fields for
that case, but it is not part of this change.

## Runtime behavior

### Model discovery

Normal model discovery continues to exclude only `imageOnly: true` routes.
Setting `supportsImageGeneration: true` alone must not remove a route from the
main model list, Arena, provider selection, ACP selection, or other ordinary
content-generation paths.

### Image model discovery

`/model --image` and the image-model dialog include routes for which
`isImageGenerationCapable(model)` returns `true`.

Capability remains necessary but not sufficient. Existing validation still
requires:

- one unambiguous route match;
- an explicit valid HTTPS endpoint rather than a protocol default;
- a non-empty credential environment-variable name; and
- the existing selector-only restrictions enforced by the relevant selection
  surface.

### Primary model selection

Primary-model validation continues to reject only `imageOnly: true`. A route
with `supportsImageGeneration: true` and no `imageOnly` restriction remains a
normal primary model.

### Tool registration

Selecting a capable route as `imageModel` continues to hot-register
`image_gen`. Clearing or replacing `imageModel`, safe mode, bare mode, and tool
permission behavior remain unchanged.

### Image input behavior

`supportsImageGeneration` must not affect vision-bridge selection or image
input handling. A route that can generate images but cannot understand image
input does not become vision-capable. A dual-role route needs the existing
vision/modalities metadata separately if it also accepts image input.

## Source changes

### Shared model types and helper

- `packages/core/src/models/types.ts`
  - Add `supportsImageGeneration?: boolean` to `ModelConfig` and
    `AvailableModel`.
- Add a small shared model-capability helper under
  `packages/core/src/models/` and export it through the existing core model
  exports so CLI code does not duplicate the compatibility predicate.
- `packages/core/src/models/modelRegistry.ts`
  - Propagate `supportsImageGeneration` into `AvailableModel`.
  - Keep default-primary selection based on `!model.imageOnly`.

### Provider configuration plumbing

- `packages/core/src/providers/types.ts`
  - Add the flat field next to `imageOnly`.
- `packages/core/src/providers/provider-config.ts`
  - Preserve `supportsImageGeneration: true` when constructing provider model
    templates.

False and absent values may remain omitted, matching the existing compact
provider-template style.

### Core image-model resolution

- `packages/core/src/config/config.ts`
  - Replace the `model.imageOnly === true` image-generation eligibility check
    in `resolveImageGenerationModel()` with the shared predicate.
  - Keep explicit endpoint, environment key, ambiguity, safe-mode, bare-mode,
    and permission checks unchanged.
  - Keep all ordinary selector-only filtering based on `imageOnly` unchanged.

### CLI image selectors

- `packages/cli/src/ui/commands/modelCommand.ts`
  - Use the shared predicate for image-mode filtering and direct
    `/model --image <id>` matching.
  - Keep main, fast, voice, vision, and compaction exclusions based on
    `imageOnly` unchanged.
- `packages/cli/src/ui/components/ModelDialog.tsx`
  - Use the shared predicate for image-model mode.
  - Keep non-image mode exclusion based on `imageOnly` unchanged.

### Documentation and generated schema

- `packages/cli/src/config/settingsSchema.ts`
  - Update the `imageModel` description to require an image-generation-capable
    model rather than specifically an `imageOnly` model.
- `docs/users/configuration/model-providers.md`
  - Document the two fields, compatibility rule, endpoint constraint, and both
    dual-role and dedicated-route examples.
- `docs/users/configuration/settings.md`
  - Update the `imageModel` requirement.
- `docs/users/features/commands.md`
  - Describe `/model --image` as selecting an image-generation-capable model.
- Regenerate
  `packages/vscode-ide-companion/schemas/settings.schema.json` with
  `npm run generate:settings-schema` rather than editing it manually.
- Update the existing English configuration hint in `/model --image`. The locale
  catalogs contain no translated `imageOnly` requirement, so they do not change.

`modelProviders` is intentionally an open object in the generated schema. The
schema diff therefore updates only the `imageModel` description; it does not add
field-level provider metadata.

## `imageOnly` read-site audit

Every current `imageOnly` read must be classified before editing it.

### Change to image-generation capability predicate

- Image model resolution in core config.
- `/model --image` filtering and exact-match selection.
- Image-model dialog filtering.

### Keep as `imageOnly` restriction

- Primary-model switching and content-generator construction.
- Default-model selection.
- Main available-model lists.
- Arena selection.
- Fast, voice, vision, and compaction selector-only filtering.
- ACP and non-interactive primary-model filtering.
- Vision bridge exclusion of dedicated image-only routes.
- Selector-only conflict diagnostics.

Changing a restriction read to the new capability predicate would recreate the
bug in reverse by excluding dual-role routes from normal conversation.

### Propagate the new field

- Provider model specifications and templates.
- Resolved model registry entries.
- `AvailableModel` values returned to CLI, ACP, daemon, and UI consumers.

## Compatibility and migration

No settings migration is required.

- Existing configurations without either field behave as before.
- Existing `imageOnly: true` configurations remain selectable for image
  generation and remain excluded from primary selection.
- Existing persisted `imageModel` selectors continue to resolve.
- The new field is additive and optional.
- Older Qwen Code versions ignore the unknown field. A dual-role route relying
  only on `supportsImageGeneration` will not expose `image_gen` on those
  versions, while legacy `imageOnly` routes continue to work.

Because old runtimes ignore the new field, downstream platforms must gate use
of dual-role configuration on a Qwen Code version that includes this change.

## Validation plan

### Core unit tests

Add focused coverage for the shared predicate:

- no fields returns false;
- `supportsImageGeneration: true` returns true;
- `imageOnly: true` returns true for compatibility;
- both true returns true;
- explicit support false plus `imageOnly: true` returns true.

Extend model-registry tests:

- the new field is propagated to `AvailableModel`;
- a dual-role route remains a valid default/primary model;
- a dedicated image-only route remains excluded from default selection.

Extend config tests:

- a dual-role route resolves as `imageModel`;
- selecting it hot-registers `image_gen`;
- it remains usable as the primary model;
- legacy `imageOnly: true` still resolves;
- capability without explicit endpoint or environment key still fails closed;
- duplicate matching routes remain ambiguous;
- safe mode and permission-disabled behavior remain unchanged.

Extend provider-config tests to prove the field survives template expansion.

### CLI unit tests

Extend `/model` command tests:

- dual-role routes appear in both main and image modes;
- dedicated image-only routes appear only in image mode;
- `/model <dual-role-id>` succeeds;
- `/model --image <dual-role-id>` succeeds and persists `imageModel`;
- the no-argument image-model status output remains unchanged;
- fast, voice, vision, and compaction filtering does not infer capability from
  `supportsImageGeneration`.

Extend model-dialog tests with the same dual-role and image-only matrix.

### Generated output

Run:

```bash
npm run generate:settings-schema
```

Review the generated schema diff to confirm only the intended description
change is present.

### Focused commands

Run tests from their package directories as required by the repository:

```bash
cd packages/core && npx vitest run \
  src/models/image-generation-capability.test.ts \
  src/models/modelRegistry.test.ts \
  src/models/modelsConfig.test.ts \
  src/config/config.test.ts \
  src/providers/__tests__/provider-config.test.ts

cd packages/cli && npx vitest run \
  src/ui/commands/modelCommand.test.ts \
  src/ui/components/ModelDialog.test.tsx \
  src/config/settingsSchema.test.ts
```

Then run:

```bash
npm run build
npm run typecheck
```

### Manual behavior check

Using a test endpoint that supports the existing image-generation protocol:

1. Configure one route with `supportsImageGeneration: true` and without
   `imageOnly`.
2. Select it as the primary model.
3. Select the same route with `/model --image`.
4. Request an image and approve `image_gen`.
5. Confirm the PNG is saved under
   `.qwen/generated-images/<session-id>/` and emitted as an image artifact.
6. Send a normal conversational turn and confirm the same route still works as
   the primary model.
7. Repeat with a legacy `imageOnly: true` route and confirm it remains rejected
   as the primary model.

## Acceptance criteria

- A route with `supportsImageGeneration: true` and no `imageOnly` restriction
  can be selected both as the primary model and as `imageModel`.
- The built-in `image_gen` tool registers and executes for that route when all
  existing endpoint, credential, mode, and permission checks pass.
- A route with `imageOnly: true` remains unavailable as a primary model.
- Legacy image-only configurations require no migration.
- Image-input capability is neither granted nor inferred by the new field.
- No normal selector excludes a route solely because
  `supportsImageGeneration` is true.
- Documentation and user-facing errors no longer say that `imageOnly: true` is
  the only way to configure image generation.
- Focused tests, build, and typecheck pass.

## Implementation sequence

1. Add the flat field, shared predicate, exports, and type plumbing.
2. Add core predicate and registry tests.
3. Change only the three image-generation eligibility paths.
4. Add core resolver and provider-template tests.
5. Update CLI command and dialog filtering with focused tests.
6. Update settings descriptions, user documentation, the English configuration
   hint, and generated schema.
7. Run focused tests, build, and typecheck.
8. Audit every `imageOnly` read site against the classification in this
   document before submitting the PR.

## Suggested PR shape

Use one focused PR with a title such as:

```text
feat(models): support dual-role image generation models
```

The PR should not include endpoint overrides, provider-specific configuration,
automatic image-model selection, or unrelated model-capability cleanup. Those
would widen the compatibility surface and obscure the selector-semantics fix.
