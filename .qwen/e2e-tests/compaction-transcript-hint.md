# Local transcript hint after Summary compaction

Issue: [#16437](https://github.com/QwenLM/qwen-code/issues/16437).

1. In a local recording-enabled session, produce a distinctive error in an
   early model turn, then complete an unrelated later turn.
2. Run `/compress`. Inspect the next model request: it should contain a
   single lookup hint naming the active `.jsonl` before the resume instruction,
   but not contain the older error if the generated summary omitted it.
3. Check that the existing `grep_search` tool can recover the error under the
   existing access policy. Declining access must not be bypassed.
4. After another Summary, the request should still contain only one hint.
   The persisted checkpoint, a new recording-disabled chat, and a copied
   summary used by a child chat must never supply the old path as a hint.

The automated CLI witness uses a loopback mock provider and an isolated
transcript, not production credentials or a real model.
