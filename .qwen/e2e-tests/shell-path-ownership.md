# Shell path ownership and human approval

## Baseline and current coverage

Parent source: `840388d3a99a19b3fd2177758d06223fcdbe6424`. The new source tests were observed failing before the fixes. Native Bash probes used an isolated workspace and HOME to verify subprocess cwd, wrapper expansion and `find` option behavior.

A global `qwen` executable was not found on the current PATH, so no global CLI dry run is claimed. The full matching build and packaged CLI run remain pending. The scheduler regression uses the real scheduler with a test tool and hook bus; it does not execute the command text. ACP consumer behavior was traced in source, not exercised end to end.

## Safe fixture

Create a fresh temporary directory inside the repository's `.artifacts/`. Give it separate `work`, `work/.qwen`, `work/.qwen/nested`, `work/target`, `work/$D` and `home` directories. Set HOME and cwd to those fixture paths. Seed only harmless marker files, use a test provider, and do not load the operator's configuration or startup files.

Build the matching source using the documented build and bundle commands once the environment and storage gates permit it. Run all scenarios in that isolated fixture. Do not use an older installed bundle as proof for the candidate source.

## Scenarios

1. In AUTO mode, submit a write to an unresolved variable or undecodable ANSI-C filename. Configure the fixture's `PermissionRequest` hook to return `allow`. The call must remain awaiting human approval, the classifier must not approve it, the confirmation must omit persistent allow choices, and the marker must not exist. Repeat with an explicit ask rule. Proceed-once may execute only after the operator accepts.
2. With broad Bash and file allow rules, submit `find $D -name marker`, `find "$D" -name marker` and the same targets after `-H`, `-L` and `-P`. An unresolved starting point must not be certified as cwd. Literal `find '$D'` and `find src` retain their literal targets.
3. Submit harmless writes after `(command cd .qwen)` and `A=1 cd .qwen | cat`. The outer write remains under the original cwd. A write inside the subshell follows its own cd. Nested subshells restore each enclosing cwd. A final pipeline cd must not certify a shell-independent parent cwd.
4. Check foreground brace groups, background brace groups and background conditional lists. Foreground brace cd persists; background cd does not escape. A group output redirect is attributed to its entry cwd, not the cwd after its body runs.
5. Compare bare `time` with `'time'`, `"time"`, `\time`, `$'time'`, `ti''me` and repeated `time`. Only a real reserved-word prefix may propagate the following builtin cd.
6. In both shell and Monitor, submit a wrapper whose outer HOME expansion lands inside single quotes in its decoded script. It must not be certified as a literal `$HOME` filename. Also combine a produced backslash, expansion and a second quoted fragment containing a redirect; the write must remain visible. Repeat using an alternative payload after an unresolved option-terminator word.
7. Keep controls for literal dollars, different variable names, known deny rules beside an unresolved operation, ANSI-C byte targets, extended-glob parentheses and the group-depth budget. Repeat an ordinary literal-path analysis after a wrapper analysis to check that expansion state does not leak.

## Focused source command

From `packages/core`:

```bash
npx vitest run src/permissions/shell-semantics.test.ts src/permissions/permission-manager.test.ts src/permissions/autoMode.test.ts src/permissions/rule-parser.test.ts src/utils/shell-utils.test.ts src/core/coreToolScheduler.test.ts
```

Record the candidate revision, actual collected count, shell version, cwd/HOME isolation, build result and CLI approval events. Keep source tests, native shell observations, packaged CLI validation and ACP validation as separate evidence.
