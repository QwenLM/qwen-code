# Local transcript hint after Summary compaction

Issue: [#16437](https://github.com/QwenLM/qwen-code/issues/16437).

1. In a local recording-enabled session, produce a distinctive error in an
   early model turn, then complete an unrelated later turn.
2. Run `/compress`. Inspect the next model request: it should contain a
   single lookup hint with the current transcript directory (`path`) and exact
   JSONL basename (`glob`) before the resume instruction,
   but not contain the older error if the generated summary omitted it.
3. Check the literal `grep_search` arguments: use the hinted directory for
   `path`, the exact basename for `glob`, and a regex for the older error.
   The existing tool should recover the error without matching a sibling
   transcript. Declining access must not be bypassed.
4. After startup context is restored, run another Summary. The previous hint
   must be absent from the summarizer request even when the startup prelude and
   Summary are merged in curated history. The resumed main request still has
   just one current hint. The checkpoint and a copied Summary used by a
   recorder-less chat must not supply either copy of the hint.

The automated CLI witness uses a loopback mock provider and an isolated
transcript, not production credentials or a real model.
