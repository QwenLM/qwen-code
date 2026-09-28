# PreToolUse `updatedInput`

## Baseline

No global `qwen` is installed on the verification host, so the baseline is a
local bundle of `main` run against the integration-test fake OpenAI server
(`integration-tests/fake-openai-server.ts`) with an isolated `HOME`. The fake
model calls `run_shell_command` with `echo original-from-model`, and a user
PreToolUse hook on `run_shell_command` returns
`hookSpecificOutput.updatedInput` with the command set to
`echo rewritten-by-hook`. On `main` the hook output is ignored: the shell runs
`echo original-from-model` and PostToolUse receives the original input.

## Manual check

1. In `~/.qwen/settings.json`, add PreToolUse and PostToolUse command hooks with
   matcher `run_shell_command`. The PreToolUse hook prints
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"echo rewritten-by-hook","description":"say hi"}}}`;
   both hooks append their stdin to a log file.
2. Run `qwen -p "run it" --approval-mode yolo` against a model that calls
   `run_shell_command` with `echo original-from-model`.
3. Verify the tool result sent back to the model reads
   `Command: echo rewritten-by-hook` and `Output: rewritten-by-hook`, and that
   the PostToolUse log entry has `tool_input.command` set to
   `echo rewritten-by-hook`.
4. Change the hook to return `"updatedInput":{"description":"no command"}` and
   verify the tool does not run and the model receives
   `params must have required property 'command'`.
5. Change the hook to also return `"permissionDecision":"ask"`, run the prompt
   in an interactive session, confirm the prompt, and verify the rewritten
   command runs.
6. Remove `updatedInput` from the hook output and verify the model's command
   runs unchanged.

## Automated coverage

`toolHookTriggers.test.ts` pins that `updatedInput` is returned for allow, no
decision and ask, dropped for deny, and ignored when it is not an object.
`hookRunner.test.ts` pins that a sequential hook receives the previous hook's
`updatedInput` as `tool_input`. `coreToolScheduler.test.ts` pins that the tool
runs with the new input and PostToolUse receives it, that an invalid input fails
the call with `INVALID_TOOL_PARAMS` without running the tool, and that an
approved ask runs with the new input. `Session.test.ts` pins the same for the
ACP path.
