# Autofix: runner-level isolation for PAT-bearing steps

Supersedes the in-step approach attempted in PR #9214 (frozen).
Tracks the structural close for issue #9089. Findings inventory: issue #9524.
Adjacent, same question on the review side: issue #9556.

## Problem statement

`review-address` and `issue-autofix` (`.github/workflows/qwen-autofix.yml`) run
**untrusted branch code** and **hold `CI_DEV_BOT_PAT`** in the same job, on the
same OS user, on a persistent self-hosted pool that shares one `HOME` across
~27 runner registrations. In `review-address` the sequence inside one job is:

| Step                             | Executes branch code | Holds the PAT |
| -------------------------------- | -------------------- | ------------- |
| `Triage and address` (agent)     | yes                  | no            |
| `Verification gate` (build/test) | yes                  | no            |
| `Repair …` / `Finalize …`        | partly               | no            |
| `Push and report`                | no                   | **yes**       |

Everything the later step trusts — `$GITHUB_ENV`, `$GITHUB_OUTPUT`,
`$RUNNER_TEMP`, `$HOME`, the workspace `.git`, live processes — is writable by
the earlier steps' code and by any co-resident survivor at the same uid. #9089
enumerates the vectors that execute _before a step's first line_
(`BASH_ENV`, `BASH_FUNC_*`, `LD_PRELOAD`/`LD_AUDIT`) and the runner-provided
shared channels that no in-step `unset` can reach.

### What PR #9214 tried, and what it proved

#9214 ran the verification gate in an ephemeral container and hardened the
surrounding steps: digest chains, type/timeout discipline, env pin blocks,
process-tree sweeps, fingerprint sets, and contract tests pinning all of it.
It did not converge, and two of its results are load-bearing for this design:

1. **The approach is self-defeating at this scale.** Eleven review rounds took
   the diff from 329 to 2,700 lines while the per-round Critical count rose
   8 → 9 → 15 → 19 → 29. Rounds 10 and 11 changed no code at all, and round 11
   still produced 14 new Criticals on byte-identical files — six of them of the
   form _"the site this diff ADDS lacks the discipline this diff installs
   elsewhere."_ Each added guard was the next round's attack surface.

2. **A container around the executor cannot help, because the root of trust is
   outside it** (R11-8). The gate's whole digest chain is rooted in
   `steps.stage.outputs.*`. The runner parses a step's `$GITHUB_OUTPUT`
   last-wins at step _end_, the file lives under attacker-writable
   `$RUNNER_TEMP`, and no sweep of any kind runs before the staging step. A
   same-uid co-resident can swap the staged bytes _and_ append forged digest
   lines that displace the honest ones — both sides of every downstream
   comparison are then attacker-steered. Wrapping the consumer in a container
   changes nothing about that.

Independently: the wrapper could never have run at all post-merge (R9-1: it
digest-verifies a copy of itself that the staging loop never creates; R9-2: the
helper digest is path-dependent and computed over two different path sets), and
CI stayed green because the pre-merge `-z` skip path masks it. That is a
symptom of the same problem — the design had grown past what its tests could
cover.

## Design principle

> A job that has executed branch code must never hold the PAT, and must never
> be able to influence the _inputs_ of the job that does.

The boundary moves from _inside a step_ to _between jobs_, and the channel
between them narrows to one artifact that the consumer re-derives its decision
from rather than trusting.

## Proposed design

### A. Split `review-address` into `execute` and `publish`

**`execute`** — everything that touches branch code: prepare, agent, gate,
repair, artifacts. No `CI_DEV_BOT_PAT`, no write-scoped `GITHUB_TOKEN`, no
push, no PR comment. It emits exactly two things as a job artifact:

- `fix.patch` — `git format-patch`/`git diff` output against the recorded base
  SHA, and
- `report.md` + a plain `verdict.txt` (advisory: what the gate concluded).

**`publish`** — `needs: execute`, **never executes branch code**: no
`npm ci`, no build, no test, no repo script, no hooks. It checks out the base
branch fresh, downloads the artifact, re-derives its own decision (see B),
applies the patch, and pushes with the PAT.

What crosses the boundary is an Actions artifact, not a runner-managed channel.
`$GITHUB_ENV`, `$GITHUB_OUTPUT`, `$HOME`, `$RUNNER_TEMP` and live processes do
not cross a job boundary; a forged line in the execute job's `$GITHUB_OUTPUT`
reaches nothing that the publish job reads.

