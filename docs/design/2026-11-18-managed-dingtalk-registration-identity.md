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

## Scope boundaries

- The DingTalk stream connection, webhook reply path, and admission/outbound discipline are unchanged.
- The `disconnect()` row-deregistration gate is a separate concern and is not touched here.
- No control-plane (Java) change; no `channel-base` change (the `destinationKey` contract already exists).
- The email and GitHub stores are out of scope. GitHub keys its single ledger by name + endpoint (`baseUrl`) only, and email is a separate variant; neither binds the full registration identity, so each is its own follow-up rather than part of this DingTalk change.

## Open questions

- None: the shape is settled by the WeCom P1-D/E precedent and the shared `destinationKey` contract.
