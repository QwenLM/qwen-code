# Code Mode Goal evidence

[English](goal-code-mode-evidence.md) | [简体中文](goal-code-mode-evidence.zh-CN.md)

## Problem

A Goal verifier used to receive every outer `exec` result as `external_fact`. JavaScript can emit arbitrary text, copy Goal bookkeeping or replace a nested result. Headless and TUI aggregate owners also defer outer recording, leaving the nested scheduler without a recorder. A rewritten wrapper could therefore become the only available account of actual tool work.

This correction addresses the existing evidence mechanism identified while reviewing #13033. Default tool deferral remains a separate change.

## Contract

Script output remains inspectable as `execution_output`. It can support computation; it cannot attest user consent, Goal state, tests, files, tool execution or remote state. Those claims need independently recorded original tool results, and user actions still need `user_input`. Goal bookkeeping remains excluded from work evidence.

## Recording

The shared Goal provenance helper stamps direct and bridged `exec` results as `execution_output`, using invocation identity rather than output text. All existing recording consumers use this helper, including headless, TUI and ACP.

The core scheduler preserves finalized nested results. When an aggregate owner omits its recorder, only a `code_mode` request carrying the parent Goal permit may fall back to the same Config's recorder. It never selects another Config or a primary runtime. Explicit recorders retain their existing ownership. Recording disabled in that Config yields no fallback.

Nested results use subtype `code_mode_tool_result`. Actual read results and errors remain `tool_result`; `get_goal` and `update_goal` remain `goal_runtime`. The outer aggregate records its own result once.

## Evidence and recovery

The evidence window includes original nested work results and classifies outer script output separately. Older direct `exec` records are recognized from their structured response name. Older wrapped results are recognized by the matching Goal-turn function-call identity, including case-insensitive bridge targets. Call IDs from another Goal revision or turn cannot change the classification.

The API-history and shared ACP replay projections skip `code_mode_tool_result`: internal calls have no model-emitted function-call partner. Document exports use the shared replay projection; export normalization and file statistics exclude internal results before matching outer calls. Completed-turn branch checkpoints ignore internal results when tracking pending calls and validating the outer tool loop. The transcript retains them for Goal verification, while resumed model history retains the outer call/result pair. The transcript validator and managed-session sink recognize the new subtype. Current readers accept existing transcript types and older proof kinds; no Goal-state version change is needed. Older binaries do not recognize the new subtype, so restoring a new transcript requires an updated reader.

## Constraints and risks

Permissions, hooks, cancellation, terminal proposal barriers, evidence byte limits and progress counting keep their existing behavior. This adds no execution layer or dependencies. Evidence classification is deterministic, but the final semantic judgement still belongs to the model verifier; it is not a guarantee against every prompt-injection attempt. A bounded window can still omit older facts and must reject an unsupported proposal.

## Validation and acceptance

- A real Exec/Goal runtime/recorder/file-tool regression fails before the correction: the aggregate path has no original nested results. Both direct and deferred outer recording must retain originals without duplicate outer results.
- A script reads a file silently, echoes Goal metadata, swallows a missing-file error, invents a file/test claim and computes `42`. Only the original file result and error are `external_fact`; computation remains available as `execution_output`; Goal bookkeeping is absent from the evidence window.
- Older direct and wrapped script records stay classified as script output, with unrelated-turn facts preserved.
- API history, ACP replay and exports include the outer call/result pair without fabricated internal calls. Document completeness, direct-call file statistics and completed-turn branch checkpoints remain valid while raw internal evidence is retained.
- Focused Goal, Code Mode, recording and history tests, build and typecheck pass. An independent test engineer verifies the bundled CLI's actual headless recording and verifier request, including permission denial and the terminal barrier.

The global CLI baseline is attempted first. An installed version without Code Mode is documented as unsupported; historical native input replay and fresh local CLI verification are reported separately.
