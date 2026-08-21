# Copilot Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the shipped Copilot authentication flow, remove unsupported public surfaces, and make the branch ready for an upstream PR.

**Architecture:** The auth lane owns cancellation from the CLI hook through the core device-flow requests and makes token-cache reads lock-safe across managers. The surface lane removes inert configuration and catalog functionality, retains the static model preset, validates the Copilot default auth type, and improves the no-credential model-selection handoff.

**Tech Stack:** TypeScript, React hooks, Vitest, Node filesystem APIs.

**Spec:** `docs/superpowers/specs/2026-08-16-copilot-readiness-design.md`

## Global Constraints

- Preserve static Copilot model selection and family routing.
- Do not add dependencies or Enterprise configuration.
- Preserve bearer redaction and atomic bearer/endpoints snapshots.
- Every production change begins with a failing behavioral test and a deliberately passing control assertion.
- Run tests from the owning package directory.

---

### Task 1: Cancel Copilot device authentication safely

**Files:**

- Modify: `packages/cli/src/ui/auth/useAuth.ts`
- Modify: `packages/cli/src/ui/auth/useAuth.test.ts`
- Modify: `packages/core/src/copilot/copilot-auth.ts`
- Modify: `packages/core/src/copilot/copilot-auth.test.ts`

**Interfaces:**

- Consumes: `runCopilotDeviceFlow({ signal?: AbortSignal })` and `useAuthCommand.cancelAuthentication()`.
- Produces: Cancellation aborts all device-flow fetches and cannot persist credentials or install Copilot after cancellation.

- [ ] Add a core deferred-poll test that aborts after the polling request starts, resolves the request late, and expects rejection rather than a token. Keep the successful device-flow test as a control.
- [ ] Run `cd packages/core && npx vitest run src/copilot/copilot-auth.test.ts`; capture the expected RED assertion that no request signal was received or the late token resolved.
- [ ] Pass `signal` to both device-flow fetches and guard after awaited responses.
- [ ] Add a hook test that starts fallback device auth, calls cancellation, resolves the device flow late, and expects an aborted signal with no token persistence, settings change, auth refresh, or success history item. Keep a normal successful setup control.
- [ ] Run `cd packages/cli && npx vitest run src/ui/auth/useAuth.test.ts`; capture RED.
- [ ] Add an identity-safe `AbortController` ref and post-await continuation guards in `useAuth.ts`.
- [ ] Re-run both focused suites and capture GREEN.

### Task 2: Read cache before minting and serialize refresh

**Files:**

- Modify: `packages/core/src/copilot/copilot-auth.ts`
- Modify: `packages/core/src/copilot/copilot-auth.test.ts`

**Interfaces:**

- Consumes: `createCopilotTokenManager({ cacheFile, fetchImpl })`.
- Produces: A fresh manager returns valid fresh disk data without discovery/exchange; only one manager mints or force-refreshes for a shared cache.

- [ ] Add RED tests for fresh disk-cache short-circuit, expired cache remint, two managers sharing one cache with exactly one exchange, and two managers concurrently force-refreshing with exactly one replacement exchange. Preserve the existing same-manager `mintInFlight` test as a control.
- [ ] Run `cd packages/core && npx vitest run src/copilot/copilot-auth.test.ts`; capture RED.
- [ ] Validate disk-cache JSON shape, read before minting, lock before discovery/exchange, re-read under the lock, and use the same serialized path for force refresh.
- [ ] Re-run the focused suite and capture GREEN.

### Task 3: Remove unsupported Copilot configuration and catalog APIs

**Files:**

- Modify: `packages/cli/src/config/settingsSchema.ts`
- Modify: `packages/cli/src/config/settingsSchema.test.ts`
- Delete: `packages/core/src/copilot/copilot-models.ts`
- Delete: `packages/core/src/copilot/copilot-models.test.ts`
- Modify: `packages/core/src/copilot/copilot-auth.ts`
- Modify: `packages/core/src/copilot/copilot-auth.test.ts`
- Modify: `packages/core/src/copilot/copilot-fetch.ts`
- Modify: `packages/core/src/copilot/wire-headers.test.ts`
- Modify: `packages/core/src/copilot/live-capi.live.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/copilot/copilot-fetch.test.ts`
- Modify: `packages/core/src/copilot/sentinel-invariant.test.ts`
- Modify: `docs/superpowers/specs/2026-08-16-copilot-auth-design.md`
- Modify: `docs/superpowers/plans/2026-08-16-copilot-auth.md`
- Modify: `docs/users/configuration/model-providers.md`
- Modify: `docs/users/overview.md`

**Interfaces:**

- Consumes: static `copilotProvider` preset and `routeForModel()` family routing.
- Produces: no inert schema keys or exported/live catalog APIs; requests on `/models` receive no catalog-only API-version header.

- [ ] Add RED assertions that the schema has no `security.auth.copilot`, a dynamic package-barrel import has no catalog exports, a manager has no `getAvailableModelIds`, and `/models` does not receive catalog-only headers. Keep static-model and message/response header tests as controls.
- [ ] Run owning CLI/core focused test files and capture RED.
- [ ] Remove the schema object, catalog module/export/stub/mock members, catalog-only fetch handling/tests, and stale internal and user-facing documentation claims.
- [ ] Re-run focused suites and capture GREEN.

### Task 4: Complete default validation and the no-credential model-selection handoff

**Files:**

- Modify: `packages/cli/src/ui/auth/useAuth.ts`
- Modify: `packages/cli/src/ui/auth/useAuth.test.ts`
- Modify: `packages/cli/src/ui/auth/AuthDialog.tsx`
- Modify: `packages/cli/src/ui/auth/AuthDialog.test.tsx`
- Modify: `packages/cli/src/ui/components/ModelDialog.tsx`
- Modify: `packages/cli/src/ui/components/ModelDialog.test.tsx`

**Interfaces:**

- Consumes: `QWEN_DEFAULT_AUTH_TYPE`, `AuthType.USE_COPILOT`, ModelDialog’s existing open-auth callback, and AuthDialog’s view-level state.
- Produces: Copilot is an accepted default auth type; a Copilot model chosen without credentials opens auth directly in the GitHub Copilot setup flow, while ordinary `/auth` still opens its generic chooser.

- [ ] Add RED test that `QWEN_DEFAULT_AUTH_TYPE=copilot` produces no validation error while an invalid value still errors.
- [ ] Add RED UI tests that selecting a Copilot model with no credentials requests `AuthType.USE_COPILOT`, and AuthDialog enters the GitHub Copilot setup flow from that request; retain a normal generic `/auth` chooser control.
- [ ] Run `cd packages/cli && npx vitest run src/ui/auth/useAuth.test.ts src/ui/auth/AuthDialog.test.tsx src/ui/components/ModelDialog.test.tsx`; capture RED.
- [ ] Add only the enum validator member and the smallest existing callback/state plumbing that maps a Copilot request to the GitHub Copilot setup view.
- [ ] Re-run the focused suite and capture GREEN.

### Task 5: Review-gated verification

**Files:**

- Review all changed files and the final diff.

- [ ] Use a fresh read-only generalist to review the final commit for correctness, security, regression risks, and test adequacy.
- [ ] Address only verified review findings through new RED–GREEN cycles.
- [ ] Run targeted core and CLI suites, `npm run typecheck`, `npm run lint`, and `npm run build`.
- [ ] Read the complete final diff, including documentation and deleted files, twice; stop after two clean passes.
- [ ] Prepare PR title/body files but do not create a PR.
