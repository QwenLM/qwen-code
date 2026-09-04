# Standalone Stats Dashboard Implementation Plan

> Implement against `docs/design/2026-08-04-standalone-stats-dashboard.md`. Keep each task independently green. Do not replace the existing interactive `/stats` or daemon usage dashboard.

**Goal:** Ship `qwen stats` as a local OMP-style request-level observability dashboard, backed by an incremental SQLite index over Qwen transcripts and served as a dedicated SPA.

**Architecture:** A new `@qwen-code/stats` workspace owns transcript parsing, SQLite, queries, HTTP, and frontend assets. `packages/cli` owns only top-level command routing, output, browser launch, and lifecycle. The SQLite file is reconstructable cache; session JSONL remains authoritative.

**Tech stack:** Node 22, TypeScript, `node:sqlite`, React 19, Vite, Vitest, Playwright, yargs.

---

## Phase 1: Package and Contracts

### Task 1: Create the stats workspace and shared API contract

**Files:**

- Create: `packages/stats/package.json`
- Create: `packages/stats/tsconfig.json`
- Create: `packages/stats/tsconfig.client.json`
- Create: `packages/stats/vite.config.ts`
- Create: `packages/stats/src/index.ts`
- Create: `packages/stats/src/shared-types.ts`
- Create: `packages/stats/src/ranges.ts`
- Create: `packages/stats/src/ranges.test.ts`
- Modify: `package-lock.json`

**Steps:**

- [ ] Define `StatsRange = '24h' | '7d' | '30d' | '90d' | 'all'` and one parser that either returns explicit bounds or an invalid-range error.
- [ ] Define content-free public types for health, sync results, overview, request rows/details, model/tool/project/error/cost payloads, and time-series points.
- [ ] Define `StatsServerOptions`, `StatsServerHandle`, and the programmatic exports named in the design.
- [ ] Give the package independent `build`, `typecheck`, `lint`, and `test` scripts. The build must emit backend JS/types and Vite client assets.
- [ ] Add the workspace dependency to the lockfile through the normal npm workflow; do not hand-edit lockfile internals.

**Acceptance:**

- `npm -w packages/stats run typecheck` passes.
- `npm -w packages/stats test -- src/ranges.test.ts` proves every range boundary and rejects invalid input.
- Importing `@qwen-code/stats` has no CLI side effect and exports only the declared server/query contracts.

---

## Phase 2: Incremental Data Pipeline

### Task 2: Implement SQLite initialization and migration

**Files:**

- Create: `packages/stats/src/db.ts`
- Create: `packages/stats/src/db.test.ts`
- Create: `packages/stats/src/test-utils.ts`

**Steps:**

- [ ] Open `node:sqlite` lazily, create the parent directory, set `busy_timeout`, and enable WAL.
- [ ] Create the `files`, `requests`, and `tool_calls` tables and indexes from the design.
- [ ] Store the schema version in `PRAGMA user_version`; apply migrations inside one transaction.
- [ ] Expose a close function so tests, one-shot CLI modes, and process shutdown release the handle.
- [ ] Add prepared helpers for deleting all rows owned by one transcript and reading/updating its cursor metadata.

**Acceptance:**

- A fresh temporary database has the expected tables, unique constraints, and indexes.
- Reopening the database is idempotent.
- A simulated old schema migrates without dropping indexed rows not owned by the migration.
- Duplicate `(file_path, record_uuid)` inserts cannot create duplicate metrics.

### Task 3: Implement the lenient transcript parser

**Files:**

- Create: `packages/stats/src/parser.ts`
- Create: `packages/stats/src/parser.test.ts`
- Create: `packages/stats/src/__fixtures__/mixed-session.jsonl`

**Steps:**

- [ ] Parse only Qwen `system/ui_telemetry` records whose event name matches the public `EVENT_API_RESPONSE`, `EVENT_API_ERROR`, or `EVENT_TOOL_CALL` constant; add a narrow core leaf export only if these constants are not already importable without the core root barrel.
- [ ] Normalize request, error, and tool fields into the database row contracts; preserve `record.uuid` as the idempotency key.
- [ ] Use the telemetry timestamp with record timestamp fallback; normalize optional token/count/status fields without rejecting older records.
- [ ] Exclude prompt text, response text, tool arguments, tool results, API credentials, and MCP server names from parsed rows.
- [ ] Parse line-by-line from a byte offset, skip malformed complete lines, and stop before an incomplete trailing line so its bytes are retried later.

**Acceptance:**

- The mixed fixture produces the exact expected success, error, and tool rows.
- A malformed middle line does not prevent later valid lines from indexing.
- An incomplete final line does not advance the returned offset beyond the last newline.
- A test recursively inspects parsed row values/keys and proves fixture secrets and content fields are absent.

