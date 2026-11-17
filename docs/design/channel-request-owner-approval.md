# Channel Request Owner Approval

[English](channel-request-owner-approval.md) | [简体中文](channel-request-owner-approval.zh-CN.md)

## Problem

Text permission commands currently require shared-session operator privileges
before locating the request. An admitted user can therefore start a turn and
receive a tool confirmation they cannot answer, including in a direct message
using `sessionScope: "single"`. Group request owners encounter the same failure.

## Decision

Allow an admitted sender to use `/approve` (allow once) and `/deny` for their
own pending request in their current attended turn. This applies to direct and
group conversations, independently of the `operators` list, including an empty
list. Ownership of one request does not grant shared-session management rights.

Retain the existing operator requirements for `/approve-always`, approvals of
another sender's text request, `/cancel`, `/clear`, `/who`, `/status`, `/loop`,
`/btw`, loop tools, and steering. Existing native-card owner checks remain in
place. This change does not broaden native-card delegation or persistent grants.

## Implementation and Boundaries

Keep session routing and the shared-session operator predicate unchanged. Record
the active run ID with a pending permission. For a caller without shared-session
operator rights, filter lookup candidates to requests whose sender, current
attended run, chat, and thread match the caller. A missing, cancelled,
unattended, or superseded run cannot supply owner authority. Apply this filter
before producing ambiguity lists or permission titles, including explicit IDs.

Operators retain the existing lookup rules and normal conversation admission.
Named-task selection, native-card ownership, permission options, and settlement
continue to use the existing paths. Do not infer operators from pairing or
automatically rewrite configuration.

## Validation and Acceptance

- In `single`, `chat_thread`, and group `thread` sessions, the current request
  owner can approve once or deny without operator membership.
- A real privately paired sender can answer their own direct-message request.
- Another ordinary member cannot answer or list another sender's requests; the
  denied attempt leaves the request available for its owner.
- Cross-chat and cross-thread explicit IDs, requests without an attended owner,
  cancelled turns, and requests belonging to an earlier run are rejected.
- A non-operator owner cannot gain persistent permission with `/approve-always`
  in a shared session or clear the shared conversation.
- Existing operator delegation and native-card request settlement keep working.
- Run focused and full ChannelBase tests, build, typecheck, and bundle; distinguish
  local harness checks from live IM acceptance, which requires a deployed build.

## Risks

This intentionally separates request authority from session management: an empty
`operators` list continues to disable shared-session management and delegation,
but no longer prevents an attended request owner from approving once or denying.
The request must use the active run's sender snapshot, rather than the initial
owner of a `single` session shared across senders.
