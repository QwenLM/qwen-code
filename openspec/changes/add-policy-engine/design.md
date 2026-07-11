# Design — add-policy-engine

## Context

`add-remote-control` ships with first-responder permission voting:
every tool call emits a `permission_request` SSE frame, any
approve-scoped client casts a vote, first wins. This is great for
interactive use but is the bottleneck for unattended operation. The
two viable paths are (a) auto-approve rules evaluated in the daemon,
(b) push notifications so the human can vote from anywhere. This
change is (a); `add-webpush-notifications` is (b); they compose.

This change is intentionally narrow: declarative file-based rules,
no code execution, no policy-as-code runtime. The threat model
emphasizes operator-controlled rule files as the only trusted source
of automation policy.

## Goals / Non-Goals

**Goals:**

- Eliminate user-in-the-loop for clearly safe tool calls (allowlist).
- Hard-block clearly dangerous tool calls without a prompt-and-deny
  ceremony (denylist).
- Keep the threat model legible: the rule file is the entire trusted
  source of automation; nothing else escalates.
- Decisions visible to every attached client in real time.

**Non-Goals:**

- Policy-as-code runtime (Cedar/OPA). Adds a dependency, learning
  curve, and attack surface for marginal benefit at this scope.
- Cross-workspace policy distribution. Per-workspace `.qwen/policy.yaml`
  syncs via git — that's the operator's call.
- Model-level safety. We constrain execution, not generation.
- Approval workflow integration (PagerDuty etc.). Push handles
  remote approvals.

## Architecture

```
   Agent (qwen --acp child)
        │
        ▼ requestPermission(toolCall)
   ┌─────────────────────────────────────────┐
   │ daemon permission handler                │
   │                                          │
   │  1. policy.evaluator.match(toolCall) ────┼─▶ no match  ─▶ emit permission_request (existing flow)
   │                                          │
   │     match: allow ─▶ emit policy_decision─┼─▶ resolve permission immediately
   │                                          │
   │     match: deny  ─▶ emit policy_decision─┼─▶ resolve permission as denied
   │                                          │
   │     match: prompt + requireScope:X ──────┼─▶ emit permission_request with required-scope flag
   │                                          │
   │  2. quota.consume(rule)  (allow only)    │
   │  3. audit.log(decision, ruleId, …)       │
   └─────────────────────────────────────────┘
        ▲
        │ fsnotify (debounced 250ms)
   ~/.qwen/rc/policy.yaml
   <workspace>/.qwen/policy.yaml
```

Key invariants:

- **Evaluator runs before `permission_request` emission.** If a rule
  resolves the request, the prompt never reaches clients; only a
  `policy_decision` does.
- **Quotas are consumed only on `allow` matches** and only after the
  tool is actually invoked (not on bare match). A quota-exhausted
  rule no longer matches and we fall through.
- **`deny` is not consultable.** It never reaches clients; it returns
  a structured failure to the agent immediately.
- **Hot reload is debounced 250 ms** to coalesce editor-save bursts.
  A reload that produces a parse error keeps the previous rule set
  in memory and emits a `policy_load_error` SSE frame to owners.

## Rule file format

```yaml
# ~/.qwen/rc/policy.yaml
version: 1

defaults:
  # used when no rule matches
  action: prompt
  requireScope: approve

rules:
  - id: safe-tests
    match:
      tool: bash
      argsGlob: ['npm test*', 'pnpm test*', 'vitest *']
      pathGlob: '**' # any cwd within workspace
    action: allow
    maxPerWindow:
      count: 50
      windowSec: 3600
    expiresAt: 2026-05-16T08:00:00Z # optional absolute expiry

  - id: forbid-force-push
    match:
      tool: bash
      argsGlob:
        ['git push --force*', 'git push -f*', 'git push *--force-with-lease*']
    action: deny
    reason: 'Force-push prohibited by policy. Use a PR.'

  - id: auth-tree-owner-only
    match:
      tool: edit_file
      pathGlob: 'src/auth/**'
    action: prompt
    requireScope: owner

  - id: nighttime-quiet
    match:
      tool: '*'
      timeOfDay:
        from: '23:00'
        to: '07:00'
        timezone: 'America/Los_Angeles'
    action: prompt
    requireScope: owner
    priority: 100 # higher priority overrides lower
```

### Match semantics

| Field         | Meaning                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ----------------------------------------------------------------------- |
| `tool`        | Tool name string or glob. `"*"` matches any tool.                                                                         |
| `argsGlob`    | One or more globs matched against the canonical-string serialization of args (whitespace-collapsed).                      |
| `pathGlob`    | One or more globs matched against `args.path`, `args.cwd`, or `args.files[]` (tool-dependent).                            |
| `originScope` | Originating client's scope: `owner                                                                                        | write | approve | read`. Useful for "agents acting on behalf of read tokens cannot do X." |
| `timeOfDay`   | `{from, to, timezone}`. Local time at the daemon. Wraps over midnight if `from > to`.                                     |
| `sessionTag`  | Optional `--tag` value passed at session create — lets you have stricter policies for unattended runs (`tag: night-run`). |

