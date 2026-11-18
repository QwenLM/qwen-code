# Managed DingTalk ledger registration-identity keying

- **Status:** proposed
- **Date:** 2026-11-18
- **Scope:** `packages/channels/dingtalk` (state store + adapter), tests
- **Related:** the WeCom adapter's P1-D/E fix (PR #17441); the shared `destinationKey` contract in `channel-base`; [Chinese version](2026-11-18-managed-dingtalk-registration-identity.zh-CN.md)

## Problem

The managed DingTalk state store keys its single ledger file by the configured entry only — channel name + robot `clientId`, per workspace scope. A private message staged as a pending claim under one control-plane registration (tenant A) is therefore loaded when the same configured entry is restarted against a different registration (tenant B, or a different actor/workspace/cwd-relative within one tenant). The persisted event carries the full text and no tenant identity; `resubmitPending()` forwards it through the HTTP client, which supplies the new registration's tenant header and channel id, so an event already admitted by A whose answer was lost can create an input under B. This is the same cross-ownership replay the WeCom adapter closed in P1-E.

## Current state

`ManagedDingtalkStateStore(name, cwd, clientId)` hashes `name\0clientId` into a per-entry directory `~/.qwen/channels/<workspace-scope>/dingtalk-<hash>` and stores a single `managed-state.json` beneath it. The directory lock (`proper-lockfile`) serializes concurrent managed instances of the robot app. The adapter constructs the store with three arguments and never passes the control-plane destination.

The shared `ManagedChannelControlPlane.destinationKey` (added for WeCom) already binds the full registration identity — base URL + tenant + channel + actor + workspace + cwd-relative — and `HttpManagedChannelControlPlane`, the only production implementation (constructed by the shared `createManagedChannelCommand` factory all managed channels use), populates it on every real path. The base interface comment names the DingTalk store as the sibling that does not yet bind it.

## Proposed change

Mirror the WeCom P1-D/E shape exactly:

- **Store constructor** gains a fourth parameter `identityKey = ''`. The lock directory stays keyed by the configured entry (`name\0clientId`) per workspace scope — NOT by destination — so two instances of the same robot app contend for one connection lock even when they target different control-plane destinations. The ledger FILE beneath that directory is keyed separately by `sha256(identityKey)`: `managed-state-<ledgerKey>.json`. A pending ledger staged under one registration is never loaded or replayed under another registration of the same entry.
- **Adapter constructor** passes `options.controlPlane.destinationKey ?? ''` as the fourth argument. The `?? ''` fallback only spares non-persisting test doubles that omit the optional field; the production HTTP client always supplies it.

The lock stays per-entry deliberately: a per-destination lock would let two registrations of one configured robot app each acquire a lock and run concurrently, duplicating inbound processing. The ledger keying adds cross-registration isolation without narrowing the lock.

The shared `destinationKey` comment in `channel-base` is updated to name WeCom **and DingTalk** as the adapters that bind the registration identity, and to point at GitHub (name+endpoint only) and email (separate variant) as the remaining follow-ups, so the contract documentation does not keep naming DingTalk as the sibling that lacks the keying.

## Files affected

- `packages/channels/base/src/managed-channel.ts` — `destinationKey` comment: name WeCom and DingTalk as binders; GitHub/email remain follow-ups.
- `packages/channels/dingtalk/src/managed-state.ts` — store constructor: entry-keyed directory + identity-keyed ledger file.
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.ts` — pass `destinationKey` to the store.
- `packages/channels/dingtalk/src/managed-state.test.ts` — file-path expectations updated; keying and isolation witnesses added.
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.test.ts` — `fakeControlPlane` gains a `destinationKey`; destination/workspace isolation and shared-lock witnesses added.
- This design doc and its Chinese version.

## Upgrade consequence and diagnostics

The ledger file is renamed from `managed-state.json` to `managed-state-<ledgerKey>.json` with **no adoption**: the first restart after upgrading starts on a pristine identity-keyed ledger. A claim that was staged (persisted and acked `SUCCESS` to the DingTalk stream, which does not redeliver an acked frame) but not yet admitted is stranded — the control plane never saw it (only `submitInbound` makes a claim visible), so only this client's own ledger could re-drive it, and the new ledger does not contain it. The same reset drops un-receipted outbound segments, the dedupe window and the webhook reply-target map. This is the deliberate stranding tradeoff the WeCom design records: adopting the legacy ledger would replay one registration's pending into another, the cross-ownership hazard the keying prevents.

To make the drop explicit rather than silent, `connect()` detects a sibling `managed-state.json` (`strandedLegacyLedger()`) and logs one line naming that path and its pending/outbound counts; it does not adopt it. Detection is deliberately NOT gated on the identity-keyed ledger being absent: a rollback to the pre-upgrade build can stage fresh claims into `managed-state.json` after a keyed ledger already exists, and those acked-but-unadmitted claims must still be reported, not vanish silently. The record carries a `readable` flag: a legacy whose contents cannot be read or parsed is reported with `unknown` counts and an explicit "any staged claims it held are stranded" warning, never rendered as a quiescent empty ledger (a crash-truncated or EACCES/EISDIR legacy is precisely the case where claims were certainly stranded). For a readable legacy the inbound and outbound consequences are named separately — "staged-but-unadmitted claims … are lost" only when `pending > 0`, and "un-receipted outbound segments were dropped" only when `outbound > 0` — so an outbound-only strand does not report lost inbound messages and a quiescent 0/0 upgrade gets the diagnostic line but no false data-loss alarm. A corrupt legacy never throws, so a damaged legacy never turns the upgrade into a hard startup failure. The archive is deferred until the start succeeds: after `stream.connect()` and registration, `archiveStrandedLegacy()` renames the legacy to `managed-state.json.stranded-<id>` — never deletes it, so the stranded claims stay inspectable — so a static legacy is not re-announced on every later start and a second registration of the entry is not told the first registration's claims were its own. A failed first start leaves the legacy untouched so a rollback to the pre-upgrade build can still recover it (the notice simply repeats on the retry); a rollback that stages a fresh `managed-state.json` is detected again on the next upgrade. `load()` also names `this.file` and keeps the fs `{ cause }`, splitting I/O failure from corrupt JSON, so an operator facing several `<hash>.json` ledgers can tell which registration is down.

The webhook reply-target cache (`state.webhooks`) lives inside the identity-keyed ledger, so it is now scoped per registration: after an identity change a webhook-less frame for a previously-known conversation has no cached reply target and is dropped (acked + deduped), where the old shared ledger would still have admitted it. This is a cost of the partition, pinned by a test; hoisting the cache to entry scope is a possible follow-up if webhook-less frames across identity changes prove common.

## Scope boundaries

- The DingTalk stream connection and admission/outbound discipline are unchanged. The webhook reply _mechanism_ is unchanged, but the webhook cache is now identity-scoped (see Upgrade consequence): a webhook-less frame after an identity change is dropped rather than admitted from a cross-registration cache.
- The `disconnect()` row-deregistration gate is a separate concern and is not touched here.
- No control-plane (Java) change; no `channel-base` contract/API change — only the `destinationKey` doc comment is updated to name WeCom and DingTalk as the adapters that bind the registration identity.
- The email and GitHub stores are out of scope. GitHub keys its single ledger by name + endpoint (`baseUrl`) only, and email is a separate variant; neither binds the full registration identity, so each is its own follow-up rather than part of this DingTalk change.

## Open questions

- None: the shape is settled by the WeCom P1-D/E precedent and the shared `destinationKey` contract.
