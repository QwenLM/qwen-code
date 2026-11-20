# Managed email ledger registration-identity keying

- **Status:** proposed
- **Date:** 2026-11-20
- **Scope:** `packages/channels/email` (managed state store + adapter), tests
- **Related:** the WeCom P1-D/E fix (PR #17441), the DingTalk keying (PR #17742), and the GitHub keying (PR #17775); the shared `destinationKey` contract in `channel-base`; [Chinese version](2026-11-20-managed-email-registration-identity.zh-CN.md)

## Problem

The managed email state store keeps a single ledger file `managed-state.json` in the mailbox directory, keyed only by the configured mailbox (name + IMAP host/port/user/folder/address). A claim staged under one control-plane registration (tenant A) is therefore loaded when the same configured mailbox is restarted against a different registration (tenant B, or a different actor/workspace/cwd-relative within one tenant). The persisted pending event carries the UID and event text but no tenant identity; `resubmitPending()` forwards it through the HTTP client, which supplies the new registration's tenant header and channel id, so an event already admitted by A whose answer was lost can create an input under B. This is the same cross-ownership replay the WeCom adapter closed in P1-E and the DingTalk / GitHub adapters closed in #17742 / #17775.

## Current state

`ManagedEmailStateStore(name, cwd, settings)` reuses the Legacy `EmailStateStore` directory (`email-<digest(mailbox)>`) so the lock keeps one owner per mailbox, managed or Legacy, and writes `managed-state.json` beneath it. `load()` returns `undefined` on ENOENT and otherwise throws a single opaque "unreadable or invalid" error. There is no upgrade diagnostic: after the ledger is renamed, a pre-upgrade `managed-state.json` left beside it would be silently ignored.

## Design

Mirror the WeCom / DingTalk / GitHub shape exactly, with the email-specific lock and cursor semantics:

- **Store constructor** gains a fourth parameter `identityKey = ''`. The lock directory is UNCHANGED — it stays the Legacy mailbox directory (`email-<digest(mailbox)>`), so the lock still keeps one owner per mailbox, managed or Legacy; identity keying must not narrow that lock or split managed from Legacy. The ledger FILE beneath that directory is keyed separately by `ledgerKey = sha256(identityKey).slice(0, 16)`: `managed-state-<ledgerKey>.json`. A pending ledger staged under one registration is never loaded or replayed under another registration of the same mailbox. Credentials never define identity.
- **Adapter constructor** passes `options.controlPlane.destinationKey ?? ''` as the fourth argument. The `?? ''` fallback only spares non-persisting test doubles that omit the optional field; the production HTTP client always supplies it.
- **`load()`** splits the read / parse / validate arms, names `this.file`, and keeps the fs `{ cause }`, so an operator facing several `managed-state-<hash>.json` ledgers can tell which registration is unreadable versus merely invalid.
- **Upgrade diagnostic** — `strandedLegacyLedger()` reports a sibling pre-upgrade `managed-state.json` (path + pending/outbound counts + a `readable` flag), and `archiveStrandedLegacy()` renames it to `managed-state.json.stranded-<uuid>` (never deletes) once the start succeeds. Detection is NOT gated on the identity-keyed ledger being absent: a rollback to the pre-upgrade build can stage fresh claims into `managed-state.json` after a keyed ledger already exists, and those must still be reported. The legacy ledger is NOT adopted — adopting it would replay one registration's pending into another, the cross-ownership hazard the keying prevents.

### Upgrade consequence

The ledger file is renamed from `managed-state.json` to `managed-state-<ledgerKey>.json` with **no adoption**: the first restart after upgrading starts on a pristine identity-keyed ledger. A claim that was staged (persisted) but not yet admitted is stranded — the control plane never saw it (only `submitInbound` makes a claim visible), so only this client's own ledger could re-drive it, and the new ledger does not contain it. Unlike DingTalk's acked stream, email does not ack a frame to the provider; the loss comes from the cursor: a fresh ledger's `openMailbox` sets `lastUid = mailbox.uidNext - 1` (the current mailbox tip), so the stranded claims' older UIDs are below the fresh search floor and are never re-fetched. The same reset drops the dedupe window (`recent`), the reply routes, and the un-receipted outbound segments. This is the deliberate stranding tradeoff the WeCom / DingTalk / GitHub designs record.

The notice names the inbound and outbound consequences separately (an outbound-only strand does not report lost inbound mail; a quiescent 0/0 legacy reports no loss), and an unreadable legacy is reported with `unknown` counts and an explicit "any staged claims it held are stranded" warning, never a quiescent empty ledger. The archive is deferred until the start succeeds (after mailbox open, registration, and the ownership re-check), so a failed first start leaves the legacy for a rollback to recover; a second log line names the archived path. A failed archive rename is logged and leaves the legacy in place (degraded, never a startup failure).

## Files affected

- `packages/channels/email/src/managed-state.ts` — store constructor: identity-keyed ledger file in the unchanged Legacy mailbox directory; `load()` split arms; `strandedLegacyLedger()` + `archiveStrandedLegacy()`.
- `packages/channels/email/src/managed-email-adapter.ts` — pass `destinationKey` to the store; `connect()` strand notice + ownership re-check + deferred archive + archived-path / failed-archive log.
- `packages/channels/email/src/managed-state.test.ts` and `managed-email-adapter.test.ts` — keying, isolation, stranding, corrupt-legacy, and archive witnesses.
- This design doc and its Chinese version.

## Scope boundaries

- The email IMAP polling, admission/outbound discipline, mailbox-epoch re-key, and instance-scoped stall are unchanged. Only the ledger file name and the upgrade diagnostics change.
- The lock stays the shared Legacy mailbox lock deliberately: identity keying adds cross-registration ledger isolation without narrowing the one-owner-per-mailbox lock or splitting managed from Legacy.
- No control-plane (Java) change; no `channel-base` contract/API change.
- The email store has no PR-watch, so there is no episode carry (unlike GitHub).

## Open questions

- None: the shape is settled by the WeCom P1-D/E, DingTalk #17742, and GitHub #17775 precedent and the shared `destinationKey` contract.