All `match` fields are AND-combined; multi-value globs (lists) are
OR-combined within their field.

### Action semantics

| Action   | Effect                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `allow`  | Resolve permission with `outcome: "selected", optionId: "allow"`. Emit `policy_decision`.                     |
| `deny`   | Resolve permission with `outcome: "selected", optionId: "deny"` and `reason`. Emit `policy_decision`.         |
| `prompt` | Emit normal `permission_request`, but include `requiredScope` so clients without that scope hide the buttons. |

### Precedence

1. Workspace policy (`<cwd>/.qwen/policy.yaml`) is appended **after**
   user policy. Rules later in the merged list have higher position
   for first-match.
2. Within a file, rules are evaluated **most-specific first**, where
   specificity = sum of weights:
   - explicit tool name: 100; tool glob with no `*`: 90; tool `*`: 10
   - argsGlob present: 30
   - pathGlob present: 30
   - originScope present: 20
   - timeOfDay present: 20
   - sessionTag present: 20
3. Ties broken by explicit `priority` field (higher wins). Final tie:
   first one in source order.
4. If no rule matches, `defaults.action` is used.

This deterministic ordering avoids the surprise of rule-rearrangement
changing outcomes — a common pitfall of "first-match" policies.

## Auth & threat model

### Trust boundary

The rule file is the trust root for automation. Read access to it
== read of the automation policy; write access to it == ability to
change automation. We do NOT add per-rule signatures or cosigning;
the file is treated as part of the operator's repository.

### Threats

| Attacker                                 | Capability                                                           | Mitigation                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write-scope token holder                 | Force auto-approve via API                                           | No API to mutate policy — file-only. (See open question Q1.)                                                                                       |
| Compromised paired client                | Trick agent into proposing high-priv tool that matches an allow rule | `requireScope` + denylist for catastrophic tools (`rm -rf`, force-push) caught by `deny` rules regardless of scope.                                |
| File tamper by non-daemon process        | Rewrite policy.yaml                                                  | Daemon checks file mode at load (warns on world-writable); fsnotify is a load trigger, not a trust signal. Operator must control filesystem perms. |
| Hot-reload race (file replaced mid-eval) | Inconsistent rule snapshot                                           | Loader snapshots ruleset atomically; evaluator never holds a partial set.                                                                          |
| Time-of-day spoofing                     | Trick rule into matching wrong window                                | Daemon's wallclock is the source of truth; not configurable. Drift > 5 min logs a warning.                                                         |
| Quota wraparound / counter manipulation  | Bypass `maxPerWindow`                                                | Counters are in-memory + WAL'd; daemon restart restores from WAL.                                                                                  |
| Rule-DOS by adding 100k rules            | CPU exhaustion                                                       | Loader hard-caps `len(rules) ≤ 1000`; over-cap is a parse error.                                                                                   |
| `deny`-bypass via client-side approval   | Vote past a deny                                                     | `deny` never emits `permission_request`; no client surface to vote against.                                                                        |

### What does NOT change about threat model

- Owner bootstrap, scopes, audit log, TLS requirements from
  `add-remote-control` apply unchanged. Policy is additive.
- A malicious policy file makes the host malicious. The operator owns
  this trust boundary. There is no in-band recovery beyond editing
  the file.

## Lifecycle and persistence

| Artifact                        | Lifecycle                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `~/.qwen/rc/policy.yaml`        | Operator-managed. Loaded at daemon start, reloaded on fsnotify (debounced 250 ms).          |
| `<workspace>/.qwen/policy.yaml` | Operator-managed; same lifecycle. Loaded after user file.                                   |
| Quota counters                  | In-memory map keyed by `(ruleId, windowStart)`. Mirrored to `~/.qwen/rc/quotas.wal`.        |
| Audit log entries               | Append to existing `add-remote-control` audit stream; carries `decision_source`, `rule_id`. |
| `policy_decision` SSE events    | Replayed from existing event ring/WAL.                                                      |

Quota WAL is rotated daily; counters reset at the configured window
boundary (rolling, not aligned to wall-clock midnight, so a rule
created at 14:23 with `windowSec: 3600` resets at 15:23).

## Decisions

### D1 — Declarative file, not policy-as-code

**Choice**: YAML with a fixed schema. Glob matchers, no embedded
expressions or code.

**Alternative considered**: OPA/Rego, AWS Cedar, JS sandbox.

**Why**: PaaC engines pay for flexibility we won't use. Our policy
domain is bounded (tool name × args × path × scope × time). A
declarative file is self-documenting, diff-friendly, and resists the
"clever rule that nobody understands six months later" failure mode.
A user who needs expressiveness beyond what the schema offers should
file an issue to extend the schema — not write arbitrary code.

**Cost**: Some policies are awkward. Compose-pattern rules (e.g.
"allow read in dir X only when Y is also true") may need multiple
rules + a `denyOverride`-style hack. Acceptable.

### D2 — Evaluate before `permission_request` emission

**Choice**: The evaluator runs synchronously inside the permission
handler, before any SSE frame fires. `allow`/`deny` results never
become `permission_request` frames; only a `policy_decision` frame is
emitted.

