# Hosted Hook message-display reload gate FG13f

[English](2026-10-21-hosted-hook-message-display-reload-f.md) | [简体中文](2026-10-21-hosted-hook-message-display-reload-f.zh-CN.md)

> Tracks #14449. The last planned FG13f row: a MessageDisplay Hook
> suppresses a reply, and a reload must not resurrect it.

## Problem and scope

A `MessageDisplay` Hook is fire-and-forget, but its `suppressOutput` result
decides whether the reply's text and parts reach the output at all. The
Hosted model applies that decision before the assistant message is
committed, so the persisted history should carry an empty message, not the
raw text.

The risk is the persistence boundary: a reload loads the Session from the
store and rebuilds the next model request's history. If the suppressed text
was committed anywhere, the next request (or the public ledger) would carry
it. No Hosted cell pins that boundary today; the in-process model tests
cover `suppressOutput` only.

## Case

`fg13fMessageDisplaySuppressionSurvivesReloadOnMySql` in
`HostedHookMessageDisplayReloadIT`, one cold boot on the
`hosted-harness-mysql` lane:

| Step | What happens                                                            |
| ---- | ----------------------------------------------------------------------- |
| 1    | A `MessageDisplay` command Hook returns `{"suppressOutput": true}`.     |
| 2    | The model streams the reply `FG13F_SECRET`; the turn completes.         |
| 3    | The public ledger is read: the secret never appears.                    |
| 4    | The Harness is restarted, loading the Session from the store.           |
| 5    | A second prompt is submitted; the model request's history is inspected. |

Expectations:

- One `hook.call` and one `hook.suppress`; the turn completes normally.
- The public event ledger has no `FG13F_SECRET` row.
- After the reload, the next model request's history carries no
  `FG13F_SECRET`, and the second turn completes.

## Coverage

`hosted-harness-model.test.ts` pins the in-process `suppressOutput` result.
This cell adds the reload and persistence boundary: the committed message,
the ledger row and the rebuilt request history.

## Mutation witnesses

- Commit the raw text despite suppression: the reloaded request contains
  `FG13F_SECRET`.
- Stream the raw text on the public ledger: the ledger assertion reddens.
- Skip the Hook: no `hook.suppress` event, and the reply is no longer
  suppressed.

## Non-goals

- Stop-Hook suppression and forced continuations: separate arms.
- FG13a store acknowledgements stay on #14449.

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. `managed-agent-gate.yml` selects the `fast`
tier on `pull_request`; the full suite runs on the first maintainer approval
of the head commit, so a skipped lane is not a passing gate. The cell adds
150 s to the shared fork.
