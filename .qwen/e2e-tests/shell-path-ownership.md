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
5. Compare bare `time` with `'time'`, `"time"`, `\time`, `$'time'` and `ti''me`. Quoted or escaped `-p` is an executable name, not an option. Repeated `time` and bare `time --` must retain cwd uncertainty because Bash 3.2 and newer Bash disagree.
6. Keep the operand after process or command substitution in the same word, and ignore parentheses and quotation in comments. Array assignment elements do not execute. Case arm delimiters cannot close a function or brace group; unmodelled case control flow keeps cwd uncertain.
7. Define functions with bare, quoted and non-identifier names. Defining a function must not run its body's cd in the parent, while a plain foreground brace group still shares cwd.
8. For cp, mv, install and ln, preserve the real destination beside suffix values and boolean flags. A value-taking short option owns the rest of its cluster or the next argument. The existing `-rt` target-directory control remains precise.
9. In both shell and Monitor, submit a wrapper whose outer HOME expansion lands inside single quotes in its decoded script. It must not be certified as a literal `$HOME` filename. Also combine a produced backslash, expansion and a second quoted fragment containing a redirect; the write must remain visible. Include a quote-spliced expansion and preserve the literal different-name control. Repeat using an alternative payload after an unresolved option-terminator word.
10. Keep controls for literal dollars, different variable names, known deny rules beside an unresolved operation, ANSI-C byte targets, extended-glob parentheses and the group-depth budget. Repeat an ordinary literal-path analysis after a wrapper analysis to check that expansion state does not leak.

## Focused source command

From `packages/core`:

```bash
npx vitest run src/permissions/shell-semantics.test.ts src/permissions/permission-manager.test.ts src/permissions/autoMode.test.ts src/permissions/rule-parser.test.ts src/utils/shell-utils.test.ts src/core/coreToolScheduler.test.ts
```

Record the candidate revision, actual collected count, shell version, cwd/HOME isolation, build result and CLI approval events. Keep source tests, native shell observations, packaged CLI validation and ACP validation as separate evidence.

## 2026-11-18 R15 addendum

11. Ordinary read-only globs such as `grep -rn foo src/*.ts` must reach the AUTO classifier and remain allowed under broad rules. Variable expansion, undecodable bytes and unresolved write targets retain the deterministic human-approval floor. Spaced `>& 2`, `2>& 1` and `<& 0` duplicate descriptors without creating a numeric filename; plain `> 2` still writes the file named `2`.
12. Extract real operations from multi-command `$()` and backtick payloads. Keep case and conditional bodies isolated from the enclosing cwd, including `time` and `!` prefixes. Parameter-expansion comments and earlier HOME/CDPATH assignments must not certify a path Bash does not use. A later absolute cd may clear dynamic-cd uncertainty but not structural uncertainty.

The R15 candidate has 1,375 passing tests across the four directly affected permission files, and 2,137 passing tests when shell-utils and the real tool scheduler are included. Native Bash 3.2.57 observations used an isolated evidence fixture and confirmed the protected write/removal locations. Full build and packaged CLI verification remain pending because the current checkout has unrelated dependency type errors in external-context, diff, glob and zod consumers; the changed files themselves have no core TypeScript errors. ESLint passes. No packaged CLI or ACP result is claimed.

## 2026-11-18 R16 addendum

13. Default Bash-rule splitting must retain command boundaries inside backticks. Group-aware scanning must distinguish parameter braces, substitution comments and case-arm delimiters from real group boundaries. A quoted wrapper positional argument is not an additional executable payload.
14. Preserve pipeline state across empty newline segments, pair groups whose closing segment is unmodelled, and keep wrapper suffix substitutions visible beyond the certainty depth threshold. Bare `!` runs the following simple command. `eval`, `source` and `.` require dynamic cwd treatment.
15. HOME/CDPATH mutations include export, declaration, unset and assignment segments with redirects. Explicit tilde cd targets, tilde writes and nested substitutions inherit that uncertainty, including a possible pipeline-final mutation. Unresolved mv, cp, install, ln, sed, perl, truncate and tee destinations produce uncertain operations. Process substitutions execute their payloads without inventing file operands.
16. Preserve the existing case-arm and fd-close controls. A case pattern close must not close its surrounding subshell. A dynamic tee operand after an fd close remains visible alongside the conservative redirect operation.

All 30 new R16 regressions were run against the parent production files and failed, then passed after the fixes. The final six files contain 2,167 passing tests, including the real scheduler. Changed-file ESLint and Prettier pass. Core typecheck still reports the same 17 unrelated diff, glob and zod errors; no full build, packaged CLI or ACP result is claimed.