**Alternative considered**: Emit `permission_request` always, then
have the daemon "vote" on its own behalf via the existing
first-responder API.

**Why**: Cleaner separation. Clients render approval cards only for
items that actually need approval. The vote-on-its-own-behalf approach
muddies what a "vote" means and adds a race where a human might
approve before the daemon's auto-vote lands.

**Cost**: Two code paths to maintain (auto-resolve vs prompt).

### D3 — `deny` is not overridable from clients

**Choice**: A `deny` decision is final. There is no client UI to
"approve anyway." Override requires editing the rule file.

**Alternative considered**: `deny` with `overrideScope: owner` allowing
the workstation owner to override interactively.

**Why**: The whole point of `deny` is irrevocable. Interactive
override defeats it under fatigue, social engineering, or
inattention. If the operator wants soft denial, they use `prompt` +
`requireScope: owner`. Two clear semantics beat one fuzzy one.

**Cost**: Iteration cost for the operator who has to edit a file.
Acceptable; the file is hot-reloaded.

### D4 — Hot reload via fsnotify, debounced 250 ms

**Choice**: The daemon watches both policy files for changes and
reloads with a 250 ms debounce. Parse errors keep the previous ruleset
loaded and emit `policy_load_error` to owners.

**Alternative considered**: Reload only on `qwen rc policy reload`.

**Why**: Editing a policy and forgetting to reload it is the
foot-gun-in-waiting. Auto-reload is what users expect after their
first surprise.

**Cost**: fsnotify is a portability headache (works on Linux/macOS,
needs polling fallback on Windows). Spec requires polling fallback
with 2 s interval where fsnotify is unavailable.

### D5 — Quota counters in-memory + WAL'd

**Choice**: Counters live in memory for fast match; mirrored to
`~/.qwen/rc/quotas.wal` on each increment so daemon restart preserves
the "I've already run npm test 12 times this hour" state.

**Alternative considered**: SQLite, an external store, or no
persistence.

**Why**: We already have a WAL pattern for SSE events. Reusing it for
quotas keeps the architecture coherent without pulling in another
on-disk format. SQLite is overkill for an append-only counter mirror.

**Cost**: Two WALs (event WAL, quota WAL). Bounded growth keeps both
tiny.

### D6 — Most-specific-first deterministic precedence

**Choice**: Within a merged ruleset, evaluate most-specific first by a
fixed specificity scoring; ties broken by explicit `priority`; final
tie by source order.

**Alternative considered**: Pure first-match, like firewall ACLs.

**Why**: First-match is friendly to operators who already know iptables
but is a maintenance nightmare — adding a more-specific rule above a
broad one is the only safe edit, and forgetting that breaks policies
silently. Specificity-first is harder to reason about for one rule but
much easier to maintain a large file.

**Cost**: Surprise factor when a user expects iptables semantics.
Doc + a `qwen rc policy explain <toolCall>` command (Phase 3
deliverable) mitigates.

## Risks / Trade-offs

| Risk                                              | Likelihood | Impact | Mitigation                                                                                  |
| ------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| Operator misconfigures and auto-approves too much | M          | H      | `qwen rc policy explain` dry-run; pre-deploy lint that warns when `allow` matches `*`.      |
| Rule precedence surprises                         | M          | M      | Doc + `policy explain` tool that shows which rule won and why.                              |
| Quota WAL grows unbounded                         | L          | M      | Daily rotation; old segments deleted on horizon roll.                                       |
| `argsGlob` matches command injection payload      | L          | H      | Globs are matched on canonical-string form, not parsed shell tokens. Document this clearly. |
| YAML parsing CVE                                  | L          | M      | Use `js-yaml` `safeLoad` (no constructors); never `load`.                                   |
| Time-of-day misfires across DST changes           | L          | L      | Use Intl.DateTimeFormat with IANA tz; warn when `from`/`to` span DST boundary.              |

## Open questions

1. **Should we expose any API for mutating policy?** Today, file-only.
   Some users might want "/quiet for 1 hour" as a temporary mute API.
   If so, the API needs an audit-strong story (who muted, for how
   long, why). Leaning toward NO and instead supporting time-bounded
   rules with `expiresAt` that users add manually.

2. **Should `prompt` rules with `requireScope` hide buttons from
   ineligible clients, or render them disabled with a reason?**
   Disabled-with-reason is more discoverable but reveals intent to
   read-scope clients. Going with disabled-with-reason; revisit if
   information disclosure becomes a concern.

3. **Pattern library / starter rules?** Should the daemon ship a
   `policy.example.yaml` with denylists for the obvious dangerous
   commands? Almost certainly yes; deferred to Phase 4 of this change
   so we can collect real-world patterns first.

4. **Tool-side cooperation?** Some tools could expose richer metadata
   (e.g., `edit_file` could include "lines changed: N") that policy
   could match on. Out of scope for this change — would need
   coordination with upstream qwen-code tool authors.

5. **Cross-rule interactions** like "rule A allows iff rule B also
   would have allowed." Not supported. If demand emerges, look at it
   as a follow-on; do not add expressions to this version.