Hook safety in `publish` is explicit, not incidental: apply with
`git -c core.hooksPath=/dev/null apply --index`, never `git am` with a hostile
`.git`, and never check out the PR head into the publish job's workspace.

### B. The publish job re-derives; it does not trust the verdict

In this threat model the execute job is _assumed compromised_ — it runs branch
code by design. Therefore its verdict is untrusted by construction, and no
signature over that verdict can fix it. What the publish job can do is evaluate
the patch itself, with checks that need no branch execution:

1. the patch applies cleanly to the recorded base SHA;
2. every touched path is inside the PR's declared footprint allowlist;
3. `.github/workflows/**`, `.github/actions/**`, lockfiles, and release
   manifests are refused unless the run was explicitly authorised for them;
4. net added lines are within the round's growth budget (the brake that already
   exists, moved to the trusted side);
5. the commit message matches the Conventional Commit contract;
6. the head SHA still matches the lease recorded before the agent ran
   (`--force-with-lease`).

Every one of these is computed from the **patch text** on the trusted side.
None of them may re-read a value the `execute` job wrote — not a line count it
reported, not a footprint list it declared, not a base SHA it echoed back. This
check class is the one this pipeline has repeatedly failed to make
forgery-proof (it is what R11-8 is about), and it is only sound here because
the input is a file the publish job parses itself. An implementation that
shortcuts to "read the count the gate already computed" reintroduces the whole
problem.

Anything that requires _executing_ the branch (build, typecheck, unit tests)
stays in `execute` and is **advisory**. This is a real reduction in what
"verified" means, and it should be stated plainly in the status comment. The
honest comparison is not against a working guarantee: today's gate verdict is
forgeable (R11-8) and, on the #9214 branch, was never produced at all
(R9-1/R9-2).

Optional defence in depth: `actions/attest-build-provenance` over the artifact
binds _which job produced it_. It does not make a compromised producer's output
trustworthy, so it is additive, not a substitute for (B).

### C. Ephemeral registration for the `execute` leg

The survivor/co-resident class exists because registrations are long-lived and
share `HOME`. Register the pool's autofix runners with `--ephemeral` (one job
per registration, fresh `HOME`), or, where the pool cannot be changed, run
`execute` in a job-level `container:` with a per-job `HOME`. The container is a
mitigation (concurrent legs still share the host kernel and the docker socket);
ephemeral registration is the close.

This is an infrastructure change and is sequenced last — (A) and (B) already
remove the PAT from the shared host, which is the part that matters most.

### D. Kill agent descendants by lineage, not by env marker

Replace the `AUTOFIX_AGENT_TREE` marker sweeps (the source of R8-8, R9-3 and
R11-10) with a cgroup scope per agent invocation — `systemd-run --scope` or a
`cgcreate`/`cgclassify` pair — and kill the cgroup. Cgroup membership is not
forgeable from an environment variable, cross-leg kills become impossible
because each scope is per invocation, and self-kill becomes impossible because
the gate step is not a member of the scope it kills. Where cgroup delegation is
unavailable, `setsid` + process-group kill is a strictly better fallback than
marker matching.

### E. Delete what A–D make redundant

The point of this work is a **smaller** trust surface, not another layer. Once
the PAT is off the shared host and the decision is re-derived on the trusted
side, the in-step enumeration machinery (env pin blocks, staged-script digest
chains, fingerprint sets, marker sweeps and the contract tests pinning them)
protects a boundary that no longer carries a secret. Removing it is part of
this change, not a follow-up: a guard kept "just in case" is the thing that
regenerated findings in #9214.

## Alternatives considered

