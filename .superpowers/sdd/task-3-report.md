Status: DONE

Commands run:
- `sed -n '1,220p' /Users/qqqys/.codex/plugins/cache/openai-curated/superpowers/e855fa51/skills/test-driven-development/SKILL.md`
- `sed -n '1,220p' .superpowers/sdd/task-3-brief.md`
- `sed -n '1,240p' packages/channels/weixin/src/WeixinAdapter.ts`
- `rg --files packages/channels/weixin/src`
- `sed -n '1,260p' packages/channels/weixin/src/api.test.ts`
- `sed -n '1,260p' packages/channels/weixin/src/send.test.ts`
- `sed -n '1,220p' packages/channels/telegram/src/TelegramAdapter.test.ts`
- `sed -n '1,120p' packages/channels/base/src/ChannelBase.test.ts`
- `sed -n '1,120p' packages/channels/base/src/ChannelAgentBridge.ts`
- `sed -n '130,210p' packages/channels/base/src/types.ts`
- `cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts` (red 1)
- `cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts` (red 2)
- `cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts` (green)
- `cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts src/api.test.ts src/send.test.ts`
- `npm run build`
- `npm run typecheck` (first run overlapped with build and produced TS6305 workspace artifact timing noise)
- `npm run typecheck` (serial rerun after build)
- `git add packages/channels/weixin/src/WeixinAdapter.ts packages/channels/weixin/src/WeixinAdapter.test.ts`
- `git commit -m "feat(channels): map weixin lifecycle to typing"`

Results:
- Failing-before evidence:
  - Initial harness failure: `bridge.on is not a function`
  - Corrected red failure after minimal bridge setup: `expected 1st "spy" call to have been called with [ 'user-1', true ], but called only 0 times`
- Passing-after evidence:
  - `src/WeixinAdapter.test.ts`: 1 passed
  - `src/WeixinAdapter.test.ts src/api.test.ts src/send.test.ts`: 39 passed
  - `npm run build`: passed
  - `npm run typecheck` serial rerun after build: passed

Commits created:
- `2dc200e3d feat(channels): map weixin lifecycle to typing`

Changed files:
- `packages/channels/weixin/src/WeixinAdapter.ts`
- `packages/channels/weixin/src/WeixinAdapter.test.ts`

Self-review notes:
- Kept the change idempotent with a per-chat active typing set.
- Reused the same start/stop helpers for prompt hooks and lifecycle events to avoid divergent behavior.
- Preserved existing best-effort typing semantics by swallowing `setTyping` failures and clearing local active state only on failed start.
- Did not touch Telegram or any non-owned task files.

---

Status: DONE

Commands run:
- `npx vitest run src/WeixinAdapter.test.ts` (red: regression reproduced before fix)
- `npx vitest run src/WeixinAdapter.test.ts` (green after fix)
- `npx vitest run src/WeixinAdapter.test.ts src/api.test.ts src/send.test.ts`
- `git add packages/channels/weixin/src/WeixinAdapter.ts packages/channels/weixin/src/WeixinAdapter.test.ts`
- `git commit -m "fix(channels): reset weixin typing state after failed start"`

Test output summary:
- Red: `src/WeixinAdapter.test.ts` failed in `clears failed start typing state so a later started event can retry` because `activeTypingChats` stayed active after a rejected start.
- Green: `src/WeixinAdapter.test.ts` passed with 2/2 tests.
- Covering run: `src/WeixinAdapter.test.ts src/api.test.ts src/send.test.ts` passed with 40/40 tests.

Commit:
- `112771ee5 fix(channels): reset weixin typing state after failed start`

Changed files:
- `packages/channels/weixin/src/WeixinAdapter.ts`
- `packages/channels/weixin/src/WeixinAdapter.test.ts`
