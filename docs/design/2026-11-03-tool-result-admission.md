# Tool result admission on session recovery

[简体中文](2026-11-03-tool-result-admission.zh-CN.md)

## Contract

A completed tool result remains available to the local transcript. A new session recording includes that result in model history only when its admission is recorded. This addresses [#15595](https://github.com/QwenLM/qwen-code/issues/15595), where resuming a session exposed output a `UserPromptSubmit` hook had withheld.

## Recording and recovery

- Each new outer tool completion is marked `requiresToolResultAdmission`. The completion is recorded before the next hook can run. A session can install a hook after the tool finishes.
- A model send past the prompt hook appends a `tool_result_admission` system record referencing the completion UUIDs of the current round. The sender matches the submitted function responses and their companion parts. The receipt records permission for this input independently of whether the provider responds. A host that explicitly ends a tool batch in live history, such as a Goal checkpoint, makes the same decision at that boundary.
- Recovery holds the tool parts in their original positions until the corresponding decision arrives. A missing or invalid receipt exposes no result bytes. A tool-only send cancelled before admission leaves history untouched and reports its error when the caller reads the stream. Senders identify the exact tool-owned parts before adding independent input; cancellation removes those parts, including companion text and images, by object identity. Separately supplied input retains the normal history-push and interrupted-prompt behavior even when its text equals a tool companion. Ordinary prompts and prepared-request replay retain their pre-change cancellation behavior. An explicit ACP block or cancellation after tools finish can close the calls with the same synthetic error as the live session. A process that dies before the decision leaves the calls for existing orphan repair. Separately queued user input keeps its position.
- ACP prompt, cron and background-notification turns pass the completed batch parts into the shared model round. Blocked or cancelled tool-result rounds record the same withholding decision and remove tool-owned companion content while retaining separately queued user input. Each completed result keeps its first valid decision. If setup fails after admission, including during compression, live history retains that admitted result just as recovery does. Previously withheld results retain their original reason. The initial Cron and Notification requests retain their existing hook policy.
- The full and indexed history readers use the same projection. Internal Code Mode results remain outside model history. A compression checkpoint already contains model history and supersedes earlier decisions.

## Compatibility and verification

Pre-change completions lack admission evidence. They keep their prior recovery behavior, including for output withheld in old sessions. Starting with the new writer, a crash between completion and admission can leave the full output available only in the transcript.

Use a local recording model to inspect the first and resumed requests. Block, allow, cancel a pending hook, and kill the process after completion is on disk. Check each call ID, the whole request body, and the relative position of additional user input. The legacy ACP loop also provides a control: it permits ordinary tool results without running the prompt hook on that round.
