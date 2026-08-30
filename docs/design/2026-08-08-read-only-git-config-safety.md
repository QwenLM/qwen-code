# Read-only Git config safety

Repository-local Git configuration can turn commands that look read-only into program execution. The classifier therefore treats a read-only Git invocation as safe only when the repository configuration cannot activate an executable helper for that invocation.

The config probe uses `git config --includes --show-scope --null --get-regexp`, so Git owns config parsing, includes, precedence, and worktree behavior. Only effective `local` and `worktree` values are considered attacker-controlled execution hooks; probe/parse failures fail closed. Empty helper values are ignored. Boolean `core.fsmonitor` and pager values keep their non-command semantics.

The covered execution paths are:

- `diff.external` and `diff.<driver>.command` for `git diff`.
- `diff.<driver>.textconv` for `git blame`, `git diff`, `git log`, and `git show`.
- command-form `core.fsmonitor` for index/worktree consumers including `git blame`, `git diff`, worktree `git grep`, `git ls-files`, and `git status`.
- `filter.<driver>.clean` / `filter.<driver>.process` for worktree-content consumers (`git blame`, `git diff`, `git status`, and modified-file `git ls-files`).
- command-form `core.pager` / `pager.<cmd>` for Git commands otherwise classified read-only.
- `gpg.program` / `gpg.<format>.program` when effective `log.showSignature` enables signature verification for `git log` or `git show`.
- partial-clone/promisor state for read-only commands that can materialize missing objects and therefore invoke transport or credential helpers during lazy fetch.

`git remote show <name>` is handled structurally rather than by config inspection because it can contact the remote and invoke transport helpers. It is not auto-approved unless `-n` / `--no-query` prevents the query. The same rule is mirrored in the regex fallback classifier.

Commands that change directory before a relevant Git command ask instead of trying to simulate shell cwd state. Parser fallback is deliberately more conservative: when repository config contains any covered execution risk, a fallback-classified Git command asks rather than silently auto-executing.

Leading environment assignments on shell wrappers are also kept visible to the permission layer instead of being stripped before classification, preventing `GIT_CONFIG_* ... bash -c 'git …'` from bypassing repository-config safety checks.
