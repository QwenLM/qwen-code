# Observed Channel Group Names Implementation Plan

> **For agentic workers:** Execute each task test-first and keep the change limited to inbound metadata already supplied by the platform.

**Goal:** Return human-readable observed group labels when an accepted inbound callback already contains a group name, while retaining complete platform IDs and the existing ID fallback.

**Architecture:** Channel adapters copy an optional inbound group name into `Envelope.chatName`. `ChannelBase` sanitizes that observation and writes it as `group.label`; the existing workspace store handles bounds, refresh, freshness, and graph derivation without a schema change. No adapter performs additional network requests.

## Constraints

- Never call a platform directory, group-detail, or chat-info API.
- Keep `chatId` as the routing, session, deduplication, and graph identity key.
- Use `chatName` only for `groups[].label` on group messages.
- Preserve complete-ID fallback for missing or unusable names.
- Implement only platforms with verified inbound fields: DingTalk and Telegram.
- Keep Feishu, WeCom, and topic labels on their existing ID fallback paths.

## Task 1: Shared envelope and observation behavior

**Files:** `packages/channels/base/src/types.ts`, `packages/channels/base/src/ChannelBase.test.ts`, `packages/channels/base/src/ChannelBase.ts`

1. Add failing base-channel tests proving a group `chatName` becomes `group.label`, malformed or empty names fall back to the complete `chatId`, and direct messages ignore `chatName`.
2. Run `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts` and confirm the new assertions fail for the missing contract.
3. Add optional `chatName?: string` to `Envelope`.
4. Sanitize the observed group name at the existing post-preflight observation boundary and fall back to `chatId` when unusable.
5. Re-run the focused base test and confirm it passes.

## Task 2: DingTalk inbound group title

**Files:** `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`, `packages/channels/dingtalk/src/DingtalkAdapter.ts`

1. Add a failing adapter test whose Stream callback contains `conversationTitle` and assert the processed envelope contains `chatName` while preserving `chatId`.
2. Run `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts` and confirm the new assertion fails.
3. Add `conversationTitle` to the raw inbound type, validate it as a string, and place it on the group envelope.
4. Do not change acknowledgements, webhook caching, routing, logging, or send behavior.
5. Re-run the focused DingTalk test and confirm it passes.

## Task 3: Telegram inbound chat title

**Files:** `packages/channels/telegram/src/TelegramAdapter.test.ts`, `packages/channels/telegram/src/TelegramAdapter.ts`

1. Add failing tests proving group and supergroup `chat.title` values become `chatName`, while a private chat does not expose a group name.
2. Run `cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts` and confirm the new assertions fail.
3. Extend the adapter's local inbound chat shape with optional `title` and copy it only for group or supergroup envelopes.
4. Re-run the focused Telegram test and confirm it passes.

## Task 4: User-facing contract documentation

**Files:** `docs/design/2026-07-17-observed-channel-delivery-targets.md`, `docs/users/features/channels/overview.md`

1. Replace the statement that all group labels fall back to IDs with the best-effort inbound-name behavior.
2. Document that DingTalk and Telegram currently supply names and that Feishu/WeCom retain the complete-ID fallback.
3. Keep topic-label and membership limitations explicit.

## Task 5: Verification and publication

1. Run Prettier on all changed files.
2. Run the focused base, DingTalk, Telegram, and existing observed-contact store tests.
3. Run `npm run lint && npm run typecheck && npm run build`.
4. Inspect the complete diff in two clean self-audit passes; any fix resets the clean-pass count and relevant tests.
5. Commit the implementation, push `feat/channel-observed-group-names`, and open a stacked draft PR that declares its dependency on #7109 and links #7154.
6. Add the E2E plan/result as a separate PR comment. Verify DingTalk with a real group callback; record Feishu as a negative schema/fallback check rather than making an API request.
