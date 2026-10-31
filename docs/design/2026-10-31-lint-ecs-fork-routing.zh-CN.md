# Lint & Static 对所有 Pull Request 的 ECS 路由

[English](2026-10-31-lint-ecs-fork-routing.md) | [简体中文](2026-10-31-lint-ecs-fork-routing.zh-CN.md)

状态：已在 PR #15974 实现（2026-10-31）。决策负责人：jinjing（维护者）；欢迎第二位维护者确认风险接受，已作为开放问题记录在文末。

## 问题

Lint & Static 车道对仓内分支、OWNER/MEMBER/COLLABORATOR 账号的 fork PR、push main 以及 merge queue 早已跑在自托管 ECS 池上。只有无 write 权限贡献者的 fork PR 还在 GitHub 托管 runner 上排队。60 个 PR 的样本（2026-10-31）中，12 个（约 20%）在为一条 self-hosted 路径早已完备且每天被验证的车道付 hosted 排队时间。

## 现状（变更前）

`classify_pr` 的 `pick_runner` 步骤只发布一个路由输出 `ubuntu_runner`，被所有 Linux 车道（`test`、`lint_and_static`、集成测试车道）消费。其 association 门禁让不可信 fork PR 留在 `ubuntu-latest`。该门禁是流量默认值，不是强制隔离墙：`pull_request` 运行执行的是 PR 自己的 workflow YAML，fork 本就可以改写 `runs-on` 混进池里（受首次贡献者 workflow 审批约束）。车道本身的 self-hosted 适配早已完备：预装 Node、持久 npm 缓存、磁盘下限门、工作区清扫、90 分钟池上限。

## 目标

- 对所有 pull request 把 Lint & Static 路由到 ECS 池，消除不可信 fork 的 hosted 排队。
- 其他所有车道的 association 门禁保持可证明地不变。
- 维护者 kill switch（`MAINTAINER_ECS_RUNNER_DISABLED=true`）与 `LINUX_RUNNER_FLEET=hosted` 仍能一个变量把车道退回 hosted；尊重 ARM64 fleet 选择器。

## 非目标

- 不做隔离 fleet、专用 fork label 或一次性主机。
- 不把 lint 车道容器化（考虑过并否决——见设计决策）。
- 不改 `test`、集成测试车道、浏览器 smoke、Windows/macOS 车道的路由。
- 不在全局 kill switch 之外增加 lint 专属的 hosted 逃生口（池利用率 8–10%，全局开关已是记录在案的兜底）。

## 方案

`pick_runner` 发布第二个输出 `lint_runner`。除 `pull_request` 事件外处处等于 `ubuntu_runner`；在 `pull_request` 下对的所有作者 association 都路由到所选 fleet。`lint_and_static` 的 `runs-on` 与 `timeout-minutes` 同读 `lint_runner`，上限始终按实际落点计价（self-hosted 90 分钟、hosted 45）。`classify_pr` 自身及其他所有车道继续读带 association 门禁的 `ubuntu_runner`。

由于该车道现在会在持久共享主机上执行不可信 fork 代码，它同时采纳了兄弟车道早已钉在 PR 代码步骤上的 per-job HOME 隔离：

- job 级 `HOME: ${{ runner.temp }}/qwen-lint-home`，由 `Create per-job HOME` 步骤在清扫步骤写入全局 git 配置之前创建。PR 代码无法再植入 `~/.gitconfig`（`core.hooksPath`、`core.fsmonitor`）或 `~/.npmrc` 状态让同一 runner 注册上后续的可信 job 继承。
- self-hosted npm 缓存步骤通过 `getent passwd` 取 runner 账号的真实 home，把 `NPM_CONFIG_CACHE`、`XDG_DATA_HOME`（pnpm store 落回其 Linux 默认路径）、`COREPACK_HOME` 显式指回共享位置，安装保持热缓存。pnpm 按 lockfile 对 store 读取做完整性校验；PR 代码对共享 store 的写入无法静默替换包。

## 设计决策与理由

