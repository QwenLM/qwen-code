# pnpm Stage 2 go/no-go evidence

The post-Stage 1 review on
[#10444](https://github.com/QwenLM/qwen-code/issues/10444#issuecomment-5630188013)
recommends holding Stage 2 (pnpm for development and CI) until two
measurements exist. Neither could run on the machine that wrote this brief,
because it does not run builds or test suites. Every number below that is not
marked as measured comes from #10444 and has not been reproduced here.

Report results as a comment on #10444, then add a `results.md` next to this
file.

## Already measured

On `main` at `642d36e`, Linux, Node 22.23.2, pnpm 11.24.0:

- Two consecutive `corepack pnpm import` runs produced byte-identical
  `pnpm-lock.yaml` output, about 51 s each with a cold metadata cache.
  `corepack pnpm install --frozen-lockfile --lockfile-only` accepts the
  result.
- After the import, every `name@version` in `pnpm-lock.yaml` is also locked
  in `package-lock.json`, except `mime-db@1.52.0`. That exception is a gap in
  the npm lockfile; `scripts/check-lockfile.js` explains it.

## 1. Per-worktree disk on the hosts that run worktrees

**Premise under test:** pnpm's 93% disk saving (1,472 → 99 MiB per worktree)
depends on a copy-on-write filesystem, because `packageImportMethod` is
`clone-or-copy`. On ext4 the saving should shrink to roughly 1.47 → 1.2 GiB.
A reflink clone of the primary checkout's `node_modules` should match pnpm on
CoW filesystems without pnpm.

Run this on every host class that creates worktrees: the ECS runner hosts and
developer Macs.

1. Record the filesystem. On Linux, run `df -T <repo>`. On macOS, run
   `diskutil info / | grep Personality`.

2. Prepare three fresh worktrees of the same commit from the primary
   checkout. The primary checkout must already have a completed `npm ci`.
   Warm the pnpm store once, in a throwaway worktree, before measuring.

3. For each method below, record the change in the `df` used column and the
   wall time. Use `df`, not `du`: `du` counts cloned files at full size.

   | Method       | Command in the new worktree                                                                                                                                                                                                                 |
   | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | npm          | `QWEN_SKIP_PREPARE=1 QWEN_SKIP_NOTICE_GENERATION=1 npm ci --prefer-offline` (the guard pair `scripts/setup-worktree.js` sets, so the step only installs dependencies)                                                                       |
   | pnpm         | `node scripts/setup-worktree.js`                                                                                                                                                                                                            |
   | reflink copy | copy the primary's `node_modules` and every workspace root's own — `packages/*/node_modules`, `packages/channels/*/node_modules`, `integrations/*/node_modules` — using `cp -c -R` on APFS or `cp -R --reflink=always` on btrfs/XFS reflink |

4. For the reflink copy, confirm the workspace links point into the new
   worktree:
   - `readlink node_modules/@qwen-code/qwen-code-core` prints
     `../../packages/core`.
   - `node -p "require.resolve('@qwen-code/qwen-code-core/package.json')"`,
     run in the worktree, prints a path inside that worktree.
   - `node -p "require.resolve('@larksuiteoapi/node-sdk/package.json', { paths: ['packages/channels/feishu'] })"`
     prints a path inside that worktree. The two checks above resolve
     through the root `node_modules/@qwen-code/qwen-code-core` symlink, so
     they pass even when a nested workspace root's `node_modules` was not
     copied; this one does not.

5. Record the peak number of concurrent worktrees per host over a week:
   sample `git worktree list | wc -l` at most 5 minutes apart (for example
   with cron) and keep the maximum. Worktrees on these hosts can live for
   under an hour — review worktrees under `.qwen/tmp` are created and swept
   within a single run — so a daily sample reports the floor between runs,
   not the peak.

**Report:** a table of host, filesystem, method, `df` delta and wall time;
the peak concurrent worktree count; and free disk per host.

**Decision this feeds:** disk alone justifies Stage 2 only if the peak count
times the npm delta exceeds the host's disk budget, and the reflink copy is
not an option on that filesystem.

## 2. Hoisted parity: the CI matrix on a pnpm-installed tree

**Premise under test:** with `nodeLinker: hoisted`, the existing npm scripts
run unchanged on a pnpm-installed tree. Stage 2 would then need almost no
script changes.

1. On a scratch branch, create a throwaway workflow: a copy of
   `.github/workflows/pnpm-worktree-smoke.yml` restricted to
   `on: workflow_dispatch`, a single `runs-on: ubuntu-latest` job (no
   matrix), and `timeout-minutes: 150`. Do not edit the smoke workflow
   itself — its job runs on three operating systems under a 20-minute
   ceiling the chain below far exceeds, and the scripts tests assert it
   contains no build step. After the install step, add `npm run build`,
   `npm run typecheck`, `npm run lint:ci`, `npm run test:ci`,
   `npm run bundle`, and `npm run check:serve-fast-path-bundle`.
2. Run the workflow with `gh workflow run <workflow-file> --ref <branch>`.
3. Repeat the run with the install step replaced by
   `QWEN_SKIP_PREPARE=1 QWEN_SKIP_NOTICE_GENERATION=1 npm ci --prefer-offline`,
   the same guard pair `scripts/setup-worktree.js` sets — a bare `npm ci`
   also runs the root `prepare` (husky, `npm run build`, `npm run bundle`)
   inside the step being timed. This is the npm baseline on the same runner
   class.

**Report:** pass or fail and duration for each step under both installers,
the first failure's log for any step that fails only under pnpm, and the
install step duration for each installer.

**Decision this feeds:** the real Stage 2 change surface, and the CI time
benefit. Do not extrapolate that benefit from the worktree benchmark.

## Claims these results may contradict

- The ext4 per-worktree estimate of about 1.2 GiB, which comes from the
  AGENTS.md note.
- "npm scripts run unchanged on a hoisted pnpm tree."
- The recommendation to freeze at Stage 1.
