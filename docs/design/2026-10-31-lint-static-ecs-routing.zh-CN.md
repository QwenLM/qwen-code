# Lint & Static 对所有 pull request 走 ECS 池

[English](2026-10-31-lint-static-ecs-routing.md) | [简体中文](2026-10-31-lint-static-ecs-routing.zh-CN.md)

2026-10-31 由 jinjing（维护者）决定。范围：`.github/workflows/ci.yml` 的 runner 路由。
它撤回的是 [`qwen-autofix.md` 第 38 节](../../.github/workflows/qwen-autofix.md)
原先"执行的代码是 collaborator 编写——与 ci.yml 的 pick_runner 路由到该池的信任等级相同"
的前提（该节已在同一 PR 改写）；[`autofix-gate-runner-isolation.md`](./autofix-gate-runner-isolation.md)
仍是池上共享 HOME 属性的参考文档。

## 改了什么

`classify_pr` 的 `pick_runner` 现在发布两套路由，而不是一套，且两者都从同一份
解析好的 fleet 标签赋值：

| 输出            | 接纳对象                                                                                    | 读取方                                                                |
| --------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ubuntu_runner` | 同仓库 head、`OWNER` / `MEMBER` / `COLLABORATOR` 作者、`merge_group`、`push`，其余走 hosted | `test`、`integration_no_ak`、`integration_cli`、`web_shell_e2e_smoke` |
| `lint_runner`   | 每一个 `pull_request`，未受信 fork 也算；其余情况与 `ubuntu_runner` 相同                    | `lint_and_static`                                                     |

`classify_pr` 自身的 runner 对其接纳的所有事件一律走 ECS（kill-switch 除外）。
门禁 job 只执行可信 base-SHA 的代码、拿只读 token——暴露面严格小于 lint
车道；而把它对不可信 fork 留在 hosted，会让整条 fork CI 链（classify 是所有
Linux 车道的 `needs` 前置）排在稀缺的 hosted 池后面。association 门禁保留在
它真正约束重 PR 代码执行的地方：`ubuntu_runner`（test 与集成车道读取）。

回退优先级：`MAINTAINER_ECS_RUNNER_DISABLED=true` 覆盖一切，包括手动调度。
`LINUX_RUNNER_FLEET=hosted` 把 pull request、merge group 和 push 强制到 hosted，
但 `workflow_dispatch` 的 `linux_runner` 输入若显式选择 `self-hosted` /
`self-hosted-arm64` 仍会进池——dispatch 分支最先求值。池故障时要保证回 hosted，
请用 kill switch，而不是 fleet 变量。

`test_windows` 与 macOS 车道不在范围内：它们不读任何 classifier 输出。

## 为什么可以接纳未受信 fork

这条车道的定位是"判决只取决于代码树的那批检查"。把它放到自建池纯粹是吞吐决定：
每个 PR 往返一次 hosted 会拖慢真正卡合并的检查。代价是 PR 代码——`pnpm install`
的生命周期脚本与 lint/static 工具链——现在会在共享池上执行，作者并未经过任何审核。

## 隔离边界（以及它的洞）

`lint_and_static` 的首步通过 `GITHUB_ENV` 发布 `HOME` / `USERPROFILE`，指向
`${RUNNER_TEMP}/qwen-lint-home-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`——
按 run 唯一，创建前先 `rm -rf` 清空，并由失败收集器之前的 `always()` 清理步骤回收。
job 级 `env` 读不到 `runner` 上下文（GitHub 会拒绝整个 workflow 文件），而
`RUNNER_TEMP` 在本池跨 job 持久，所以固定目录名会把 fork 写下的 `~/.npmrc` /
`~/.gitconfig` 交给同一注册上的下一个 job——包括钉着自己那份固定 `qwen-ci-home`
的 `test` 车道（那是 pre-existing 属性，另行拥有）。

这个钉住关闭的是 **HOME 相对（自动）写入这一类**：git、npm、pnpm 通过
`~`/`$HOME` 解析的配置。它拦不住用绝对路径写账号真实 home 的 job；那仍在下文
已接受的残余暴露面里。仍然接受的限制：

- **包缓存是冷的。** npm 与 pnpm store 落在 per-run HOME 下，每次运行都要从
  registry 安装；yamllint 每次重新 pip 到 `$HOME/.local`，corepack shim 每次
  重新下载。实测冷装约 900 s，90/45 的时限本来就是按这个口径定的。只有
  linter 归档缓存保持共享温热：`XDG_CACHE_HOME` 指向
  `${RUNNER_TOOL_CACHE}/qwen-ci-cache`，lint.js 在每次缓存命中时、解压之前
  对归档做 SHA-256 校验，被篡改的条目会被拒绝并重新拉取。`COREPACK_HOME`
  留在 run 唯一的 HOME 内：corepack 缓存命中时不会重新校验已解压的条目
  （在 0.34.6 与 0.36.0 上复现——记录的 hash 不变，被篡改的 pnpm 入口照样
  执行），共享 corepack home 是一条跨 job 投毒通道。
- **`$GITHUB_WORKSPACE` 仍然共享。** 检出前的 "Restore workspace ownership" 与
  检出本身只能减轻、不能消除同机并行 job 留下的残留。该车道唯一的凭证是只读
  `GITHUB_TOKEN`（`contents: read`、`pull-requests: read`），绑定在 freshness、
  contract、test-growth 三个步骤上——收割残留拿不到任何写凭证。

将来若出现必须用真实 home 的步骤，需要重新给它单独设门。

### 为什么不用容器

`qwen-triage` 的 `tmux-testing`/`verify` 用 `container: node:22-bookworm`
包裹 PR 代码。本车道考虑过该路径并否决：车道自己的 "Restore workspace
ownership" 步骤正是因为容器化 job 在这些主机上留下 root 属主残留物而存在，
再加一条容器化车道会加重该问题；pnpm store/bundle 缓存行为也需要在池上重新
验证。per-run HOME 以几行成本关闭了自动配置继承这一类；它不是沙箱，下文的
残余暴露面仍属接受范围。

## 残余风险（已接受）

- **同机暴露是具体可达的，不是理论上的。** 例如 `publish-tmux` 在该池上持有
  `CI_BOT_PAT`、未容器化、`runs-on` 无信任门禁；同 UID 进程可读
  `/proc/<pid>/environ`。这只是举例，不是清单：`serve-ab-publish`、
  `web-shell-visuals-cleanup`、`qwen-autofix` 的 `issue-autofix` 也带 bot PAT
  跑在 ECS 池上；`web_shell_e2e_smoke` 经由 `ubuntu_runner` 落到自托管 ARM64
  fleet（含 write 权限作者的 fork），且没有 per-job HOME——都是本 PR 不改的
  pre-existing 暴露面。一个在 90 分钟上限内空转的 lint 步骤可以扫描这类窗口并
  在连续 fork PR 中重试。结构性解法是隔离 fleet——不在本变更范围内。
- **association 门禁是吞吐策略，不是可强制的信任边界。** `pull_request` 运行
  执行的是 PR 自己的 workflow 文件，任何 fork 都能在开 PR 的同一个 diff 里把
  任何车道（包括 `test`）放到池上（ci.yml 的 `test_windows` 注释记录了同一
  事实）。GitHub 的首次贡献者 workflow 审批是外层门。本决定的单车道范围描述
  的是默认路由，不是一道围栏。
- **云 metadata。** 若池实例绑定了 RAM 角色，任何 job 进程都可访问 metadata
  端点。建议 fleet 侧开启加固模式，与本 workflow 变更独立。
- **`/tmp` inode 耗尽。** 池的 tmpfs `/tmp` 有约 100 万 inode 上限，磁盘下限门
  未覆盖（它查工作区与 `RUNNER_TEMP` 挂载）。2026-10-31 `ecs-qwen-hz1-9` 上的
  一次 lint 失败即此类。后续：把下限门扩到 `os.tmpdir()` 并清理主机 `/tmp`
  积压。

## Kill switch

`MAINTAINER_ECS_RUNNER_DISABLED=true` —— 所有 Linux 车道（含本车道）回落到
`ubuntu-latest`，各按各的 hosted 上限：lint 45 分钟、test 120、web-shell
smoke 60、no-AK 集成 30。

## 测试

`.github/scripts/ci-runner-routing.test.mjs`（在 `HELPER_TESTS` 里，因此门禁
每个 full-profile PR）钉住：门禁 job 在全 association 矩阵下无条件走 ECS
（kill-switch 可退回、association 子句不得回潮）、生产者绑定
（`classify_pr.outputs.lint_runner` ← `pick_runner`）、真实选择器 shell 在全
association/事件矩阵下的行为、`lint_runner` 的单车道范围（超集必须更新本记录）、
首步发布的 run 唯一 HOME（先清后建、共享可校验缓存）、清理步骤先于收集器、
以及两个输出在未建模的 fleet 值下仍走同一份标签。
`scripts/tests/ci-platform-lanes.test.js` 钉住
`runs-on` 字面量（lint 读 `lint_runner`、test 读 `ubuntu_runner`），并按各车道
自己的路由输出求值 timeout；注意该套件在 merge queue 之后才跑，所以承重的
HOME 守卫放在路由电池里。

## 决策记录与开放问题

- 接受记录：jinjing 于 2026-10-31 评审并接受共享池代码执行风险（Lint & Static），
  同日稍晚将默认 ECS 路由扩展到 classify_pr 门禁 job（lint 暴露面的严格子集：
  可信 base-SHA 代码、只读 token），使 fork PR 不再在前置 job 上排 hosted 队——
  并注明 association 门禁对改写 workflow YAML 的 fork 不可强制，因此接受范围
  覆盖上述残余暴露面，而不是一道单车道围栏。欢迎第二位维护者确认（triage
  stage-3 正是因此暂缓）；这是人的决定，不是代码变更。
- PR 自身 CI 在池上验证路由管道（作者是 collaborator，该运行中两个输出一致）；
  fork 分歧由路由回归矩阵证明，其首个线上端到端见证是下一个不可信 fork PR。
- 另行拥有的后续：per-run HOME 下恢复热共享 pnpm store（如通过 `XDG_DATA_HOME`
  指向内容可校验的共享路径），找回约 900 s 的冷装成本；磁盘下限门覆盖 `/tmp`
  inode；fleet metadata 加固；`test` 车道固定 `qwen-ci-home` 的持久化问题；
  若重新审视已接受的残余暴露面，则建隔离 fleet。
