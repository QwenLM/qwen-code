# Custom Hex Colors for Named Session Groups

## Problem

Named session groups currently share the six-value color enum used by quick
session color tags. The daemon rejects any other value with
`invalid_group_color`, the TypeScript SDK exposes the same closed union, and the
WebShell editor only offers a preset select. Users cannot align named groups
with an existing project palette or visually distinguish a larger group
catalog.

Tracked by [#6744](https://github.com/QwenLM/qwen-code/issues/6744).

## Proposed changes

| Layer          | Change                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core           | Split preset session-tag colors from named-group display colors. Named groups accept presets or six-digit `#RRGGBB`; quick tags remain preset-only. Normalize valid Hex values to lowercase before persistence. |
| REST and ACP   | Keep quick-tag validation preset-only and pass named-group colors to core validation.                                                                                                                           |
| TypeScript SDK | Export preset and Hex color types. Group input/output uses their union; session organization continues to use preset colors.                                                                                    |
| WebShell       | Keep preset choices and add a Custom option with a native color picker and Hex text field. Render custom group dots with an inline background color.                                                            |

## Decisions

- Accept only six-digit `#RRGGBB`. Three-, four-, and eight-digit forms are
  rejected so every persisted value has one predictable shape.
- Canonicalize Hex values to lowercase in core. Clients may normalize earlier
  for immediate feedback, but core remains authoritative.
- Do not expand quick session color tags. Their six-value catalog remains a
  compact ordering/filter dimension and stays backward compatible.
- Keep the sidecar schema version at 1. The stored field remains a string and
  older preset values remain valid.
- Existing clients that do not recognize a Hex class should fail safely. The
  WebShell renders Hex group dots through an inline `background-color`.

## Files

- `packages/core/src/services/session-organization-service.ts`
- `packages/core/src/services/session-organization-service.test.ts`
- `packages/cli/src/serve/routes/session.ts`
- `packages/cli/src/serve/acp-http/dispatch.ts`
- `packages/cli/src/serve/server/session-list.ts`
- `packages/acp-bridge/src/bridgeTypes.ts`
- `packages/sdk-typescript/src/daemon/types.ts`
- `packages/sdk-typescript/src/daemon/index.ts`
- `packages/sdk-typescript/src/index.ts`
- `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`
- `packages/web-shell/client/components/SessionOverviewPanel.tsx`
- `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css`
- `packages/web-shell/client/components/sidebar/WebShellSidebar.test.tsx`
- `packages/web-shell/client/i18n.tsx`

## Out of scope

- Custom colors for quick session tags.
- Alpha channels, gradients, named CSS colors, or short Hex forms.
- Changing the group sidecar format or migrating existing values.

## Open questions

None. The existing structured error and group persistence paths can be extended
without a protocol version bump.