### Task 4: Implement transcript discovery and incremental sync

**Files:**

- Create: `packages/stats/src/sync.ts`
- Create: `packages/stats/src/sync.test.ts`

**Steps:**

- [ ] Resolve the runtime root from explicit options, `QWEN_RUNTIME_DIR`, `QWEN_HOME`, then `~/.qwen`.
- [ ] Discover transcript files under `<runtimeRoot>/projects/*/chats/*.jsonl` without following paths outside the runtime root.
- [ ] Derive project from each record's `cwd`, falling back to the encoded project directory; establish session id from the envelope/file context and skip only rows that still have none.
- [ ] For unchanged files, skip parsing; for append-only growth, parse from the saved offset.
- [ ] For truncation, replacement, or invalid offset, delete rows for that file and rebuild from byte zero in one transaction.
- [ ] Remove rows and cursor records for deleted transcripts.
- [ ] Coalesce concurrent sync calls and report files scanned, changed, rebuilt, deleted, rows inserted, and completion time.

**Acceptance:**

- Initial sync indexes fixture rows once.
- A second unchanged sync inserts zero rows.
- Appending one complete event inserts exactly one row.
- Appending half a line inserts zero; completing it inserts one.
- Truncating/replacing a file removes stale rows and introduces no duplicates.
- Deleting a file removes only rows owned by that file.
- Two simultaneous sync calls share one underlying scan.
- Symlink/path-escape fixtures outside the runtime root are not scanned.

---

## Phase 3: Query Layer

### Task 5: Implement aggregate queries and formulas

**Files:**

- Create: `packages/stats/src/queries.ts`
- Create: `packages/stats/src/queries.test.ts`

**Steps:**

- [ ] Implement overview totals, request/error/token time series, recent requests, and model share.
- [ ] Implement per-model requests/errors/tokens/cache/latency/TTFT/throughput.
- [ ] Implement per-tool calls/failures/duration/decisions/code-line impact.
- [ ] Implement per-project sessions/requests/tokens/errors/duration.
- [ ] Implement recent error rows and request detail with tool calls linked by response id, bounded to the same session.
- [ ] Implement the explicit unavailable-cost payload; do not report unknown price as zero.
- [ ] Include `generatedAt`, requested range bounds, and last successful sync time in aggregate payloads.

**Acceptance:**

- Fixture-backed tests prove all formulas from the design, including zero denominators and partial TTFT coverage.
- Range tests distinguish records immediately inside/outside each cutoff.
- Request detail cannot link a tool from another session that reused the same response id.
- Queries never read transcript files; they operate on SQLite only.

### Task 6: Add console summary and JSON serializers

**Files:**

- Create: `packages/stats/src/summary.ts`
- Create: `packages/stats/src/summary.test.ts`

**Steps:**

- [ ] Format one content-free human summary from the overview and cost payloads.
- [ ] Keep JSON output identical to the typed overview contract rather than inventing a second schema.
- [ ] Show cost as unavailable when pricing coverage is absent.
- [ ] Ensure `NO_COLOR` and non-TTY output do not contain ANSI sequences.

**Acceptance:**

- Snapshot/table tests cover empty, populated, error-heavy, and unknown-cost summaries.
- JSON output round-trips with `JSON.parse` and matches the query payload.

---

## Phase 4: HTTP Backend

### Task 7: Implement API routing and static asset serving

**Files:**

- Create: `packages/stats/src/server.ts`
- Create: `packages/stats/src/server.test.ts`
- Create: `packages/stats/src/assets.ts`

**Steps:**

- [ ] Build a Node HTTP server with `GET /api/health`, `POST /api/sync`, every query endpoint in the design, and `GET /api/requests/:id`.
- [ ] Return `400` for invalid ranges/limits, `404` for unknown requests, `405` for wrong methods, and structured `500` responses without stack traces.
- [ ] Return `501` for `/api/stats/behavior` and do not register a Behavior navigation item.
- [ ] Serve `index.html` and hashed assets with correct content types, cache immutable hashed assets, and use SPA fallback only for non-API GETs.
- [ ] Resolve assets through the repository's bundle-directory helper so source, package, split bundle, and standalone layouts work.
- [ ] Reject traversal and encoded traversal attempts.
- [ ] Schedule 30-second background sync after startup; stop timer, server, and database through one idempotent handle.

**Acceptance:**

- `port: 0` tests exercise health, overview, sync, request detail, invalid input, `/`, a hashed asset, SPA fallback, traversal rejection, and shutdown.
- Response headers do not add permissive CORS.
- Startup performs an initial sync before health reports ready.
- Occupied-port errors preserve the requested host/port and provide a `--port` recovery hint.

---

## Phase 5: Dedicated SPA

### Task 8: Build the app shell, routing, API client, and shared UI states

