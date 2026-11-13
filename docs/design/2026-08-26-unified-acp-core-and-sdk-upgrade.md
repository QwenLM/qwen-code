# Unified ACP Core — One Agent Surface, Many Transports (+ ACP SDK 1.x)

> Branch: `refactor/unified-acp-and-upgrade-acp-sdk`. Author: chiga0.
> Date: 2026-08-26. Status: **Design v1 — review**.
> Tracks: [#10061](https://github.com/QwenLM/qwen-code/issues/10061) (proposal),
> [#4063](https://github.com/QwenLM/qwen-code/issues/4063) (architecture umbrella).
> Design-first per repo workflow: this doc lands before any implementation PR.
> Per the two-tier gate this is a **maintainer-initiated** program; no external PRs.

---

## 0. TL;DR

Qwen Code exposes ACP over two paths that were built at different times with
different assumptions:

1. **stdio** (`qwen --acp`) — in-process agent behind the SDK's
   `AgentSideConnection` (`packages/cli/src/acp-integration/`).
2. **HTTP** (`qwen serve`) — a hand-written ACP JSON-RPC dispatcher over
   RFD#721 Streamable HTTP (`packages/cli/src/serve/acp-http/`), bridging to
   per-workspace `qwen --acp` child processes.

The agent business logic exists once, but the **protocol surface exists twice**
and has drifted: two vendor-extension namespaces (`qwen/status|control/*` vs.
`_qwen/*`), divergent capabilities (HTTP lacks `terminal/*`; permissions/fs are
daemon-proxied), and ~4k lines of duplicated JSON-RPC routing — all while the
upstream SDK has moved 15+ releases ahead (`0.14.1` → `1.4.0`) and now **ships
its own Streamable HTTP/WebSocket transports** (0.27.0).

**Proposal**: extract one transport-agnostic **ACP core** (session/agent logic +
single capability-and-vendor-method registry), reduce both transports to thin
adapters — stdio via SDK `AgentSideConnection`, HTTP via the SDK's official
Streamable HTTP transport — and upgrade `@agentclientprotocol/sdk` to 1.4.x as
Phase 0. Daemon mediation semantics that are intentional products (permission
voting, fs guards, multi-client broadcast) become **explicit interceptors**, not
transport side-effects.

**Estimated shape**: Phase 0 SDK upgrade (~15 PR-sized slices, mechanical);
Phase 1 registry + namespace convergence; Phase 2 HTTP transport swap
(net-negative ~4–6k lines in `serve/acp-http/`); Phase 3 conformance suite.
Overall target: delete more code than we add.

---

## 1. Background

### 1.1 The two paths today

```
                         ┌──────────────── qwen (one repo) ────────────────────────┐
                         │                                                         │
  Local IDE  ──stdio──►  │ acp-integration/      SDK AgentSideConnection           │
  (Zed, VSCode)          │  └─ acpAgent.ts 12.5k ─ QwenAgent implements ALL        │
                         │     session/*, authenticate, unstable_*,                │
                         │     qwen/status/* (23), qwen/control/* (35)             │
                         │                                                         │
  Remote/web ──HTTP───►  │ serve/acp-http/       bespoke dispatcher 5.6k           │
  clients                │  └─ dispatch.ts + sse/ws framing + registry             │
                         │     ~60 _qwen/* methods  ──┐                            │
                         │                            │ spawn per workspace        │
                         │  acp-bridge/ (12.8k)  ◄────┘ qwen --acp child ──────────┼─► (same code as left)
                         └─────────────────────────────────────────────────────────┘
```

### 1.2 Where the drift actually lives

The _agent logic_ (`acp-integration`) is genuinely shared — the daemon reuses it
by spawning it. The duplication is one layer up:

| Layer               | stdio                                                                  | HTTP                                                                                        | Drift                                               |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Protocol routing    | SDK `AgentSideConnection`                                              | hand-written `dispatch.ts` (~5.6k) + sse/ws framing (~2k)                                   | two implementations of the same JSON-RPC semantics  |
| Vendor extensions   | `qwen/status/*` + `qwen/control/*` (~58)                               | `_qwen/*` (~60)                                                                             | two namespaces, partial overlap, no shared registry |
| Session extras      | `unstable_resumeSession/listSessions/setSessionModel` (SDK 0.14 names) | first-class `resume/list/fork/set_model/set_config_option`                                  | different method names for the same operations      |
| Client capabilities | `fs` + `terminal` via client callbacks                                 | `fs` only; **no `terminal/*`**; permissions answered by daemon vote; fs proxied by daemon   | HTTP clients observe a reduced agent surface        |
| Failures            | —                                                                      | child-process fan-out domain (e.g. #8871 "Unknown argument: acp")                           | HTTP-only fragility                                 |

### 1.3 Why now instead of later

- **The SDK caught up.** `@agentclientprotocol/sdk` 0.27.0 shipped experimental
  Streamable HTTP & WebSocket transports; 1.2.x linearized ndjson receive and
  unified JSON-RPC validation across transports. Our bespoke transport was
  written against RFD#721 when no SDK support existed — that reason is gone.
- **The unstable era ended.** `listSessions` (0.16), `resumeSession` +
  `closeSession` (0.20), `logout` (0.23), `deleteSession` (0.25), elicitation
  (1.4) all stabilized; unstable model selectors were **removed** (0.24). Every
  `unstable_*` in `acpAgent.ts` now has a final name. Waiting means maintaining
  the old names forever.
- **0.27.0 was a full SDK rewrite** with a migration guide
  (`MIGRATION_0.26_0.27.md`) and deprecated-but-working legacy interfaces — the
  upgrade path was designed by upstream to be traversable. It will not get
  easier past 1.4.
- **Known landmine**: `acp-bridge/src/spawnChannel.ts` deep-imports
  `@agentclientprotocol/sdk/dist/schema/zod.gen.js`, a non-public path that any
  SDK bump can break. It must go regardless.

### 1.4 Prior art in this repo

- [`docs/design/daemon-acp-http/`](./daemon-acp-http/README.md) created the
  HTTP transport and chose `_qwen/*` (single underscore = spec-reserved
  extension form). **This design adopts `_qwen/*` as the surviving namespace**;
  stdio's `qwen/status|control` style becomes a deprecated alias.
- [`docs/design/daemon-transport-abstraction/`](./daemon-transport-abstraction/README.md)
  already abstracts the **client side** (`DaemonClient` + `DaemonTransport` over
  REST/SSE vs ACP-HTTP vs ACP-WS). This design is server-side; the two compose —
  namespace convergence here makes the client-side ACP mapping table shrink.
- #8084 established `packages/cli/src/runtime/` as the neutral,
  lifecycle-free layer acp-integration may consume. Today it holds **no ACP
  modules** — it is the natural home for the new core.

---

## 2. Goals / Non-goals

**Goals**

1. One **capability surface**: identical `initialize` capabilities, session
   method set, and vendor-extension namespace across stdio and HTTP.
2. One **ACPCore** module (transport-agnostic): session/agent logic, capability
   declaration, vendor-method registry.
3. Transports become thin: stdio = SDK `AgentSideConnection`; HTTP = SDK
   Streamable HTTP transport + explicit daemon interceptors.
4. `@agentclientprotocol/sdk` `0.14.1 → 1.4.x` in all four consumers
   (`cli`, `acp-bridge`, `channels/base`, `vscode-ide-companion`).
5. Mechanical guarantee: a **conformance test suite** that runs the same
   protocol contract against both transports in CI.
6. Net code deletion.

**Non-goals**

- Removing the REST/SSE surface (`serve/routes/session.ts`) or the client-side
  `DaemonTransport` — out of scope; composed, not replaced.
- Changing workspace isolation topology (process-per-workspace child agents
  stay; see §4.4 decision).
- Multi-workspace ACP routing redesign beyond what the transport swap needs.
- Migrating `_qwen/*` HTTP consumers (webui/SDK REST users) — only ACP wire.

---

## 3. Target architecture

```
┌──────────────────────────── thin transport adapters ─────────────────────────┐
│                                                                              │
│   stdio adapter                    HTTP adapter (serve/acp-http/)            │
│   ─ AgentSideConnection            ─ SDK StreamableHTTP transport            │
│   ─ SDK ndJsonStream               ─ SDK ws transport (opt)                  │
│   ─ argv wiring (today's cli.ts)   ─ auth / rate-limit / multi-ws mount      │
│                                    ─ daemon interceptors only:               │
│                                      permission vote, fs guard,              │
│                                      broadcast, workspace registry           │
└───────────────────────────────────────────────▲──────────────────────────────┘
                                                │ one interface
┌──────────────────────────── ACPCore (packages/cli/src/runtime/acp/) ─────────┐
│  CapabilityRegistry   single source of truth: every method, params/result,   │
│                       transport availability, daemon-mediation flag          │
│  VendorMethodRegistry `_qwen/*` only; `qwen/*` legacy aliases (deprecated)   │
│  SessionAgent         today's QwenAgent/Session logic, minus transport code  │
│  Interceptor hooks    well-typed points for daemon mediation                 │
└───────────────────────────────────────────────▲──────────────────────────────┘
                                                │
                                     core/ Config, tools, session services
```

Registry entry shape (illustrative):

```typescript
interface AcpMethodContract {
  method: string; // 'session/prompt' | '_qwen/workspace/mcp/add' | ...
  mode: 'standard' | 'unstable' | 'vendor';
  transports: ('stdio' | 'http')[];
  mediation?: 'permission-vote' | 'fs-guard' | 'broadcast' | null;
  deprecatedAlias?: string; // e.g. legacy 'qwen/status/session/context'
}
```

`initialize` capabilities are **generated from the registry + active transport +
active interceptors**, never hand-written per path. Conformance tests iterate
the registry — adding a method without a contract entry fails CI.

---

## 4. Detailed design

### 4.1 Phase 0 — SDK 0.14.1 → 1.4.x (first, alone)

Rationale for ordering: the unified core will be written against the **new**
SDK API (post-0.27 rewrite). Doing the core first would double-write the
adapter layer. The rewrite kept legacy interfaces working (deprecated), so we
can reach 1.4.x behaviorally unchanged, then build the core on modern APIs.

Known surfaces (verified against upstream CHANGELOG 0.14.0 → 1.4.0):

| Change                                                                                                                                      | Our exposure                                                                                                   | Action                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 0.27.0 full SDK rewrite; legacy interfaces deprecated                                                                                       | `AgentSideConnection` used in `acpAgent.ts`, `ClientSideConnection` in `bridge.ts`; `ndJsonStream` in 3 places | follow `MIGRATION_0.26_0.27.md`; adapt once behind thin wrappers                  |
| `unstable_*` promotions: listSessions 0.16, resume/close 0.20, logout 0.23, additionalDirectories 0.24, deleteSession 0.25, elicitation 1.4 | `acpAgent.ts:5043/5258` implement old unstable names                                                           | rename to final names; keep old names as aliases for one minor where wire-visible |
| unstable model selectors **removed** 0.24                                                                                                   | `unstable_setSessionModel` (`acpAgent.ts:5315`)                                                                | replace with stable config-option mechanism                                       |
| Schema bumps (0.11 → 1.20 + v2 alpha)                                                                                                       | zod types imported across ~57 prod files                                                                       | type-level mostly; run `tsc` per step                                             |
| **Deep import** `dist/schema/zod.gen.js` in `spawnChannel.ts`                                                                               | breaks on any repackaging                                                                                      | replace with public API first — this is Phase 0 PR #1                             |
| 0.27+ official Streamable HTTP / WS transports                                                                                              | we maintain bespoke equivalents                                                                                | Phase 2 adopts them                                                               |
| 1.2.x unified JSON-RPC validation across transports                                                                                         | our `acp-bridge/ndJsonStream` copy + `channels/base` import                                                    | converge on SDK's stream                                                          |

Sequencing inside Phase 0: land **0.27.0 first** (largest single delta, has a
migration guide), then step to 1.4.x. Never pin intermediate versions in
`main`; intermediate steps live on stacked PRs.

### 4.2 Phase 1 — Capability & vendor-method registry (the "one surface")

- Create `packages/cli/src/runtime/acp/` (neutral per #8084 pattern:
  lifecycle-free, importable by both `acp-integration/` and `serve/`).
- Move method **declarations** (name, schema, transport availability, mediation
  flag, deprecated alias) out of `acpAgent.ts` + `dispatch.ts` into the
  registry. Implementations stay where domain logic lives; the registry points
  at them.
- Namespace convergence: canonical = **`_qwen/*`** (spec-reserved form, already
  the HTTP choice). Stdio's `qwen/status/*` + `qwen/control/*` become alias
  entries with `deprecatedAlias` + `deprecationNotice` in initialize output;
  removal no earlier than two minor releases after aliasing ships.
- Method-name parity: HTTP's first-class `resume/list/fork/set_model/
set_config_option` and stdio's vendor ops are unified into registry entries
  with `transports: ['stdio','http']` wherever semantics allow; genuinely
  transport-bound methods (e.g. HTTP-only multi-client broadcast control)
  declare `transports: ['http']` explicitly — divergence becomes _declared_,
  not accidental.

### 4.3 Phase 2 — HTTP transport swap (the big deletion)

Replace the hand-written wire with the official SDK transport:

- Delete/retire: `acp-http/` json-rpc framing, sse-stream, ws-stream,
  connection-registry transport parts (target: most of ~7.5k lines of framing +
  routing mechanics).
- Keep, reshaped as thin front-door: bearer/CSRF auth, rate limiting,
  multi-workspace mounting (`/workspaces/:ws/acp`), pre-attach budgets.
- `dispatch.ts` (5.6k) is rebuilt as: registry-driven method table +
  **interceptor chain** for daemon-mediated methods. Daemon semantics survive
  as explicit code, not implicit dispatcher behavior:
  - `permission-vote`: `session/request_permission` → daemon vote orchestrator
    (REST `/permission/:id` + first-responder-wins), response relayed.
  - `fs-guard`: `fs/read|write_text_file` → existing
    `serve/bridge-file-system-adapter` (TOCTOU/symlink/trust gates stay).
  - `broadcast`: `session/update` fan-out to all attached clients of a session
    (multi-attach is a daemon feature stdio lacks — declared via registry).
- Child-per-workspace topology is **kept** (isolation contract from
  `daemon-multi-workspace-hardening`); the HTTP adapter talks to the bridge,
  which talks to children over the (now upgraded) SDK connection. An
  in-process alternative was considered and rejected — see §7.

### 4.4 stdio adapter

- `acp-integration/acpAgent.ts` keeps domain behavior; its protocol wiring
  moves behind the registry. Target: `acpAgent.ts` shrinks from 12.5k to
  orchestration + Session delegation; transport handling is SDK + registry
  lookups.
- VSCode companion spawns `--acp` directly (`acpConnection.ts`) — zero
  interface change expected since wire behavior is preserved with aliases.

### 4.5 SDK surface hygiene

- Single import path: everything from `@agentclientprotocol/sdk` public
  exports; deep path usage lint-blocked.
- `channels/base/AcpBridge.ts` converges onto `acp-bridge`'s spawnChannel
  (eliminates the third stdio client implementation and its direct SDK
  `ndJsonStream` import).

---

## 5. Phase plan & acceptance criteria

| Phase | Content                                                                                      | PR shape        | Acceptance                                                               |
| ----- | -------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| 0a    | Remove `zod.gen.js` deep import; thin wrapper layer around SDK connection/stream             | 1–2 PRs         | SDK bump nothing; tests green                                            |
| 0b    | Upgrade to 0.27.0 across 4 packages per `MIGRATION_0.26_0.27.md`                             | 2–4 PRs stacked | all existing ACP E2E green on both transports                            |
| 0c    | Step to 1.4.x; rename `unstable_*` handlers to stable names w/ aliases                       | 1–3 PRs         | wire-compat tests pass                                                   |
| 1     | `runtime/acp/` registry; namespace convergence + aliases; initialize generated from registry | 2–3 PRs         | registry-driven capability diff test stdio vs HTTP = only declared diffs |
| 2     | HTTP transport swap to SDK StreamableHTTP; dispatcher → interceptors                         | 3–5 PRs         | acp-http/ net ≥4k lines deleted; `_qwen/*` clients unaffected (aliases)  |
| 3     | ACP **conformance suite**: protocol contract × {stdio, HTTP} in CI                           | 1–2 PRs         | adding a method without registry entry fails CI                          |
| 4     | channels/base convergence; vscode-companion audit; docs                                      | 1–2 PRs         | third ACP client impl deleted                                            |

Rollback posture: each phase independently shippable; aliases keep external
clients working through Phase 2.

---

## 6. Breaking-change audit

| Surface                              | Change                                                                                 | Breaking?            | Mitigation                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| stdio `qwen/status                   | control/*`                                                                             | aliased to `_qwen/*` | soft                                                                           | alias ≥ 2 minors + `initialize` deprecation notice |
| HTTP `_qwen/*`                       | survives as canonical                                                                  | no                   | —                                                                              |
| `session/request_permission` on HTTP | same wire, different answerer (vote orchestrator) — already true today                 | no                   | behavior preserved by interceptor                                              |
| `initialize.protocolVersion`         | advances with SDK 1.x schema                                                           | yes (intended)       | ACP clients negotiate; Zed/VSCode tested in E2E                                |
| `unstable_*` method names            | replaced by stable names                                                               | soft                 | old names aliased one minor                                                    |
| vscode-ide-companion                 | spawns `--acp`; wire + aliases preserved                                               | no                   | regression in Phase 4 audit                                                    |
| Public HTTP ACP consumers            | identical endpoint, official SDK framing may differ in edge semantics (SSE retry, ids) | possible             | parity tests against the bespoke transport before swap; release-notes call-out |

---

## 7. Alternatives considered

**A. In-process agents in the daemon (kill the child-per-workspace).**
Eliminates the 12.8k bridge entirely. **Rejected for this program**: the
process boundary encodes workspace isolation + crash containment + memory
pressure handling (daemon-memory-pressure, heap probes). Replacing it is a
separate, larger redesign of the runtime ownership contract. We keep southbound
spawning; southbound already speaks SDK ACP, so it rides the Phase 0 upgrade
for free. Revisit after Phase 3 with conformance data.

**B. Keep bespoke HTTP transport, only unify namespaces.**
Cheap, but leaves ~5.6k lines of hand-maintained wire machinery duplicating
what the SDK now ships, and every future RFD lands twice. **Rejected** as the
end state; acceptable as a mid-state during phased rollout.

**C. Deprecate `_qwen/*`, adopt stdio's `qwen/*` instead.**
Inverts the spec-correct direction (single-underscore is the ACP-reserved
extension form, chosen deliberately in `daemon-acp-http`). **Rejected.**

**D. Build the core first, upgrade SDK later.**
Writes adapters twice (old then new SDK shape). **Rejected**; Phase 0 first.

---

## 8. Verification

1. **Wire parity suite** (Phase 3, runs from Phase 1): same scripted client
   drives initialize → session/new → prompt w/ tool calls → permission → fs
   read/write → cancel → resume across both transports; records and diffs
   notification sequences.
2. **Existing E2E must stay green**: `cli/acp-integration.test.ts`,
   serve acp-http smoke (`scripts/acp-http-smoke.mjs`) — updated to official
   transport.
3. **Client reality checks**: Zed + VSCode companion + webui daemon mode
   against both transports each phase.
4. **Registry lint**: CI check that every handled JSON-RPC method has a
   registry entry; capability diff stdio-vs-HTTP must equal the declared set.
5. **Memory/perf guardrails**: daemon memory-pressure suite; acp-http
   pre-attach budgets unchanged; no new per-frame allocations in hot path
   (reuse existing large-pipe-frame-observer).

---

## 9. Risks

| Risk                                                                           | Mitigation                                                                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 0.27 rewrite migration underestimated                                          | Phase 0 isolated on stacked PRs; legacy interfaces deprecated-not-removed gives a working fallback per step |
| Official SDK transport semantics differ subtly from our RFD#721 implementation | parity suite before swap; keep bespoke behind env flag for one release (`QWEN_SERVE_ACP_HTTP_LEGACY=1`)     |
| `_qwen/*` → alias churn breaks external HTTP clients                           | canonical name unchanged (`_qwen/*` survives); only stdio adds aliases                                      |
| Registry becomes a second source of drift                                      | registry is _the_ source; initialize/capabilities generated from it; CI fails on unregistered handlers      |
| Two-tier gate optics: huge program                                             | each phase maintainer-PR'd; no external PRs touching core during migration                                  |
| vscode-companion quietly depends on `qwen/*` names                             | Phase 4 explicit audit + E2E before alias removal is even scheduled                                         |

---

## 10. Open questions

1. Daemon southbound after Phase 2: keep per-workspace **children**, or offer
   single-workspace `--serve --in-process` mode for lightweight deployments?
   (Deferred to post-Phase-3 data; default = keep children.)
2. Should the new core live in `packages/cli/src/runtime/acp/` (neutral, per
   #8084) or graduate to `packages/acp-core` so `acp-bridge`/`channels` can
   depend on it without reaching into `cli`? Lean: start in `runtime/acp/`,
   extract to a package only when a second package needs it (YAGNI; extraction
   is mechanical).
3. WS transport in serve: adopt SDK's WS as Phase 2 stretch, or stay
   SSE-only? Lean: SSE-only to match current surface; WS stays client-side
   (`DaemonTransport`'s domain).
4. Do terminal capabilities come to HTTP (needs daemon-side terminal broker),
   or does HTTP stay terminal-less **by declaration**? Lean: declare
   terminal-less in v1 of unification; track separately.
