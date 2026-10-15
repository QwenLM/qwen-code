# Local tool visibility comparison

[English](README.md) | [简体中文](README.zh-CN.md)

This records a bounded local CLI comparison for [#12333](https://github.com/QwenLM/qwen-code/issues/12333). The measured tasks used fewer total tokens with default tool visibility, but did not establish unchanged quality. This is an experiment record and a manual verification procedure, not an automated acceptance gate.

## Recorded experiment

The final fixed-fixture run on 2026-10-09 used production source `4360b003a087fe9e57f6ffbe7ba48795980b59c3`, `kimi-k3`, macOS and Node 22. Nine tasks ran twice per arm, for 36 CLI sessions. A made registered tools visible at startup; B omitted `tools.visible`. Both omitted `tools.eager`, used direct tool mode and `tools.toolSearch.threshold: 0`, enabled Workflow, and disabled memory, hooks, MCP and automatic title work equally. Prompts, input files and capabilities matched; session profiles were isolated. Ordinary initial requests contained 29 versus 11 tool declarations. This measures a visibility configuration difference on one commit, not an isolated before/after measurement of a particular PR.

| Metric                                               | A: startup visible | B: default visibility |
| ---------------------------------------------------- | -----------------: | --------------------: |
| Task results meeting all requested conditions        |              18/18 |                 16/18 |
| Provider requests, including child work and failures |                 63 |                    65 |
| Input tokens                                         |            988,725 |               688,502 |
| Output tokens                                        |             10,149 |                10,445 |
| Input + output                                       |            998,874 |               698,947 |
| Cached input                                         |            922,624 |               590,848 |
| Uncached input                                       |             66,101 |                97,654 |
| Tool calls                                           |                 44 |                    46 |
| Tool searches                                        |                  6 |                     8 |
| Invalid-parameter calls                              |                  0 |                     1 |

Total input + output decreased **30.03%**. B's uncached input increased, and provider caches were uncontrolled; this does not establish billing savings. Foreground Agent cost was effectively unchanged: 123,215 → 123,126 tokens.

Both B Agent sessions executed the child task and computed `TOTAL=63`, but the parent added prose despite the requested result-only format. One B Goal session attempted a call before loading its schema; it was rejected with `invalid_tool_params`, then recovered. Those are two task-format failures and one separate call-quality failure. They remain failures; no concrete production-code cause was established for the format differences.

All eight safety sessions, four Goal results and four saved Workflow executions passed. Workflow was startup-visible in both arms, so this does not prove deferred Workflow recall. Safety cases disabled tool registration under yolo approval; they did not test permission-deny policy.

The first suite is retained separately: original outcomes A 14/18 and B 12/18, total tokens 969,739 → 783,840. It contained path/schema-check false negatives and two real fixture changes through still-enabled `monitor`. The second suite corrected that fixture in both arms. Do not average these different configurations or discard failed attempts.

The [published report](https://github.com/QwenLM/qwen-code/pull/13767#issuecomment-6079794031) records per-task results and provenance. The historical experiment used a temporary forwarding proxy to reconcile all 128 attempts against native records. A later offline classifier correction counted the previously missed invalid-parameter call without changing tokens or task outcomes; no new provider run followed that correction. Original logs and failed runs remain local; they are not bundled with these docs. The experimental runner is retained in PR history at `82f1f057cfe17e573ae465958b95c14d0d95d196`, not maintained as a repository command.

## Repeat a small comparison with existing tools

1. Pin one CLI version or source commit and one model. Prepare two disposable copies of the same small workspace and isolated settings profiles. Keep provider, permissions, hooks, memory and enabled capabilities identical. Change only the visibility configuration being evaluated; record the exact settings rather than changing the user's normal profile.
2. Choose a few normal tasks: dialogue, reading and aggregating a file, a Shell operation, and a multi-step edit. Add Agent or Goal only when evaluating those capabilities. Fix the prompts, inputs and expected file/result checks before running either arm; do not tell the model which discovery tools to call.
3. Run each task in a fresh session in both arms, alternating A/B order on repetition. Use the existing headless CLI and API logging options for an OpenAI-compatible provider, for example:

   ```bash
   qwen --model <model> --output-format json --chat-recording=true \
     --openai-logging --openai-logging-dir <private-log-directory> \
     -p '<same task prompt>'
   ```

4. Check the actual answer, files and tool execution in the conversation record. Keep format errors, refused calls and recoveries visible. Compare initial request declarations to confirm that the intended A/B difference took effect.
5. Record provider-reported input, output and cached tokens for the whole task, including child work, extra rounds and failed attempts. A parent summary alone does not establish complete accounting. If existing logs omit an attempt or its usage, report incomplete coverage; never treat missing usage as zero or label partial totals as whole-task savings. Keep raw logs private and publish only sanitized results.

The command illustrates existing capture options; it does not set up A/B isolation or validate results automatically, and it does not reproduce the historical nine-task suite by itself. Use the existing [integration-test helper](../../../integration-tests/test-helper.ts) for a repeatable regression once a concrete defect is identified, and the existing [telemetry](../../developers/development/telemetry.md) for recorded usage and tool events. The initial docs-only scope correction did not rerun the provider; the later targeted runs are recorded below.

## Bounded follow-up on 2026-10-13

Two source-CLI sessions at `c2f5ce45b156` used the historical B configuration and the same model/prompts. Native requests confirmed 11 initial declarations, including `tool_search`/`tool_call` while Agent and Goal tools remained hidden. Agent returned exactly `TOTAL=63`; that format failure did not recur in this one sample. Goal repeated the premature `tool_call(get_goal)`, was refused, then searched the schemas, ran the verifier and completed. Both the startup reminder and Goal continuation already instructed schema review before invocation. The ordering error is reproducible model behavior; these observations do not identify a missing instruction or a production-code fix. The refusal remains a call-quality failure, even though the task recovered.

Four preliminary sessions through isolated global `qwen` used its base 0.24.0 installation rather than the normal profile's auto-updated 0.25.0. They completed but exposed Agent/Goal directly, so they do not verify the deferred bridge. They are excluded from that conclusion. No new A/B cost comparison was performed, and no production change was made from these observations.

## Remaining acceptance

The evidence supports lower token totals for this fixed sample. It does not establish general recall parity, priced savings or standard-suite acceptance. #12333 remains open: compare representative tasks and any separately chosen settings overlay through existing evaluation paths. A newly reproducible product defect should get a small focused regression and fix; expanding a custom evaluation framework is not a prerequisite for local verification.
