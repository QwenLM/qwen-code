# Read-only Git config safety

Repository-local Git configuration can turn commands that look read-only into program execution. The classifier therefore treats a read-only Git invocation as safe only when the repository configuration cannot activate an executable helper for that invocation.

The config probe uses `git config --includes --show-scope --null --get-regexp`, so Git owns config parsing, includes, precedence, and worktree behavior. Only effective `local` and `worktree` executable values are considered repository-controlled execution hooks; probe/parse failures fail closed. Empty helper values are ignored. Boolean `core.fsmonitor` and pager values keep their non-command semantics, and Git boolean consumers use Git's true semantics (textual true values or any non-zero integer).

The covered execution paths are:

- `diff.external` and `diff.<driver>.command` (including an empty driver subsection such as `diff..command`) for `git diff`.
- `diff.<driver>.textconv` for `git blame`, `git diff`, `git log`, and `git show`.
- command-form `core.fsmonitor` for index/worktree consumers. Broad worktree/index risks use a default-deny consumer model so newly discovered Git flags do not silently create new auto-approval entrances; this covers, among others, `git blame`, `git diff`, worktree `git grep`, `git ls-files`, `git status`, and dirty/broken `git describe` paths.
- `filter.<driver>.clean` / `filter.<driver>.process` for worktree-content consumers. These also use the default-deny consumer model rather than a list of only currently known flag spellings, covering `git ls-files` option abbreviations and dirty/broken `git describe` paths.
- command-form `core.pager` / `pager.<cmd>` for Git commands otherwise classified read-only.
- `gpg.program` / `gpg.<format>.program` when effective `log.showSignature` enables signature verification for `git log` or `git show`, and repository-local `format.pretty` / `pretty.<name>` formats containing `%G*` signature placeholders.
- partial-clone/promisor state (`extensions.partialClone`, `remote.<name>.promisor`, and `remote.<name>.partialCloneFilter`) for commands that can materialize missing objects and therefore invoke transport or credential helpers during lazy fetch. Promisor handling is default-deny; only the narrowly proven commit-only `git log -1` / `--max-count=1` form remains auto-approved.
- `merge.<driver>.driver`, together with remerge-capable `git log` / `git show` paths. `--remerge-diff` and `--diff-merges=remerge` are also recognized directly as helper-capable options.

`git remote show <name>` is handled structurally rather than by config inspection because it can contact the remote and invoke transport helpers. It is not auto-approved unless `-n` / `--no-query` occurs before the `--` option terminator and therefore really prevents the query. The same rule is mirrored in the regex fallback classifier.

Commands that change directory before a relevant Git command ask instead of trying to simulate shell cwd state. Parser fallback is deliberately more conservative: when repository config contains any covered execution risk, a fallback-classified Git command asks rather than silently auto-executing. The fallback checks `Object.values(risk).some(Boolean)` so future risk fields cannot be accidentally omitted from its fail-closed gate.

Leading environment assignments on shell wrappers are kept visible to the default permission path instead of being stripped before classification, preventing `GIT_CONFIG_* ... bash -c 'git …'` from bypassing repository-config safety checks in the absence of an explicit matching permission rule. Explicit user-configured `Bash(...)` allow rules are a separate authorization layer and can intentionally override the default `ask` decision; this PR does not change that pre-existing rule-matching behavior.
