# Design — add-bridge-protocol

## Context

`add-remote-control` defined scopes (owner / write / approve / read)
for paired clients owned by the operator. Bridges are different:
they represent N external humans acting through a chat service.
Treating a bridge as just another paired client misses three things:

1. **Audit by actual human, not by bot token.** "approved by
   `tkn_abc123`" tells me which bridge approved; "approved by
   telegram:evan via Telegram-bridge" tells me who actually pressed
   the button.
2. **Per-user rate limiting.** One Discord troll should not be able
   to drain the daemon's per-session FIFO by spamming the bot.
3. **Capability discovery.** Different chat services have different
   capabilities (inline buttons, markdown, message size limits). The
   daemon needs to know what hints to put on outgoing events so the
   bridge can render appropriately.

This change adds a `bridge` scope, `subActor` identity, bridge
registration, per-sub-actor rate limits, and capability hints — all
the minimum primitives needed for a third party to write a sane
bridge against a stable contract.

## Goals / Non-Goals

**Goals:**

- A bridge is a regular HTTP+SSE client of the daemon. No special
  RPC channel.
- The audit log records the actual human behind every bridge-mediated
  action.
- The daemon protects itself from misbehaving bridges or sub-actors
  via rate limits and sub-actor bans.
- Bridge implementations are isolated from each other and from the
  daemon — a Telegram bridge crash doesn't affect Discord bridge or
  the daemon.

**Non-Goals:**

- A universal bridge framework. Each bridge is its own process and
  can be in any language as long as it speaks HTTP+SSE.
- Cross-bridge identity linking. `telegram:evan` and `discord:evan`
  are different sub-actors. Operator decides if they want to
  manually map them.
- E2E encryption between chat-service users and the agent. Bridges
  see plaintext by definition.
- Live message editing between the daemon and chat services. Bridges
  may choose to edit messages locally for UX but the daemon emits
  the same events to all clients.

## Architecture

```
   Daemon (no bridge code in core)
   │
   ├── existing routes: /session, /permission, /rc/pair, etc.
   │
   └── new routes for bridges:
       POST   /rc/bridges                 — register / heartbeat
       GET    /rc/bridges                 — list registered bridges (owner)
       PATCH  /rc/bridges/:id             — update capability advertisement
       DELETE /rc/bridges/:id             — deregister (owner or self)
       POST   /rc/bridges/:id/ban         — ban a sub-actor
       DELETE /rc/bridges/:id/ban/:subId  — lift a ban

   Bridge sidecar (separate process, language-agnostic)
   ├── holds qwk_* token with `bridge` scope
   ├── subscribes to /session/:id/events
   ├── translates daemon events ↔ chat-service messages
   │     - permission_request → inline-keyboard message
   │     - session_update → streamed chat message
   │     - audit_event → silent log
   ├── on incoming chat message:
   │     - POST /session/:id/prompt with X-RC-SubActor: <chat-svc>:<user-id>
   ├── on inline-button tap:
   │     - POST /permission/:id with X-RC-SubActor and vote
   └── enforces local cache of bans, rate limits
```

## Bridge identity

Bridges are paired like any other client (via `add-remote-control`
pairing flow) but request `scope: bridge`. The pairing code mint
endpoint accepts this scope only from owner-scope callers and
records the intent.

A registered bridge has:

```jsonc
{
  "id": "br_xxxx",          // assigned at registration
  "tokenId": "tkn_yyyy",    // its qwk_* token id
  "displayName": "Telegram-bridge",
  "bridgeKind": "telegram", // free-form taxonomy: telegram, discord, matrix, ...
  "capabilities": {
    "supportsActions": true,    // inline buttons
    "supportsMarkdown": "limited" | "full" | "none",
    "maxMessageBytes": 4096,
    "supportsThreads": true,
    "supportsEdits": true
  },
  "registeredAt": "<ISO>",
  "lastHeartbeatAt": "<ISO>"
}
```

Capabilities are the bridge's self-declaration; the daemon trusts
them but uses them only as hints, never for security decisions.

## Sub-actor identity

`X-RC-SubActor` is a header the bridge sets on every request acting
on behalf of an external user. Its value is the stable identifier
the chat service exposes, namespaced by the bridge kind:

- Telegram: `telegram:<numeric user id>` (NOT username — usernames
  can change; numeric ids are stable)
- Discord: `discord:<user-snowflake-id>`
- Matrix: `matrix:@user:homeserver`
- Slack: `slack:<workspace>:<user-id>`

A bridge MAY omit `X-RC-SubActor` when acting on its own behalf
(e.g., a registration heartbeat). Routes that allow this are
documented; others reject the request.

The sub-actor field is recorded in audit and surfaced in SSE
`audit_event` and `permission_resolved` frames so workstation
clients see who acted.

## Permission request hints

When emitting `permission_request`, the daemon attaches a
`bridgeHints` block:

