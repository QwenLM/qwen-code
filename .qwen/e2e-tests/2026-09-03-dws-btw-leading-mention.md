# DWS BTW After Bot Mention

Date: 2026-09-03

## Baseline reproduction

With the global Qwen Code 0.23.0 CLI and a DWS group that requires bot
mentions, send `@QwenBot /btw what day is it?`. The DWS adapter leaves the
visible mention in the inbound text, so the message enters the normal prompt
path instead of sending the immediate BTW acknowledgement.

Do not include real group, user, message, or application identifiers in
captured evidence.

## Verification

1. Start `qwen serve` with a DWS channel and open a normal main task in a group
   that requires mentioning the bot.
2. Send `@QwenBot /btw what day is it?` while the main task is still running.
3. Confirm the bot immediately sends `BTW #<id> received. The main task will
   continue.` and later sends the side-question answer with the same ID.
4. Confirm the main task is neither cancelled nor delayed by the side question.
5. Send `@QwenBot please continue` and confirm an ordinary mentioned prompt is
   unchanged and still runs through the normal task path.

## Automated coverage

- `cd packages/channels/dws && npx vitest run src/dws-channel.test.ts`
- `npm run typecheck`
- `git diff --check`
