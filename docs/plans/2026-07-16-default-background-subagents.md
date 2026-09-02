# Default Background Subagents Implementation Plan

## Scope

Implement the approved design in
`docs/design/2026-07-16-default-background-subagents.md`: top-level one-shot
subagents default to background execution, `run_in_background: false` opts into
foreground execution, nested and caller-owned `working_dir` launches stay
foreground, and forks plus named teammates keep their existing behavior.

## Steps

1. Record the current global CLI behavior in
   `.qwen/e2e-tests/default-background-subagents.md` by launching a normal
   subagent without `run_in_background` and confirming that it returns inline.
2. Add focused failing unit tests for the new core dispatch precedence:
   omitted flag defaults to background, explicit false stays foreground,
   nested launches stay foreground, and an omitted flag with `working_dir`
   stays foreground.
3. Change the Agent tool's single background-routing decision and update its
   schema description, model-facing guidance, fork comments, and stale tests
   that intentionally depend on foreground execution.
4. Update bundled workflows that require inline aggregation to opt out
   explicitly.
5. Update UI consumers that infer background execution from tool input so an
   omitted flag is classified consistently while explicit foreground,
   `working_dir`, and named teammate calls are not misclassified.
6. Update user and developer documentation for the default and opt-out.
7. Run focused core, Web Shell, Desktop shared-package, and CLI tests, then run
   the repository build and typecheck.
8. Build and bundle the CLI, rerun the E2E scenarios against the branch, and
   record the observed before/after evidence.
9. Review the complete diff twice, fix any findings, rerun affected checks,
   commit the implementation, run the available final PR gate, push, and open
   a draft PR using the repository template.

## Dispatch Precedence

For ordinary one-shot agents, an explicit tool parameter wins over the agent
definition. When the parameter is omitted, `background: true` retains its
existing meaning; otherwise a safe top-level launch defaults to background.
Caller-owned `working_dir` launches default to foreground, while an explicit
background request remains invalid. The final background path is still gated
by the top-level-session check, so nested launches downgrade to foreground.

## Verification Targets

- `packages/core/src/tools/agent/agent.test.ts`
- `packages/web-shell/client/adapters/toolClassification.test.ts`
- `packages/desktop/packages/shared/src/agent/__tests__/tool-matching.test.ts`
- `packages/cli/src/ui/commands/forkCommand.test.ts`
- `npm run build`
- `npm run typecheck`
- bundled interactive/headless E2E scenarios from the test plan