```jsonc
{
  "argsSummaryShort": "Edit src/auth/login.ts (+12 -3)", // ≤140 chars
  "argsSummaryFull":  "<full args canonicalized>",      // for bridges with capacity
  "sensitivity":      "low" | "medium" | "high",         // best-effort heuristic
  "recommendedSurface": "inline" | "deeplink"            // suggestion for the bridge
}
```

`sensitivity` is computed by simple heuristics: tool name in a
denylist of "sensitive" tools (e.g., `bash` with payment-related
patterns) → high; otherwise medium for `edit_file` / `shell`; low
for read-only tools. The hint is advisory; bridges are free to
ignore and ask for full rendering. A future
`add-policy-engine`-driven sensitivity classifier can replace the
heuristic without changing the wire format.

## Per-sub-actor rate limit

To stop a runaway sub-actor from saturating a session's FIFO:

- Per `(bridgeId, subActor)` pair, the daemon maintains a token
  bucket: default `capacity: 5, refillRate: 1 per 10s` for
  write-equivalent operations (prompt, vote).
- Configurable per-bridge via `PATCH /rc/bridges/:id`
  (`subActorRateLimit: { capacity, refillSec }`); upper bound
  enforced (`capacity ≤ 20`, `refillSec ≥ 2`).
- When exceeded, the daemon returns `429 Too Many Requests` with
  `Retry-After`. Audit entry recorded.
- The bridge SHOULD echo this back to the sub-actor with an
  appropriate chat-service message ("Slow down, try again in 10s").

## Sub-actor ban

`POST /rc/bridges/:id/ban { subActor, reason }` records a permanent
ban (until explicitly lifted). The daemon REJECTS any request
arriving with `X-RC-SubActor: <banned>` from that bridge with
`403 Forbidden` and code `sub_actor_banned`. The bridge ALSO receives
a `sub_actor_banned` SSE event so it can pre-emptively filter
messages on the chat-service side without bothering the daemon.

Bans are bridge-scoped. Banning `telegram:trolly` does not affect
`discord:trolly`.

## Threat model

| Attacker                                      | Capability                                  | Mitigation                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge process compromise                     | Use bridge token to vote / prompt           | Bridge token is `bridge` scope only — cannot mint other tokens, cannot read audit, cannot revoke. Owner revokes the token; bridge is offline; threat ends.                                                                                                                                                |
| Bridge spoofs sub-actor identity              | "Approved by ceo" when really a random user | Sub-actor is bridge-asserted; the daemon CANNOT verify. Threat model: a compromised bridge can lie. Mitigation = revoke the bridge promptly; audit captures both the bridge tokenId AND the asserted subActor so post-incident analysis distinguishes "bridge compromised" vs "user account compromised." |
| Misbehaving bridge fans out events            | Floods chat service with sensitive content  | `bridgeHints.sensitivity: high` + `recommendedSurface: deeplink` advises bridges; bridges that ignore it are operator-removed.                                                                                                                                                                            |
| External user spams prompts                   | DOS via prompt queue                        | Per-sub-actor token bucket; per-bridge token bucket; FIFO discipline.                                                                                                                                                                                                                                     |
| Sub-actor impersonation across bridges        | telegram:alice claims to be discord:alice   | No cross-bridge identity linking; each sub-actor is namespaced.                                                                                                                                                                                                                                           |
| Bridge stays online indefinitely after revoke | Token revoked but bridge keeps cached SSE   | Stage 1's `client_evicted` semantics close the SSE within 1 s; subsequent fetches 401.                                                                                                                                                                                                                    |
| Operator unaware of stale bridges             | Long-dead bridge still listed               | Heartbeat-or-GC: bridges that miss 3 consecutive heartbeats (60s each) are auto-deregistered, audit `bridge_stale_deregistered` written.                                                                                                                                                                  |

## Decisions

### D1 — New scope `bridge`, not a flag on existing scopes

**Choice**: A distinct `bridge` scope. Implies `write + approve +
read`. Adds the ability to assert `subActor`. Does not imply
`owner`; cannot read audit, cannot mint or revoke tokens.

**Alternative considered**: A `subActor: true` flag on `write` and
`approve` scopes.

**Why**: A scope name is searchable in audit, easy to reason about,
and matches the existing scope model. A flag would scatter
authorization checks ("is it scope X AND has flag Y?") through the
codebase. Scopes are also more discoverable in the pairing UI.

**Cost**: A new scope to remember. Documented and listed in
`/capabilities`.

### D2 — Sub-actor identity is bridge-asserted, not daemon-verified

**Choice**: The daemon trusts `X-RC-SubActor` from a `bridge`-scoped
token. There is no cryptographic proof the underlying chat-service
user is who the bridge says.

**Alternative considered**: Bridges forward signed user identities
from the chat service (e.g., a Telegram OAuth flow).

**Why**: Chat services do not generally offer a way for a bot to
forward provable user identities to a third party. Forcing the
operator to set up such a flow per chat service would make bridges
extremely expensive to write. The pragmatic call is: trust the
bridge (you ran it), capture both bridge tokenId and asserted
subActor in audit, and revoke the bridge on suspicion.

