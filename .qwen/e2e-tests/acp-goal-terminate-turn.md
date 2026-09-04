# ACP Goal turn ends after update_goal verification

## Test groups

### A Goal turn ends once its proposal is queued

Run a Goal in a daemon-backed session (`qwen serve` with the web shell, or any ACP client) and give it an objective a single turn can satisfy, such as writing a poem. The model should deliver the poem, read the Goal, propose completion, and stop. The Goal status card should then report the independent verification result, and the goal's turn count should advance past zero.

Before this change the same run never left the turn: the model kept alternating between the two Goal tools, every proposal after the first was rejected as already recorded for that turn, verification never ran because it only happens at a turn boundary, and the turn count stayed at zero until a person cancelled the session.

### A Goal turn that has not proposed anything keeps running

Give a Goal an objective that needs several tool calls. The turn should continue across those calls exactly as before and stop on its own. Only a proposal that the runtime has queued for verification ends a turn early.

### An ordinary turn is unaffected

Run ordinary prompts with no active Goal, including ones that call tools. The tool loop should behave exactly as before.

### A Stop hook continuation also ends

With a blocking Stop hook configured, run a Goal turn that ends quietly and lets the hook start its continuation. If the model proposes completion inside that continuation, the turn should end there rather than looping.

## Local verification

- `cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts`
- Result: passed, 816 tests.
- Removing the fix and re-running the new cases fails them as expected: the two turn-ending cases see a second model request, and the Stop hook case sees a third.
- `cd packages/cli && npx tsc --noEmit -p tsconfig.json`
- Result: no errors in the changed files. Two unrelated TS6305 errors report a core build output missing in a fresh worktree.
- `npx eslint packages/cli/src/acp-integration/session/Session.ts packages/cli/src/acp-integration/session/Session.test.ts`
- Result: passed.
- `npx prettier --check` on the same two files
- Result: passed.

## Not run

The end-to-end daemon run above was not executed in this environment. The behavior is covered at the session tool-loop boundary, which is where the turn was failing to end, using the same Goal runtime host the daemon drives.
