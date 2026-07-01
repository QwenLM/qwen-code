# Channel Lifecycle Status Umbrella Coverage

Date: 2026-07-01

## Support matrix

| Channel | Prompt typing/status surface | Task lifecycle status surface | Notes |
| --- | --- | --- | --- |
| Telegram | Yes | Yes | Adapter lifecycle coverage exists in adapter tests. |
| Weixin | Yes | Yes | Adapter lifecycle coverage exists in adapter tests. |
| DingTalk | Yes | Yes | Adapter lifecycle coverage exists in adapter tests. |
| Feishu | Yes | Yes | Markdown and adapter suites cover lifecycle-related behavior. |
| QQ Bot | No | No-op | QQ Bot API V2 has no typing or task-status endpoint. |
| Plugin example | No | No-op | Mock protocol streams chunks and final outbound messages only. |

## Verification commands

### Known baseline adapter results

- `cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts` -> 10 passed
- `cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts` -> 4 passed
- `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts` -> 20 passed
- `cd packages/channels/feishu && npx vitest run src/markdown.test.ts src/adapter.test.ts` -> 74 passed

### Commands run for this branch

- `cd packages/channels/qqbot && npx vitest run src/send.test.ts src/api.test.ts` -> 64 passed
- `npm run build` -> passed
- `npm run typecheck` -> passed

## Results

- QQ Bot tests: passed (`src/api.test.ts`: 13 passed, `src/send.test.ts`: 51 passed)
- Build: passed after synchronizing local dependencies with `npm install` so the worktree used the branch's locked `simple-git` version.
- Typecheck: passed.
