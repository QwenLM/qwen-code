# DingTalk Structured User Mentions

Date: 2026-07-22

## Baseline reproduction

Using Qwen Code 0.20.1 with a DingTalk Stream channel, send a group message that mentions the bot and one other member. DingTalk delivers two entries in `atUsers`, removes both visible names from `text.content`, and the current adapter forwards only the remaining text to the model. With debug payload logging enabled, the nested `dingtalkId` and `staffId` values are also logged without redaction.

Use anonymized identifiers in all captured evidence. Do not commit real group, user, staff, message, webhook, or application identifiers.

## Verification

1. Send `@Bot please review this @Member` in a test group.
2. Confirm the inbound model text starts with `[Mentioned 1 other group member]` followed by `please review this`.
3. Confirm the bot's own `atUsers` entry is excluded and duplicate member entries are counted once.
4. Send `@Bot hello` and confirm no additional mention context is added.
5. Enable `QWEN_CHANNEL_DEBUG_PAYLOAD` for the test channel and confirm `atUsers[].dingtalkId` and `atUsers[].staffId` appear as `[redacted]` while routing fields needed for diagnostics remain visible.

## Automated coverage

- `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts`
- `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts`
- `npm run typecheck`
- `git diff --check`
