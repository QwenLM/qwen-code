# policy-engine — spec delta

## ADDED Requirements

### Requirement: Policy files loaded at startup and on change

The daemon SHALL load policy from two locations, in this order:

1. `~/.qwen/rc/policy.yaml` — user-scope.
2. `<workspace>/.qwen/policy.yaml` — workspace-scope, appended after
   user-scope so its rules can override.

The daemon SHALL reload the merged ruleset within 500 ms of any
filesystem change to either file, with a 250 ms debounce to coalesce
bursts.

#### Scenario: Workspace rules override user rules of equal specificity

- **GIVEN** user file rule `safe-tests` with action `prompt`
- **AND** workspace file rule with the same match block and action `allow`
- **WHEN** the agent proposes a matching tool call
- **THEN** the workspace rule wins
- **AND** the decision audit records `rule_id` of the workspace rule

#### Scenario: Parse error preserves previous ruleset

- **GIVEN** a valid ruleset is loaded
- **WHEN** the user edits the policy file producing invalid YAML
- **THEN** the daemon retains the previous ruleset in memory
- **AND** emits a `policy_load_error` SSE frame to all owner-scope subscribers
- **AND** logs the parse error with line and column

### Requirement: Schema and validation

A policy file MUST conform to schema version 1. The daemon SHALL
reject files where:

- `version` field is missing or `≠ 1`.
- Total rules exceed 1000.
- A rule ID is non-unique within the file.
- A rule's `action` is not one of `allow`, `deny`, `prompt`.
- A rule's `argsGlob` or `pathGlob` contains an absolute path
  (begins with `/` on Linux/macOS, drive-letter on Windows).
- A `requireScope` value is not one of `owner`, `write`, `approve`,
  `read`.

#### Scenario: Absolute-path glob rejected

- **WHEN** a rule has `pathGlob: "/etc/**"`
- **THEN** the loader emits `policy_load_error` with code
  `absolute_glob_not_allowed`
- **AND** the rule is excluded from the loaded ruleset

#### Scenario: Duplicate rule id rejected

- **WHEN** two rules in the same file have `id: safe-tests`
- **THEN** the loader rejects the file with code `duplicate_rule_id`
- **AND** retains the previously valid ruleset

### Requirement: Evaluator runs before permission_request emission

The daemon SHALL evaluate policy synchronously between the agent's
`requestPermission` call and any SSE emission. If a rule matches with
`allow` or `deny`, no `permission_request` event SHALL be emitted; a
`policy_decision` event SHALL be emitted instead.

#### Scenario: Allow short-circuits prompt

- **GIVEN** an `allow` rule matches the proposed tool call
- **WHEN** the agent issues `requestPermission`
- **THEN** the daemon emits exactly one `policy_decision` SSE frame
- **AND** does NOT emit a `permission_request` frame for this call
- **AND** the tool call proceeds without client involvement

#### Scenario: Deny short-circuits prompt with structured reason

- **GIVEN** a `deny` rule matches with `reason: "Force-push prohibited"`
- **WHEN** the agent issues `requestPermission`
- **THEN** the daemon emits one `policy_decision` SSE frame with
  `data.action: "deny"` and the reason
- **AND** returns a `policy_denied` outcome to the agent so the model
  receives a structured tool result

#### Scenario: Prompt with requireScope yields a scoped permission_request

- **GIVEN** a `prompt` rule matches with `requireScope: "owner"`
- **WHEN** the agent issues `requestPermission`
- **THEN** the emitted `permission_request` frame includes
  `data.requiredScope: "owner"`
- **AND** non-owner clients render the approval card with disabled
  buttons and a "requires owner scope" hint

### Requirement: Precedence is specificity-first with explicit priority tiebreak

Rules SHALL be evaluated in descending specificity order. Specificity
score is the sum of: 100 for explicit tool name, 90 for tool glob
without wildcard, 10 for tool `*`; 30 for non-empty `argsGlob`; 30 for
non-empty `pathGlob`; 20 each for `originScope`, `timeOfDay`,
`sessionTag`. Ties SHALL be broken by explicit `priority` (higher
wins), then by source order (earlier wins) with workspace rules
considered "later" than user rules.

#### Scenario: More specific rule wins over broader rule

- **GIVEN** rule A `{ tool: "bash", argsGlob: "git push --force*" }`
  with action `deny`
