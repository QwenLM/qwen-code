# `qwen serve --open-with-auth` implementation plan

- Status: Implemented in [#9738](https://github.com/QwenLM/qwen-code/pull/9738)
- Baseline: `main` at `ea872a4621` (2026-08-22)
- Revalidated: `main` at `7385b278b2` (2026-08-23)
- Design: [2026-08-22-serve-open-with-auth.md](../design/2026-08-22-serve-open-with-auth.md)
- Related tracking issue:
  [#4514](https://github.com/QwenLM/qwen-code/issues/4514)

## Delivery rule

Implement this as one bounded, default-off CLI feature after the design is
approved. Add only the `--open-with-auth` CLI flag; do not add persistent
storage, a new authentication protocol, a public `ServeOptions` switch, or an
SDK discovery mechanism. The implementation must reuse the existing runtime
bearer and Web Shell fragment flow end to end.

The implementation PR starts from fresh `main`. It may touch the two CLI serve
entry paths, one authenticated-open helper, one token-selection leaf, targeted
tests, and the existing user/developer documentation. It must not change Core
browser eligibility, daemon middleware, or broaden into the pair-token and
revocation work in #4514.

## Phase 1: Shared temporary-token decision

- Extract the existing selection and normalization into a small
  `packages/cli/src/serve/serve-token.ts` leaf. Its operation accepts the
  option token and an optional environment-token string, defaulting to the
  single `process.env[QWEN_SERVER_TOKEN_ENV]` key. It owns the
  `optionToken ?? environmentToken` precedence, trims the selected string, and
  maps an empty result to `undefined`.
- Make both `runQwenServe()` and the authenticated-open helper call that operation.
  Neither caller may re-derive the precedence or trimming rule. This extraction
  changes no token source or runtime behavior; it makes future precedence
  changes authoritative in one place.
- Register that single computed environment access in the existing
  `process-env-guard.test.ts` allowance. Do not pass the whole `process.env`
  object across the helper boundary.
- Add a small `packages/cli/src/serve/open-with-auth.ts` helper shared by
  the yargs handler and fast path.
- Expose one operation that receives the materialized `ServeOptions` object.
  The callers invoke it only when `--open-with-auth` is true. It requires
  `isLoopbackBind(options.hostname)`, `serveWebShell !== false`, and resolvable
  Web Shell assets. Reuse the existing predicates and fail before listen even
  if an explicit token is configured.
- Treat browser-launch eligibility as advisory, not a hard gate. When
  `shouldLaunchBrowser()` is false, continue startup and print the
  fragment-bearing manual URL once the runtime is ready. Keep the existing
  Core browser heuristic and blocklist unchanged; the secure launcher already
  provides the matching manual-URL fallback after a launch attempt fails.
- Call the shared token selector and generate only when it returns `undefined`.
  Copy a selected configured token or the generated value into `options.token`
  before daemon startup so the decision is made once.
- Generate `randomBytes(32).toString('base64url')` and assign it only to
  `options.token`. Do not set `process.env`, write a credential file, add a
  token store, or expose the value in a diagnostic.
- Keep the helper outside `run-qwen-serve.ts`. Direct embedded callers do not
  have an `--open` concept and must retain their current token resolution.

## Phase 2: Wire both CLI entry paths

- Add the default-false `--open-with-auth` yargs option with help text that says
  it opens an authenticated local Web Shell, reusing or generating the bearer.
  Derive effective opening as `argv.open || argv['open-with-auth']`; do not add
  an invalid flag-combination check.
- In the yargs handler, materialize the existing inline `ServeOptions` object
  as a local value checked with `satisfies Parameters<typeof runQwenServe>[0]`
  after settings/environment loading. This retains repeatable startup
  workspaces while restoring excess-property checks. Apply the shared helper
  immediately before `runQwenServe()`.
- Extend the fast parser's normalized boolean mapping and parsed result with
  `open-with-auth` / `openWithAuth`. Store effective `open` as
  `open || openWithAuth`, including when `--no-open` is also present.
- In the fast path, apply the helper after
  `bootstrapServeFastPathEnvironment()` and existing option validation, so a
  trusted workspace or home `QWEN_SERVER_TOKEN` is visible before the decision.
- Dynamically import the helper only for `parsed.openWithAuth`. Bare `--open`
  must preserve the fast path's current import and startup boundary, and the
  full serve command opener remains deferred until runtime readiness.
- Run the existing explicit `--token` process-list warning before applying the
  generated token, so an internally generated value is not mislabeled as a CLI
  argument.
- When generation occurs, emit one shared non-secret message explaining that
  temporary authentication is active and that additional clients need an
  explicit shared token.
- Leave `maybeOpenWebShellBrowser()` responsible for waiting for runtime
  readiness, rewriting wildcard browser targets, adding `resolvedToken` as a
  fragment, and invoking the secure browser launcher. Do not re-derive or pass
  the generated token separately. When an opted-in launch skipped auto-open
  because the environment was ineligible, print the same fragment-bearing
  manual URL through the launcher's existing manual-URL wording once readiness
  resolves. Pin both entry points' fallback boolean with wiring tests.
- Do not change `RunHandle`, `ServeOptions`, `CredentialStore`, bearer
  middleware, mutation gates, Local Control credentials, channel-worker token
  separation, WebSocket authentication, or the Web Shell token reader. A new
  global Web Shell 401 recovery screen is explicitly deferred; document the
  missing-fragment recovery path instead of expanding this bounded CLI change.

## Phase 3: Documentation and migration guidance

- Document the new `--open-with-auth` option beside `--open` and update
  `docs/users/qwen-serve.md` with its prerequisites, default-off behavior,
  pre-authentication surfaces, and the fact that another no-token client
  receives 401 only inside the explicitly opted-in launch.
- Update `docs/developers/daemon/02-serve-runtime.md`,
  `docs/developers/daemon/12-auth-security.md`,
  `docs/developers/daemon/17-configuration.md`, and the authentication section
  of `docs/developers/qwen-serve-protocol.md` so token precedence includes the
  CLI-owned `--open-with-auth` generation step without implying that
  `runQwenServe()` itself gained a new source.
- Document the stable-token migration for multi-client use:
  `QWEN_SERVER_TOKEN=... qwen serve --open`, with the same value supplied to
  each SDK or curl client.
- Name affected first-party clients and their migrations: daemon-backed
  `qwen channel set/reload` and remote `status/stop` need the explicit shared
  token only when connecting to an opted-in temporary-token daemon; the Chrome
  extension keeps its documented plain
  `qwen serve --allow-origin chrome-extension://<id>` flow without the new flag
  because it cannot discover the generated credential.
- Add the channel-command migration to `docs/users/qwen-serve.md`, and add a
  scoped note to `packages/chrome-extension/README.md` that the extension
  cannot discover an opted-in generated credential. The extension command and
  onboarding prompt already omit `--open`, so they do not need a behavior
  change.
- Document process lifetime, per-tab `sessionStorage`, restart rotation,
  tab-close loss, missing-fragment and storage-unavailable 401 behavior,
  browser-launch command visibility, and the existing secret-bearing manual-URL
  fallback on launch failure.
- Document that the authenticated-open flag deliberately activates an explicit
  `--enable-session-shell`, deliberately satisfies the `--allow-origin '*'`
  bearer guard, and leaves the documented static-asset and loopback `/health`
  surfaces unchanged. Bare `--open` does none of these things.
- Cross-reference the existing Desktop Shell per-launch token design and state
  why its child-environment, hex encoding, and unconditional `--require-auth`
  choices differ from this CLI-owned flow.
- Reference #4514 as related future work without closing it or claiming that
  auto-generated token storage, identity, or revocation is complete.

## Unit test matrix

Add collocated tests for the shared selector and helper, and extend the existing
command and fast-path suites.

| Scenario                                                                         | Expected result                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Plain `qwen serve`                                                               | No token is generated                                              |
| Bare interactive loopback `--open`                                               | No token is generated; existing behavior is unchanged              |
| Eligible `--open-with-auth` with Web Shell assets                                | Opens the browser and assigns a selected or generated token        |
| `--open --open-with-auth`                                                        | Same authenticated behavior; the extra `--open` is harmless        |
| Non-empty `--token` on an eligible opted-in launch                               | Explicit token is retained; no token is generated                  |
| Non-empty `QWEN_SERVER_TOKEN` with no CLI token on an eligible opted-in launch   | Environment token remains authoritative                            |
| Whitespace-only selected token on an eligible opted-in launch                    | Treated as absent and replaced                                     |
| `--open-with-auth --no-web`                                                      | CLI validation error before listen                                 |
| Opted-in launch with missing Web Shell assets                                    | CLI validation error before listen                                 |
| Opted-in launch in CI, headless Linux, or ineligible SSH                         | Starts and prints the fragment-bearing manual URL                  |
| `localhost`, uppercase `LOCALHOST`, `127.0.0.1`, `127.0.0.2`, `::1`, and `[::1]` | Eligible forms accepted through `isLoopbackBind()`                 |
| `0.0.0.0`, `[::]`, or a LAN address                                              | CLI validation error even when another token is configured         |
| `--open-with-auth --require-auth` with no configured token                       | Generated token reaches `runQwenServe()`                           |
| `--open-with-auth --enable-session-shell` with no configured token               | Generated token activates the explicit shell opt-in                |
| `--open-with-auth --allow-origin '*'` with no configured token                   | Token is generated before the wildcard-origin boot guard runs      |
| `--open-with-auth --local-control` with no configured token                      | Primary gets the runtime token; LAN retains only its pairing token |

Also verify:

- An eligible opted-in generation emits the shared non-secret breadcrumb, and
  the emitted message does not contain the generated token value.
- The yargs and fast paths parse the new flag and invoke the same decision
  after their environment bootstrap.
- `runQwenServe()` and the generation helper both import the shared selector;
  no caller retains a duplicate precedence or trimming implementation.
- Selector tests preserve the current choose-before-trim order, including that
  a whitespace-only option value shadows a non-empty environment value and
  then normalizes to `undefined`.
- Workspace/home settings that supply `QWEN_SERVER_TOKEN` suppress generation
  on the fast path.
- Generation leaves `process.env.QWEN_SERVER_TOKEN` absent or byte-for-byte
  unchanged, including when the selected value is whitespace-only.
- Static review confirms the helper uses only the filesystem reads required by
  the existing `resolveWebShellDir()` asset pre-check, performs no filesystem
  write, and introduces no credential-file path.
- The normal fast path, including bare `--open`, does not load the authenticated-open
  helper or full command module.
- Each entry path captures the token at the instant it calls `runQwenServe()`;
  mutating a shared options object later must not make the ordering tests pass.
- The fast path exits before listen when the helper rejects an invalid bind or
  Web Shell configuration.
- `maybeOpenWebShellBrowser()` receives the daemon's `resolvedToken`, adds it as
  `#token=`, and does not put it in a query parameter or normal success logs.
- Existing `runQwenServe()` token trimming, non-loopback refusal,
  `--require-auth`, `/health`, strict mutation, and worker-redaction tests stay
  unchanged and green.

Run targeted tests from the CLI package:

```bash
cd packages/cli
npx vitest run \
  src/serve/serve-token.test.ts \
  src/serve/open-with-auth.test.ts \
  src/serve/process-env-guard.test.ts \
  src/commands/serve.test.ts \
  src/serve/fast-path.test.ts \
  src/serve/fast-path-open.test.ts
```

Then run repository verification:

```bash
npm run build
npm run typecheck
npm run lint
```

## E2E test plan

Before implementation, record the current behavior with the globally installed
`qwen` CLI as required by the repository workflow. Store the plan and results
under `.qwen/e2e-tests/`; do not commit that ignored artifact.

Build and bundle the candidate. Use a temporary executable as `BROWSER` so the
test captures the browser URL without exposing a real credential to another
application.

1. Record that bare `qwen serve --port 0 --open` still launches without an
   automatic token: unauthenticated `/capabilities` returns 200 and a strict
   mutation without a token returns `token_required`.
2. Start `qwen serve --port 0 --open-with-auth` on loopback with no
   configured token. Capture the launch fragment, decode it, and verify it
   represents 32 bytes.
3. Verify unauthenticated `/capabilities` returns 401 and the same request with
   the captured bearer returns 200.
4. Send an invalid empty body to strict `POST /workspace/memory` in a temporary
   trusted workspace. Against the generated-token daemon, verify the
   unauthenticated request is stopped by global bearer middleware with plain
   `401 {"error":"Unauthorized"}`, while the authenticated request reaches body
   validation and returns `invalid_scope` without changing workspace data.
   Record `token_required` separately against a plain token-less loopback
   baseline, where the strict mutation gate remains authoritative.
5. Load the real Web Shell in a browser, confirm the fragment is removed, hard
   refresh, and verify requests remain authenticated through `sessionStorage`.
6. Verify loopback `/health` remains unauthenticated for authenticated-open
   mode, then repeat with `--require-auth` and verify an unauthenticated probe
   returns 401.
7. Verify opted-in `--no-web` and missing Web Shell assets fail before listen.
   Verify a headless opted-in launch starts and prints the manual URL. Verify
   redundant `--open` and an accompanying `--no-open` do not disable the
   authenticated-open intent.
   Verify the corresponding invocations without the new flag retain existing
   behavior.
8. Verify a non-loopback opted-in launch fails before listen even when an
   explicit token is configured. Without the new flag, verify that the same
   explicit-token launch starts and a no-token non-loopback launch still
   refuses to start.
9. Verify a successful launch prints the non-secret breadcrumb announcing
   temporary authentication, and that neither it nor any other normal stdout
   or stderr line contains the generated value. Record that the fragment
   remains visible to the browser launcher process by design.
10. Verify `--open-with-auth --allow-origin '*'` starts with the
    generated bearer, leaves loopback `/health` pre-authentication, and returns
    401 for an unauthenticated protected request. Verify
    `--open-with-auth --local-control` keeps the LAN pairing credential
    separate from the primary runtime token.

## Acceptance and review

- Include evidence showing that bare `--open` preserves its existing daemon,
  API, and browser-launch behavior, while adding `--open-with-auth` changes
  unauthenticated `/capabilities` from 200 to 401 and keeps the automatically
  opened browser authenticated.
- State the local OS and runtime used. Mark macOS, Windows, and Linux explicitly
  as tested, not tested, or N/A in the PR template.
- Treat effective-open derivation and fast/yargs parity as the primary
  implementation risks. Put the opted-in local-client limitation, explicit
  shared-token alternative, and unaffected bare Chrome extension and
  daemon-backed channel flows in the PR body.
- Review the complete diff, including untracked files, for security boundaries,
  failure paths, fast-path import cost, test gaps, documentation drift,
  over-abstraction, and accidental expansion into #4514.
- Require two consecutive clean self-audit passes after all fixes and
  verification. Any change found during an audit resets the clean-pass count.