**Files:**

- Create: `packages/stats/index.html`
- Create: `packages/stats/src/client/index.tsx`
- Create: `packages/stats/src/client/App.tsx`
- Create: `packages/stats/src/client/api.ts`
- Create: `packages/stats/src/client/routes.ts`
- Create: `packages/stats/src/client/styles.css`
- Create: `packages/stats/src/client/components/*`
- Create: `packages/stats/src/client/App.test.tsx`

**Steps:**

- [ ] Implement hash routing for Overview, Requests, Errors, Models, Tools, Projects, and Costs.
- [ ] Keep `range` in the hash query, with `24h` default, and preserve it across routes/refresh.
- [ ] Implement a typed relative-URL API client with abort support and structured errors.
- [ ] Add shared loading skeleton, empty state, API error/retry, stale-sync notice, sync button/progress, light/dark/system theme, and responsive navigation.
- [ ] Poll lightweight aggregate data every 30 seconds while the page is active and perform a full data refresh after a successful manual sync.
- [ ] Use Qwen semantic tokens and product naming; do not clone OMP visual assets or copy its CSS.

**Acceptance:**

- Component tests prove direct hash navigation, range preservation, manual sync refresh, 30-second active-page polling cleanup, abort-on-route-change, empty state, and API error retry.
- No route or component imports backend-only modules such as `node:sqlite`, `node:fs`, or the server.

### Task 9: Implement Overview and Requests routes

**Files:**

- Create: `packages/stats/src/client/routes/OverviewRoute.tsx`
- Create: `packages/stats/src/client/routes/RequestsRoute.tsx`
- Create: `packages/stats/src/client/components/RequestDrawer.tsx`
- Create: `packages/stats/src/client/components/SvgTimeSeries.tsx`
- Create: `packages/stats/src/client/routes/OverviewRoute.test.tsx`
- Create: `packages/stats/src/client/routes/RequestsRoute.test.tsx`

**Steps:**

- [ ] Render requests, tokens, error rate, cache rate, latency, TTFT, and throughput headline metrics.
- [ ] Render request/error and token time series using accessible SVG/CSS rather than adding a chart dependency.
- [ ] Render model share and recent requests.
- [ ] Implement a paged/bounded requests table and content-free request drawer with linked tool calls.
- [ ] Distinguish unknown TTFT from zero TTFT.

**Acceptance:**

- Tests prove formulas are displayed with correct units/unknown states.
- Opening a request never renders prompt, response, arguments, or tool result content.
- Keyboard navigation can open and close the drawer.

### Task 10: Implement Errors, Models, Tools, Projects, and Costs routes

**Files:**

- Create: `packages/stats/src/client/routes/ErrorsRoute.tsx`
- Create: `packages/stats/src/client/routes/ModelsRoute.tsx`
- Create: `packages/stats/src/client/routes/ToolsRoute.tsx`
- Create: `packages/stats/src/client/routes/ProjectsRoute.tsx`
- Create: `packages/stats/src/client/routes/CostsRoute.tsx`
- Create: collocated route tests

**Steps:**

- [ ] Errors: recent failures, status/error type, model, project, duration, and timestamp.
- [ ] Models: sortable model metrics plus trend and cache/TTFT coverage.
- [ ] Tools: calls, failure rate, duration, decisions, and code-line impact.
- [ ] Projects: project path, distinct sessions, requests, tokens, error rate, and duration.
- [ ] Costs: explicit unavailable state and future-compatible priced coverage layout.
- [ ] Keep tables responsive and provide accessible text alternatives for visual bars/sparklines.

**Acceptance:**

- Each route has populated, empty, and API-error tests.
- Sorting is deterministic and does not mutate API payloads.
- Costs never display `$0.00` for unpriced usage.

---

## Phase 6: CLI Integration

### Task 11: Add the `qwen stats` bootstrap command

**Files:**

- Create: `packages/cli/src/commands/stats.ts`
- Create: `packages/cli/src/commands/stats.test.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/cli.test.ts`
- Modify: `packages/cli/src/config/config.ts`
- Modify: `packages/cli/package.json`

**Steps:**

- [ ] Register top-level help text and bootstrap route `stats` so the command never imports `gemini.ts` or starts model/auth/MCP configuration.
- [ ] Parse `--host`, `--port`, `--open/--no-open`, `--summary`, `--json`, `--range`, `--runtime-dir`, and `--db`.
- [ ] Reject incompatible `--summary` + `--json`; validate port and range before disk work.
- [ ] For one-shot modes: sync, query, print, close database, and exit.
- [ ] For dashboard mode: initial sync, start server, print URL, and best-effort open the browser through `openBrowserSecurely` only when `shouldLaunchBrowser()` permits.
- [ ] Convert wildcard bind hosts to a loopback browser URL without changing the listener.
- [ ] On `SIGINT`/`SIGTERM`, stop the server/database once and preserve a clean exit.
- [ ] Warn on non-loopback binds about aggregate project/error exposure.
- [ ] Keep dashboard startup ownership unambiguous: exactly one layer performs the initial sync and owns the database/server handle; tests assert the CLI path does not index each transcript twice.

