# Cross-session messaging: on by default

[English](2026-09-14-cross-session-messaging-default-on.md) | [简体中文](2026-09-14-cross-session-messaging-default-on.zh-CN.md)

Status: implemented alongside this document.

## Problem

`agents.crossSessionMessaging` has been opt-in since the feature landed.
Every session started with it off: invisible to the other sessions of
the same user, unreachable by them, and unable to address them. That was
the right posture while the pieces that make a reachable session safe
were still arriving, one pull request at a time.

They have arrived. An inbox authenticates every connection; a message
from another session is delivered only when both sessions are in the
same review class and is held for the user otherwise; a repository can
make a session more cautious but never less; a sender that outruns the
session is dropped and told; a program the user trusts presents a token
the user minted. With all of that in place, the switch being off by
default no longer protects anything — it only means the feature is not
there for the people it was built for. A voice front-end that joins
through the SDK's peer endpoint cannot see a session whose user never
found the setting, and two sessions in one repository cannot tell each
other a build finished.

## Design

**The schema default becomes `true`.** Nothing else about the setting
changes: `false` still turns the feature off for that session, restart is
still required, and the workspace may still only tighten.

**An unset key is read as on, in one place.** Merged settings carry only
what some scope actually wrote, so the schema default never reaches the
code as a value — every reader saw `undefined` and compared it to `true`.
The four readers (interactive startup, the ACP agent, `/peers`, and the
inbox-failure notice) now ask one helper, which answers on for `true` and
for `undefined`, and off for `false` and for anything it does not
recognize. The last case is deliberate: a value the reader cannot
interpret must not open a socket.

**The workspace ranking follows.** A workspace value is kept only when it
is stricter than what the user or the platform set, and "what they set"
was compared as if unset meant off. With unset meaning on, a repository's
`false` would have ranked equal to an unset user scope and been dropped
— a repository could never turn messaging off. Unset now ranks with
`true`, so `false` is a tightening and is kept; a workspace `true` repeats
the default and is dropped without a warning.

**The words change with the default.** `/peers` on a session with no inbox
no longer tells the user to enable a setting that is already on; it
distinguishes "turned off in settings" from "the inbox could not start".
The controller-token hint, the `send_message` error, the settings
reference, the SDK guides and the messaging section of the commands page
say what turning the feature _off_ looks like instead of how to turn it
on.

## Trade-offs

**No first-run notice.** A line in the transcript saying "other sessions
can now see this one" would need a per-home marker file to show once, and
would repeat for every scoped home. The documentation and `/peers` carry
the explanation; the review rules hold what another session sends for the
user to decide, with the two exceptions below.

**Two senders are delivered without review, and the default now reaches
them.** A process this session starts inherits its child token and is
delivered as the session's own: that is what lets a hook or a build script
report back, and it is documented as such. Review-class parity compares a
class the sender asserts, and nothing authenticates that assertion, so a
same-user process that can read the registry can claim the receiving
session's own class. Both were already true for anyone who turned
messaging on; on by default extends them to users who never looked at the
setting. Neither widens the boundary — both need code already running as
the same user inside the `0700`/`0600` directories, and such code can do
anything that user can — so they are recorded here, and in the setting's
description, rather than gated. Gating the child-token export on an
explicit opt-in would take a documented hook pattern away from default
users. A user who wants every such message reviewed sets
`agents.crossSessionInbound` to `hold`.

**Windows gets no inbox, and says so only when asked.** Automatic inbox
paths are not available there, and the inbox degrades to "unsupported
platform". Startup stays quiet unless someone wrote `true` in their user
settings or this workspace's — an operator's system-defaults file does not
count. `/peers` answers that messaging is not available on this platform,
as information rather than an error. An ACP process stops trying to bind
after its first hosted session learns this, instead of retrying for every
session. Nothing else changes for those users until named pipes land.

**An unrecognized value is off, not on.** The previous readers treated
anything but `true` as off, and the workspace ranking already counted an
unrecognized value as the strict one. Keeping that for the new default
means a typo cannot open a session by accident.

## Files

- `packages/cli/src/peerMessaging/enabled.ts` — the one reader of the
  switch.
- `packages/cli/src/config/settingsSchema.ts` — the default and its
  description; the generated JSON schema follows.
- `packages/cli/src/config/settingsUtils.ts` — unset ranks as on.
- `packages/cli/src/ui/startInteractiveUI.tsx`,
  `packages/cli/src/acp-integration/acpAgent.ts`,
  `packages/cli/src/ui/commands/peers-command.ts` — read through the
  helper.
- `packages/cli/src/commands/sessions/controllers.ts`,
  `packages/core/src/tools/send-message.ts` — wording.
- `docs/users/features/commands.md`, `docs/users/configuration/settings.md`,
  `docs/developers/sdk-typescript.md`, `packages/sdk-typescript/README.md`
  — the default, and how to turn it off.