**Cost**: A compromised bridge can lie. Post-incident this is
visible: every action carries the bridge tokenId; audit can show
"all 47 'approved by ceo' came from this bridge in a 3-minute
window — likely compromise."

### D3 — `bridgeHints` advisory, not enforced

**Choice**: The `bridgeHints.sensitivity` and `recommendedSurface`
fields are best-effort recommendations. The bridge decides what to
render and how. The daemon does NOT refuse to send full args to a
"high sensitivity" event.

**Alternative considered**: Refuse to include `argsSummaryFull` in
the SSE frame when sensitivity is high.

**Why**: Sensitivity classification at this scope is necessarily a
heuristic. Making it security-critical means false negatives
become privilege bugs. Treating it as advice keeps the security
guarantees clear (the bridge sees what it has scope for, period)
and avoids a brittle classifier in the daemon.

**Cost**: A naïve bridge can render high-sensitivity content to a
public chat. Documentation flags this; operator owns the trust
boundary.

### D4 — Bridge heartbeat → auto-deregister on miss

**Choice**: Bridges must heartbeat via `POST /rc/bridges` every 60s.
Three consecutive misses → auto-deregister. Token remains valid; the
bridge just needs to re-register to come back.

**Alternative considered**: No heartbeat; bridges persist until
explicit deregister.

**Why**: Stale bridge records in `GET /rc/bridges` mislead operators
about what's live. Auto-cleanup matches the pattern of "presence is
the source of truth for liveness."

**Cost**: A briefly-flaky bridge gets deregistered and must
re-register. Acceptable; re-registration is one POST.

### D5 — Per-sub-actor token bucket vs per-bridge

**Choice**: Both. Per-bridge limits protect the daemon from one
hostile bridge. Per-sub-actor limits protect the bridge from one
hostile user.

**Alternative considered**: Per-bridge only.

**Why**: A bridge serving 100 well-behaved users plus 1 abuser
should not have all 100 throttled. Layered limits handle this
naturally.

**Cost**: Two counters per request. Negligible.

### D6 — Bans are bridge-scoped, not daemon-wide

**Choice**: Banning `telegram:trolly` from the Telegram bridge does
not affect `discord:trolly`.

**Alternative considered**: Daemon-wide bans on sub-actor IDs.

**Why**: Chat-service IDs collide across services
(`telegram:1234` and `discord:1234` are unrelated users). Cross-bridge
bans require identity correlation we explicitly opted out of (D2 of
`add-remote-control` style; this change's user-story B5 confirms).

**Cost**: Operator must ban per bridge if they want to ban a real
person who uses two services. Acceptable; rare case.

## Persistence

| Artifact            | Format    | Notes                                                                                                              |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `bridges` table     | SQLite    | Columns: `id, token_id, display_name, bridge_kind, capabilities (JSON), registered_at, last_heartbeat_at`.         |
| `bridge_bans` table | SQLite    | Columns: `bridge_id, sub_actor, reason, banned_at, banned_by_token_id`.                                            |
| Audit log entries   | JSONL     | `sub_actor` column added.                                                                                          |
| Rate limit counters | In-memory | (No WAL — rate limits resetting on restart is acceptable for this case; cf. policy quotas which need persistence.) |

## Risks / Trade-offs

| Risk                                 | Likelihood | Impact | Mitigation                                                             |
| ------------------------------------ | ---------- | ------ | ---------------------------------------------------------------------- |
| Bridges proliferate; users confused  | M          | L      | `qwen rc bridges` lists with capabilities; documented bridge taxonomy. |
| Sub-actor namespace collisions       | L          | M      | Strict `<kind>:<id>` enforcement; reject IDs without the prefix.       |
| Bridge crashes mid-message           | M          | L      | Bridge restarts replay events; client_evicted closes stale SSE.        |
| Operator forgets a bridge is running | M          | M      | Heartbeat-or-GC; presence event in workstation TUI keeps it visible.   |
| Sensitivity heuristic fails          | M          | L      | Advisory only (D3); operator owns trust boundary.                      |

## Open questions

1. **Should the daemon enforce a minimum capabilities set?** E.g.,
   refuse to register a bridge that declares `maxMessageBytes: 100`
   because it would chunk message rendering uselessly? Leaning no
   — let bridges declare honestly and let operators decide. Revisit
   if bad-capability bridges become a real problem.

2. **Should the audit `sub_actor` field be indexed in SQLite for
   fast `WHERE sub_actor = …` queries?** Probably yes for the
   `qwen rc audit --sub-actor` filter. Phase 3 work.

3. **Reference skeleton bridge in TypeScript or in a portable
   format?** TypeScript matches the existing repo and SDK. Done.

4. **Bot-token verification at registration?** The daemon cannot
   verify that a Telegram bot token is real. Bridges self-verify by
   actually working. Leave that to the bridge implementations.