**Acceptance:**

- Bootstrap tests prove `qwen stats --help` and `qwen stats --json` stay off the default interactive import path.
- Command tests prove defaults, validation, browser gating, wildcard URL rewrite, one-shot cleanup, signal cleanup, and occupied-port messaging.
- Top-level help/config registration alignment test includes `statsCommand`.

### Task 12: Add CLI smoke coverage

**Files:**

- Create: `integration-tests/cli/stats-dashboard.test.ts`
- Create: `integration-tests/fixtures/stats-runtime/*`

**Steps:**

- [ ] Spawn the built CLI against an isolated `QWEN_HOME` fixture.
- [ ] Verify `qwen stats --json --range 24h` returns expected parseable totals and exits zero.
- [ ] Verify `qwen stats --summary` returns expected text without model setup.
- [ ] Spawn `qwen stats --no-open --port 0`, discover its printed URL, request health/overview/root, then terminate it.
- [ ] Verify malformed session input does not crash startup.
- [ ] Verify default startup binds loopback, and a non-loopback smoke path emits the exposure warning without enabling CORS.

**Acceptance:**

- The smoke test exercises the actual built entry, not the server module directly.
- No test requires an API key or network model call.

---

## Phase 7: Build, Package, and Release Layout

### Task 13: Build and bundle stats assets

**Files:**

- Modify: `scripts/build.js`
- Modify: `scripts/copy_bundle_assets.js`
- Modify: `scripts/prepare-package.js`
- Modify: `scripts/create-standalone-package.js`
- Modify: `scripts/tests/package-assets.test.js`
- Modify: `scripts/tests/clean-package-build-artifacts.test.js` if its workspace fixture needs the new package

**Steps:**

- [ ] Build `packages/stats` after core and before CLI in both full and `--cli-only` builds because `qwen stats` is a CLI runtime feature.
- [ ] Copy the built stats SPA to `dist/stats/` during bundle asset staging.
- [ ] Require `dist/stats/index.html` and its assets during npm release packaging.
- [ ] Add `stats` to published package files and standalone allowed/required runtime assets.
- [ ] Extend package asset fixtures and scanner coverage for the new directory.

**Acceptance:**

- Script tests prove assets are copied, stale assets are removed, missing release assets fail packaging, and standalone archives include them.
- `npm run build -- --cli-only && DEV=true npm run bundle` emits `dist/stats/index.html` plus hashed assets.
- Running bundled `node dist/cli.js stats --no-open --port 0` serves the bundled SPA.

---

## Phase 8: Browser Verification and Cleanup

### Task 14: Add browser smoke and visual coverage

**Files:**

- Create: `packages/stats/playwright.config.ts`
- Create: `packages/stats/e2e/dashboard.spec.ts`
- Create: `packages/stats/e2e/visuals.spec.ts`
- Modify: `packages/stats/package.json`

**Steps:**

- [ ] Start the real stats backend with deterministic fixture data from Playwright webServer setup.
- [ ] Smoke Overview, every route, range switching, request drawer, manual sync, direct hash reload, and responsive navigation.
- [ ] Exercise empty and server-error fixtures.
- [ ] Capture desktop light, desktop dark, and narrow viewport screenshots for Overview, Models, Tools, and Costs-unavailable.
- [ ] Assert no browser console errors or failed API requests.

**Acceptance:**

- `npm -w packages/stats run test:e2e:smoke` passes against built assets.
- Visual artifacts clearly show populated/empty/unavailable states in both themes.

### Task 15: Final verification and self-audit

**Files:**

- Modify only files required by findings from verification.

**Steps:**

- [ ] Run focused unit tests after each fix.
- [ ] Run package lint/typecheck/tests for `core` only if a core leaf export changed, plus `stats` and `cli` focused tests.
- [ ] Run root `npm run build && npm run typecheck`.
- [ ] Run the CLI integration smoke and stats Playwright smoke.
- [ ] Run `npm run test:scripts` for packaging/build script coverage.
- [ ] Inspect the full diff and new files once, then re-run the checks affected by any finding.
- [ ] Confirm existing interactive `/stats`, `qwen serve`, and Daemon Status usage tests still pass unchanged.

**Acceptance:**

- Every verification item in the design document has direct evidence.
- No compatibility shim, duplicated data authority, transcript mutation, content indexing, or unknown-cost-as-zero behavior remains.
- The deliverable works from source, package build, root bundle, and standalone layout.
