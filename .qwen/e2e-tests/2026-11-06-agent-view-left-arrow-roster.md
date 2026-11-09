# Agent View: Left-arrow backgrounding and the roster

## Setup

Set `"experimental": { "agentView": true }` in `~/.qwen/settings.json` and start Qwen Code in interactive mode in a scratch folder.

## Scenario

1. Submit `Write a haiku about fence posts.` and wait for the reply.
2. Press Left on the empty prompt. The roster opens with the session under Completed. Its title is the prompt, and its summary is a one-line description of the turn.
3. Press Space. A peek panel shows the session's last result and a reply box.
4. Type `Now one about gates.` and press Enter. The row moves to Working, then back to Completed with a new summary, without leaving the roster.
5. Press Space to close the peek, then Enter. The full session appears immediately with both haikus in its history.
6. Press Left on its empty prompt. The roster returns.
7. Type `List the files in this folder.` in the roster prompt and press Enter. A new row appears and finishes.
8. Type `Fence haiku` and press Ctrl+R. The selected row is renamed. Press Ctrl+T. It moves to the Pinned group.
9. Start a longer task, wait for `Dispatched.`, select it and press Ctrl+X. The notice reads `Stopped. Press Ctrl+X again to remove.` Press Ctrl+X again. The row is removed.
10. Use Up, Down, PgUp and PgDn to move the selection.

## Regression checks

- With `experimental.agentView` unset, Left on an empty prompt does nothing new and Left with text moves the cursor.
- Left while a turn is running reports `Cannot detach Agent View while a turn is running.`
- A session bound to a PR shows `#<number>` before its age.
- A failed session is listed under Failed, below Completed.

## Automated verification

```bash
cd packages/cli
npx vitest run src/ui/agent-view src/agent-view src/commands/agents.test.ts src/commands/agent-session.test.ts src/commands/agent-daemon.test.ts src/ui/commands/background-command.test.ts
npx vitest run src/ui/components/InputPrompt.test.tsx -t "Agent View left arrow"
npx vitest run src/ui/hooks/slashCommandProcessor.test.ts -t "idle exception"
npx vitest run src/utils/relaunch.test.ts -t "roster"
```

## Manual status

Run on Windows 11 (source build on Node 24, and the standalone package on its bundled Node 22) and on Linux (WSL Debian 13, Node 22) in a real pseudo-terminal against a live model. All steps passed. Needs input was not exercised because the run used YOLO approval mode.
