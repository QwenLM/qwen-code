# Peer messaging: symmetric class parity and tighten-only repository settings

Status: implemented alongside this document. Tracks the first two parts of
the inbound-gate proposal; the trusted-controller layer in the same
proposal is a separate change.

## Problem

### The parity table had a shortcut

With no explicit `agents.crossSessionInbound`, the inbound gate decided
from approval-mode parity, and one row of that table let a receiver that
reviews every action accept anything at all — a bypassing sender, or a
sender that asserted no mode. The reasoning was that such a receiver has
a per-action backstop.

The backstop guards single actions. It does not guard what the session
is being talked into. A message from a session that runs unreviewed is
model-authored input that no person has looked at; delivered straight
into a session whose user chose "review everything", it can steer that
user's model one benign-looking step at a time, and the per-action
prompts are exactly the surface that fatigue turns into rubber stamps.
The user chose a mode in which they see everything, and that choice did
not include hearing from agents nobody is watching.

The row also made the table hard to hold in one's head: five rows, with
the receiver's class deciding whether the sender's class mattered at all.

### A repository could not make sessions more cautious

Both keys sat in `WORKSPACE_RESTRICTED_SETTINGS`, so a workspace value
was dropped whole, with a warning that read as a bug. Dropping the
loosening direction is right — a cloned repository must not open the
user's session to peers or force `accept` — but it also dropped
`"refuse"` and `false`, which is the direction a repository has a reason
to set: a monorepo whose automation agents must not be able to reach a
person's session, say.

### An invalid value at one scope could be replaced by a looser one

The gate already fails closed on a merged value it cannot read. But a
workspace value it could not read was stripped before the merge, so the
user's looser value took its place and the unreadable value never
reached the gate.

## Design

**One rule.** Every approval mode is in one of two review classes —
`prompting` (default, plan) or `bypass` (auto-edit, auto, yolo) — and a
message auto-delivers only between sessions of the same class:

| receiver           | sender says | result |
| ------------------ | ----------- | ------ |
| own process        | —           | accept |
| mode unknown       | —           | hold   |
| any                | nothing     | hold   |
| prompting          | `prompting` | accept |
| prompting          | `bypass`    | hold   |
| bypass             | `bypass`    | accept |
| bypass             | `prompting` | hold   |
| setting unreadable | —           | hold   |

The explicit setting still wins in both directions. `modeClass()` is the
one classification, exported from the gate and used by the send side, so
two sessions in the same mode always agree on their class. "Sender says
nothing" is held for every receiver: such a frame comes from a script, an
older build, or an external process, and the receiver has nothing to
pair it with. An external process the user wants driving their session
earns delivery through explicit trust, which is the follow-up.

`reevaluate` keeps its contract: a message held on a class mismatch is
released the moment the receiver's mode moves into the sender's class,
without the user approving it by hand.

**Tighten-only workspace values.** The two keys move from
`WORKSPACE_RESTRICTED_SETTINGS` to a new `WORKSPACE_TIGHTEN_ONLY_SETTINGS`
beside it, each with a `strictness` function (`accept` < unset < `hold` <
`refuse`; `true` < `false` = unset). Unrecognized values rank by the
fail-closed behavior their reader applies: inbound messages are held, and
messaging is off.
At merge time a trusted workspace's value is kept only when it is strictly
stricter than the value User or SystemDefaults set (the stricter of the
two if both do), or than the feature's default when neither does. Equal
is dropped silently — it lost nothing. Looser is dropped with a warning
that says which scope it lost to. System still overrides outright; when
it sets the key the workspace value is dropped and the warning names
System. The same verdict function drives the strip and the warning, so
they cannot disagree about a value.

**Unrecognized values fail closed at every scope.** The comparison uses
those fail-closed outcomes, so an unrecognized workspace policy cannot
replace a stricter `refuse`, while it can still replace `accept` and reach
the gate as `policy-unreadable`. The switch is off for anything but `true`.

**The hold cause names the scope.** The gate takes an optional
`getPolicyScope` beside `getPolicySetting`; the CLI answers it from the
loaded settings by walking the scopes in the order the merge lets them
win (System; the user's own value if it is the one in force; a workspace
value that replaced it; SystemDefaults). A held entry carries
`policyScope` for the two setting-driven causes, and `describeHoldCause`
words "this repository's settings hold …" or "a system setting holds …"
instead of "your setting". The scope is decoration: a throwing scope
getter is ignored, never turned into a verdict.

**What does not change.** The wire protocol, `fromMode`'s vocabulary, the
child-token row, receipts, the held-buffer bounds, and every explicit
setting path.

## Trade-offs

- A prompting receiver now holds messages from bypassing senders that it
  used to deliver. That is the point, and the cost is one `/peers accept`
  per message, or switching the receiver into the sender's class, which
  releases the backlog. Two sessions a user runs in the same mode notice
  nothing.
- Messages from senders that assert no class are held for prompting
  receivers too, which affects hand-written scripts that reach a session
  over its published token rather than its child token. Such a script can
  assert `fromMode` honestly; the child-token path, which is how a
  session's own scripts are meant to reach it, is unaffected.
- Ranking `undefined` for the inbound key means a workspace `hold` is
  honored when the user set nothing, because parity delivers some
  messages and `hold` delivers none. A workspace that wants exactly the
  parity default has no value to write for it; unset is that value.

## Files

- `packages/core/src/ipc/inbound-gate.ts` — the table, `ModeClass` /
  `modeClass`, `PolicyScope`, `getPolicyScope`, `policyScope` on held
  entries, scope-aware `describeHoldCause`.
- `packages/core/src/ipc/peer-send.ts` — `senderModeClass` delegates to
  `modeClass`.
- `packages/cli/src/config/settingsUtils.ts` — `WORKSPACE_TIGHTEN_ONLY_SETTINGS`.
- `packages/cli/src/config/settings.ts` — `tightenOnlyVerdict`,
  `stripWorkspaceLoosenings`, the two warnings.
- `packages/cli/src/peerMessaging/inbound-policy-scope.ts` — which scope
  the merged value came from.
- `packages/cli/src/peerMessaging/peer-messaging.ts`,
  `packages/cli/src/ui/startInteractiveUI.tsx` — the scope getter, wired.
- `packages/cli/src/ui/AppContainer.tsx`,
  `packages/cli/src/ui/commands/peers-command.ts` — the hold notice and
  the `/peers` listing pass the scope through.
- `docs/users/features/commands.md`, `docs/users/configuration/settings.md`.