1. **两个输出，而不是放开共享门禁。** 分歧是显式的，并被双向钉住：`ci-runner-routing.test.mjs`（lint 下所有 association 上池；共享输出保留门禁）与 `ci-platform-lanes.test.js` 的 `runs-on` 字面量钉（包括 `test`——被删除的 lint==test 相等断言曾传递性地钉住它）。把两个输出"简化"回一个会直接红。
2. **per-job HOME，而不是容器。** `qwen-triage` 的 `tmux-testing`/`verify` 用 `container: node:22-bookworm` 包裹 PR 代码。本车道考虑过该路径并否决：车道自己的 `Restore workspace ownership` 步骤正是因为容器化 job 在这些主机上留下 root 属主残留物而存在，再加一条容器化车道会加重该问题；pnpm store/bundle 缓存行为也需要在池上重新验证。per-job HOME 以几行成本关闭了自动配置继承这一类（R1-1 Critical）；它不是沙箱，下文残余的同机暴露面仍属接受范围。
3. **热共享缓存，而不是冷 per-job 缓存。** 该池上冷 pnpm store 实测安装 892s 对热缓存 347s；每个 PR 都付这个成本会抵消去排队的目标。pnpm 11 不认 `npm_config_store_dir` env（已实测），且 install 步骤的命令被 shared-prelude 守卫钉成与 `test` 逐字段一致，因此通过平台标准的 `XDG_DATA_HOME` 重指 store，而不是加 flag。
4. **接受记录。** 维护者（jinjing）于 2026-10-31 评审并接受共享池代码执行风险，边界变更仅限 Lint & Static 一条车道。接受范围是该车道内 PR 代码在池上执行；上述 HOME 隔离在 review 第 2 轮加入，把跨 job 持久化排除在 fork 运行可留下的东西之外。

## 约束

- `pull_request` 运行执行 PR 的 YAML；对改写它的 fork，任何 `runs-on` 信任条款都不可强制。路由是默认值，GitHub 的首次贡献者 workflow 审批仍是外层门。
- 池上多个 runner 注册共享同一 OS 用户；同机 job 之间没有进程隔离。
- `lint_and_static` 是必需状态检查；其 hosted 回退只有全局 kill switch 与 fleet 变量。

## 风险

- **同机暴露是具体可达的，不是理论上的。** `publish-tmux` 在该池上持有 `CI_BOT_PAT`、未容器化、`runs-on` 无信任门禁；同 UID 进程可读 `/proc/<pid>/environ`。一个在 90 分钟上限内空转的 lint 步骤可以扫描这类窗口并在连续 fork PR 中重试。本车道接受；结构性解法是隔离 fleet（非目标）。
- **云 metadata。** 若池实例绑定了 RAM 角色，任何 job 进程都可访问 metadata 端点。建议 fleet 侧开启 metadata 加固模式，与本 workflow 变更独立。
- **共享包 store。** PR 代码可写共享 pnpm store/npm 缓存；对 frozen lockfile 的完整性校验把该面限制在拒绝服务（重新拉取），而非静默包替换。
- **`/tmp` inode 耗尽。** 池的 tmpfs `/tmp` 有约 100 万 inode 上限，磁盘下限门未覆盖（它查工作区与 `RUNNER_TEMP` 挂载）。2026-10-31 `ecs-qwen-hz1-9` 上的一次 lint 失败即此类。后续：把下限门扩到 `os.tmpdir()` 并清理主机 `/tmp` 积压。

## 验证计划

- `node --test .github/scripts/ci-runner-routing.test.mjs`：真实 `pick_runner` shell 在全 association/事件矩阵下执行，含 `GITHUB_OUTPUT` 发布断言。
- `scripts/tests/ci-platform-lanes.test.js`：lint 与 test 的 `runs-on` 字面量钉、按各 job 自身路由输出求值的 timeout 上限、HOME 隔离守卫（删除 HOME 覆盖或回退缓存推导即红）、以及带缓存步骤字段豁免的 shared-prelude 漂移守卫。
- PR 自身 CI 在池上验证管道（作者是 collaborator，该运行中 `lint_runner == ubuntu_runner`）；分歧本身由回归矩阵证明，其首个线上端到端见证是下一个不可信 fork PR。

## 验收标准

- 所有 pull request 的 Lint & Static 落在所选 ECS fleet；Test 与集成测试车道保留 association 门禁（已钉）。
- kill switch 与 hosted-fleet 覆盖把车道退回 hosted（已钉）。
- 车道运行在 per-job `runner.temp` HOME 下并使用热共享缓存（已钉）。
- 双语设计记录与修正后的 `qwen-autofix.md` 前提同 PR 交付。

## 开放问题

- 第二位维护者对风险接受的确认（triage stage-3 因此暂缓；这是人的决定，不是代码变更）。
- 首个不可信 fork PR 作为分歧的线上端到端见证。
- 另行拥有的后续：磁盘下限门覆盖 `/tmp` inode；fleet metadata 加固；若重新审视已接受的残余暴露面，则建隔离 fleet。
