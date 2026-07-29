# E2E Test Plan: Custom Hex Session Group Colors

## Scope

Validate issue #6744 across daemon persistence, REST/SDK behavior, WebShell
editing, and preset quick-tag regression boundaries.

## Baseline dry-run

Use the globally installed CLI before the local build:

```bash
qwen --version
```

Create or update a named session group with `#12ABEF` through the existing
session-groups endpoint. Expected baseline: HTTP 400 with
`code=invalid_group_color`; the WebShell editor exposes only six presets.

## Group A: core contract

Command:

```bash
cd packages/core
npx vitest run src/services/session-organization-service.test.ts
```

Expected after implementation:

- create/update accepts `#12ABEF` (including accidental surrounding
  whitespace) and returns `#12abef`;
- list/restart preserves the canonical value;
- malformed Hex values return `invalid_group_color`;
- session quick tags still reject Hex;
- the preset catalog remains unchanged.

## Group B: daemon transport and SDK

Commands:

```bash
cd packages/cli
npx vitest run src/serve/server.test.ts src/serve/acp-http/transport.test.ts

cd ../sdk-typescript
npx vitest run test/unit/DaemonClient.test.ts
```

Expected after implementation: REST and ACP group mutations round-trip Hex;
session organization remains preset-only; SDK group types and responses expose
the custom value.

## Group C: WebShell UI

Command:

```bash
cd packages/web-shell
npx vitest run client/components/sidebar/WebShellSidebar.test.tsx
```

Expected after implementation:

- Create/Rename group offers a Custom option.
- The native color input and Hex text field stay synchronized.
- Invalid text keeps the picker on the last valid custom color.
- Invalid Hex disables Save and exposes an accessible error.
- Existing custom values reopen in Custom mode.
- Custom group dots use the persisted Hex color.
- Preset selection remains unchanged.

## Build verification

```bash
npm run format
npm run build
npm run typecheck
npm run bundle
```

## Manual WebShell check

Use a unique temporary workspace and session name:

```bash
export QWEN_RUNTIME_DIR="$(mktemp -d /tmp/qwen-hex-groups.XXXXXX)"
node dist/cli.js serve --web
```

In the WebShell, create `Hex demo` with `#12ABEF`, reload, rename it, switch to
a preset, then back to Custom. Confirm the dot color and lowercase Hex persist.
Also confirm a quick session tag still offers only the six presets.

## Results

Verified on macOS:

- Baseline global `qwen` was `0.19.4-dataworks.0`; it predates session
  organization, so the live daemon baseline was skipped. The pre-change main
  source was used as the reproducible baseline: non-preset group colors throw
  `invalid_group_color`.
- Core contract: 24 passed.
- REST named-group Hex path: 1 passed (674 unrelated tests skipped).
- ACP HTTP named-group Hex path: 1 passed (271 unrelated tests skipped).
- TypeScript SDK: 229 passed.
- WebShell sidebar: 61 passed; only pre-existing React `act()` warnings.
- Full `server.test.ts`: 674 passed, 1 unrelated failure in extension-update
  status handling (expected 202, received 200).
- Root build passes after syncing upstream main with the
  `ScheduledTasksDialog` import fix from #6748. Core and WebShell package
  typechecks pass.

The WebShell editor was rendered against a local fixture daemon to capture the
picker + Hex field screenshot in the PR. Persistence and normalization were
verified through the live REST path and focused tests. Windows and Linux
behavior is delegated to CI.