- **AND** rule B `{ tool: "bash" }` with action `prompt`
- **WHEN** the agent proposes `git push --force origin main`
- **THEN** rule A is selected
- **AND** the call is denied

#### Scenario: Explicit priority breaks specificity tie

- **GIVEN** rules A and B with identical specificity scores
- **AND** rule B has `priority: 100`, rule A has no priority
- **WHEN** both match a tool call
- **THEN** rule B is selected

### Requirement: Per-rule rate limiting via maxPerWindow

A rule with `maxPerWindow: { count, windowSec }` SHALL allow at most
`count` matches within any rolling `windowSec`-second window. Beyond
the cap, the rule SHALL NOT match.

#### Scenario: Rate-limited rule falls through after cap

- **GIVEN** rule `safe-tests` with `maxPerWindow: { count: 5,
windowSec: 60 }`
- **WHEN** the rule has matched 5 times in the past 60 seconds
- **AND** the agent issues a 6th matching tool call
- **THEN** the rule does NOT match
- **AND** evaluation continues to lower-specificity rules
- **AND** the audit entry records `rule_id: null, decision_source: default`

#### Scenario: Quota state survives daemon restart

- **GIVEN** quota counters are mid-window with 3 of 5 used
- **WHEN** the daemon restarts
- **THEN** on first match after restart, the counter resumes at 4 of 5

### Requirement: Absolute expiry via expiresAt

A rule with `expiresAt: <ISO-8601>` SHALL NOT match after that
timestamp.

#### Scenario: Expired rule ignored

- **GIVEN** a rule with `expiresAt: 2026-05-15T08:00:00Z`
- **WHEN** the daemon evaluates a matching call at `2026-05-15T08:00:01Z`
- **THEN** the rule does NOT match
- **AND** the daemon logs `rule_expired` to debug audit
- **AND** evaluation continues

### Requirement: New SSE event type policy_decision

The daemon SHALL emit `policy_decision` frames whenever the evaluator
resolves a tool call without prompting. The data payload SHALL include:

```jsonc
{
  "ruleId": "safe-tests",
  "action": "allow" | "deny",
  "toolCall": { "name": "bash", "argsSummary": "npm test --watch" },
  "reason": "<rule.reason or null>",
  "matchedAt": "<ISO>",
  "quotaRemaining": 47   // when applicable
}
```

#### Scenario: Frame matches schema

- **WHEN** any `policy_decision` frame is emitted
- **THEN** its `data` object contains `ruleId`, `action`, `toolCall`,
  `matchedAt` as a minimum

#### Scenario: Forward compatible across versions

- **GIVEN** a future daemon emits an extra `data.policySource:
"remote"` field
- **WHEN** a current-version client receives the frame
- **THEN** the client SHALL render the known fields and ignore the
  unknown one

### Requirement: Audit log carries decision_source and rule_id

Every audit entry corresponding to a tool call SHALL include
`decision_source: "policy" | "client" | "default"` and `rule_id`
(string or null).

#### Scenario: Policy-decided tool call audited as such

- **WHEN** a tool call is `allow`-decided by rule `safe-tests`
- **THEN** the audit entry contains `decision_source: "policy"` and
  `rule_id: "safe-tests"`

#### Scenario: Default-prompt fall-through audited as default

- **WHEN** no rule matches and a client approves via the standard
  prompt
- **THEN** the audit entry contains `decision_source: "client"` and
  `rule_id: null`

### Requirement: Operator commands for policy management

The CLI SHALL expose:

- `qwen rc policy reload` — force reload regardless of fsnotify state.
- `qwen rc policy explain <toolName> [--args=…] [--path=…]` — dry-run
  evaluator showing which rule (if any) would match and why.
- `qwen rc policy lint <file>` — schema validation without daemon
  reload.

#### Scenario: Explain shows match path

- **WHEN** the user runs `qwen rc policy explain bash --args="npm test"`
- **THEN** the output lists each rule considered in evaluation order
  with `MATCHED`/`SKIPPED` annotation
- **AND** the final decision and source rule (or default)

### Requirement: World-writable policy file warning

The daemon SHALL log a warning at startup if either policy file is
group- or world-writable.

#### Scenario: Permissive mode triggers warning

- **GIVEN** `~/.qwen/rc/policy.yaml` has mode `0666`
- **WHEN** the daemon starts
- **THEN** stderr contains a warning line
- **AND** an `audit_event` of type `policy_file_unsafe_perms` is logged