| Option                                             | Verdict                                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-step hardening (#9214)                          | Rejected — measured non-convergence, and its root of trust sits outside the step (R11-8).                                                                                                                     |
| Sign the verdict in `execute`, verify in `publish` | Rejected alone — signs an untrusted producer's claim. Useful only as (B)'s optional attestation.                                                                                                              |
| Move the whole job to GitHub-hosted runners        | Closes the class outright but loses the pool's cache/network locality and costs minutes.                                                                                                                      |
| Move **only `publish`** to GitHub-hosted           | **Attractive.** The publish job is short, needs no repo cache, and runs no branch code — running it on `ubuntu-latest` removes the shared host from the PAT path entirely. Proposed as step 2 of the rollout. |

## Rollout

1. Land (A) + (B) behind a kill switch (`AUTOFIX_SPLIT_PUBLISH_DISABLED`), with
   `publish` still on the self-hosted pool.
2. Move `publish` to `ubuntu-latest`.
3. Replace the marker sweeps with (D).
4. Ephemeral registrations for `execute` (C) — infra ticket.
5. Delete the machinery (E) that steps 1–4 make redundant, in one PR per
   cluster so each deletion is reviewable on its own.

## Test plan

- **Contract (static, mutation-tested):** the `publish` job's step list contains
  no `npm`, no `run: .*scripts/`, no checkout of the PR head, and no step that
  sources anything from the artifact other than `fix.patch`.
- **Negative control:** a patch touching `.github/workflows/**` is refused by
  the footprint check; a patch exceeding the growth budget is refused.
- **Probe — forged output:** during `execute`, append `outcome=fixed` to
  `$GITHUB_OUTPUT` from a background process; assert `publish`'s decision is
  unchanged.
- **Probe — hostile patch:** a patch that adds `.git/hooks/pre-applypatch` and
  a `core.hooksPath` change; assert no hook executes in `publish`.
- **Probe — lineage kill (D):** start a grandchild that `exec`s with a forged
  `AUTOFIX_AGENT_TREE`; assert the cgroup kill reaps the real tree and spares
  the forger, and that the gate step survives its own sweep.

## Risks and open questions

- "Verified" weakens to "deterministically checked + advisory build/test". This
  must be visible in the PR status comment, not buried.
- Artifact hand-off adds one upload/download per round and a second checkout.
- Does the org permit `--ephemeral` registrations on the ECS pool?
- Is a GitHub-hosted runner acceptable for the PAT-bearing `publish` job under
  the current egress/IP policy?
- `issue-autofix` has the same shape and should follow the same split, but it
  creates a branch and a PR rather than pushing to an existing head; its
  publish-side checks differ and are not designed here. Sequencing constraint:
  that follow-up must land **before** step 5 deletes machinery `issue-autofix`
  still depends on — the deletion pass is per cluster precisely so this can be
  checked one cluster at a time.

<details>
<summary>中文说明</summary>

# autofix：为携带 PAT 的步骤做 runner 级隔离

取代 PR #9214 中尝试的"步骤内加固"方案（该 PR 已冻结）。对应 issue #9089 的结构性收口，发现清单见 issue #9524。评审侧的同一问题见 issue #9556。

## 问题

`review-address` 与 `issue-autofix` 在**同一个 job**里既执行**不可信的分支代码**（agent、构建、测试），又持有 `CI_DEV_BOT_PAT`（`Push and report`），且运行在常驻自建池上——同一 OS 用户、~27 个 runner 注册共享一个 `HOME`。后续步骤所信任的一切（`$GITHUB_ENV`、`$GITHUB_OUTPUT`、`$RUNNER_TEMP`、`$HOME`、工作区 `.git`、存活进程）都可被先前步骤的代码或同 uid 的幸存进程写入。

### #9214 证明了什么

1. **该路线在这个规模上自我挫败：** 11 轮评审把 diff 从 329 行推到 2700 行，每轮 Critical 数量为 8 → 9 → 15 → 19 → 29；第 10、11 轮没有任何代码改动，第 11 轮仍在逐字节相同的文件上产生 14 个新 Critical，其中 6 条的形态是"这个 diff 新加的地方，缺少这个 diff 在别处安装的纪律"。
2. **把执行方装进容器无济于事，因为信任根在容器之外**（R11-8）：整条摘要链的根是 `steps.stage.outputs.*`，而 runner 在步骤**结束时**以 last-wins 方式解析位于可写 `$RUNNER_TEMP` 下的 `$GITHUB_OUTPUT`，且暂存步骤之前没有任何清扫。同 uid 的进程可以同时替换磁盘字节并追加伪造的摘要行，使下游比较的两侧都被操控。

此外该 wrapper 合入后根本无法运行（R9-1、R9-2），而 CI 保持全绿只是因为 pre-merge 的 `-z` 跳过路径把它挡住了。

## 设计原则

> 执行过分支代码的 job 绝不持有 PAT，也绝不能影响持有 PAT 的 job 的**输入**。

边界从"步骤内部"上移到"job 之间"，两者之间只经由一个产物传递，且消费方**自行重新推导**结论而不是信任它。

## 方案

- **A. 拆成 `execute` 与 `publish` 两个 job。** `execute` 承载一切分支代码，不持有任何写权限凭据，只产出 `fix.patch` + 报告 + 仅供参考的 `verdict.txt`；`publish` 全新检出基线分支，**不执行任何分支代码**（无 npm、无构建、无测试、无仓库脚本、无 git hook），下载产物、自行判定、应用补丁并用 PAT 推送。`$GITHUB_ENV`/`$GITHUB_OUTPUT`/`$HOME`/`$RUNNER_TEMP` 与存活进程都不跨 job 边界。
- **B. `publish` 自行推导，不信任 verdict。** 威胁模型中 `execute` 被假定为已失陷，因此对其 verdict 的任何签名都无济于事。`publish` 只做无需执行分支代码的判定：补丁能否干净应用于记录的基线 SHA、路径是否在足迹白名单内、是否触碰 `.github/workflows/**` 与锁文件、净增行是否在增长预算内、提交信息是否符合规范、head SHA 是否仍匹配租约。这些判定**一律基于补丁文本、在可信侧自行计算**，不得回读 `execute` 写出的任何值——它报告的行数、它声明的足迹清单、它回显的基线 SHA 都不行。这一类检查正是本流水线反复未能做到防伪的地方（R11-8 说的就是它），此处成立只是因为输入是发布侧自己解析的一个文件；若实现图省事去读门已经算好的数字，整个问题就原样回来了。构建与测试留在 `execute`，且**降级为仅供参考**——这一点必须写进状态评论。诚实的对比基准不是"原本可用的保证"：现有 verdict 本就可伪造（R11-8），而在 #9214 分支上它根本没被产生过（R9-1/R9-2）。
- **C. `execute` 使用一次性注册（`--ephemeral`）**，或退而求其次用 job 级 `container:` 提供独立 `HOME`；后者是缓解，前者才是收口。属基础设施改动，排在最后。
- **D. 按血缘杀进程树，而不是按 env 标记。** 用 `systemd-run --scope` / cgroup 取代 `AUTOFIX_AGENT_TREE` 标记匹配（R8-8、R9-3、R11-10 的来源）：cgroup 归属无法由环境变量伪造，跨 leg 误杀与自杀都不再可能。
- **E. 删掉 A–D 让其失去意义的机制。** 本项工作的目的是**更小**的信任面，而不是再加一层。PAT 离开共享主机、判定移到可信侧之后，步骤内的枚举式机制（env 固定块、暂存脚本摘要链、指纹集、标记清扫及其契约测试）守护的是一个已不再承载秘密的边界，删除它属于本次改动的一部分——"以防万一"留下的守卫正是 #9214 里不断再生发现的东西。

## 备选方案

步骤内加固（#9214）：否决，已实测不收敛且信任根在步骤之外。仅对 verdict 签名：否决，签的是失陷方的断言。整个 job 迁到 GitHub 托管 runner：能彻底关闭该类问题，但损失缓存与网络就近性且有成本。**仅把 `publish` 迁到 GitHub 托管**：可取——该 job 很短、不需要仓库缓存、不执行分支代码，这样 PAT 路径上就不再有共享主机；列为推进步骤 2。

## 推进顺序

1. 带 kill switch 落地 A + B（`publish` 仍在自建池）；2. 把 `publish` 迁到 `ubuntu-latest`；3. 用 D 取代标记清扫；4. 为 `execute` 启用一次性注册（C，基础设施工单）；5. 按簇分 PR 删除 1–4 让其冗余的机制（E）。

## 测试计划

静态契约（做变异测试）：`publish` 的步骤列表中不得出现 `npm`、`run: .*scripts/`、检出 PR head，或读取 `fix.patch` 以外的产物内容。负向对照：触碰 `.github/workflows/**` 或超出增长预算的补丁必须被拒。探针：在 `execute` 中由后台进程向 `$GITHUB_OUTPUT` 追加 `outcome=fixed`，断言 `publish` 的判定不变；构造包含 `.git/hooks` 与 `core.hooksPath` 的恶意补丁，断言 `publish` 中没有 hook 被执行；伪造 `AUTOFIX_AGENT_TREE` 的孙进程，断言 cgroup 清杀命中真实进程树、放过伪造者，且门步骤不会杀死自己。

## 风险与未决问题

"已验证"会弱化为"确定性检查 + 仅供参考的构建/测试"，必须在状态评论中明示；产物传递增加一次上传/下载与一次检出；ECS 池是否允许 `--ephemeral` 注册；当前出网/IP 策略下，携带 PAT 的 `publish` 能否放在 GitHub 托管 runner 上；`issue-autofix` 形态相同但它是新建分支并开 PR，其发布侧判定不同，本文未涵盖——排期约束是：该后续项必须在推进步骤 5 删除 `issue-autofix` 仍依赖的机制**之前**落地，删除之所以按簇分 PR，正是为了逐簇核对这一点。

</details>
