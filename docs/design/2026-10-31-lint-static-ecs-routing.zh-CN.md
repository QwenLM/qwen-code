# Lint & Static 对所有 pull request 走 ECS 池

[English](2026-10-31-lint-static-ecs-routing.md) | [简体中文](2026-10-31-lint-static-ecs-routing.zh-CN.md)

2026-10-31 由 jinjing（维护者）决定。范围：`.github/workflows/ci.yml` 的 runner 路由。对这条车道而言，
它取代了 [`autofix-gate-runner-isolation.md`](./autofix-gate-runner-isolation.md) 里
"只接纳 collaborator"的前提。

## 改了什么

`classify_pr` 的 `pick_runner` 现在发布两套路由，而不是一套：

| 输出            | 接纳对象                                                                                    | 读取方                                                                |
| --------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ubuntu_runner` | 同仓库 head、`OWNER` / `MEMBER` / `COLLABORATOR` 作者、`merge_group`、`push`，其余走 hosted | `test`、`integration_no_ak`、`integration_cli`、`web_shell_e2e_smoke` |
| `lint_runner`   | 每一个 `pull_request`，未受信 fork 也算；其余情况与 `ubuntu_runner` 相同                    | `lint_and_static`                                                     |

kill switch（`vars.MAINTAINER_ECS_RUNNER_DISABLED=true`）或
`LINUX_RUNNER_FLEET=hosted` 生效时，两个输出都回落到 `["ubuntu-latest"]`；开关在
`pick_runner` 里读，所以它能把所有车道一刀切回 hosted。

`test_windows` 与 macOS 车道不在范围内：它们不读任何 classifier 输出。

## 为什么可以接纳未受信 fork

这条车道的定位是"判决只取决于代码树的那批检查"。把它放到自建池纯粹是吞吐决定：
每个 PR 往返一次 hosted 会拖慢真正卡合并的检查。代价是 PR 代码——`pnpm install`
的生命周期脚本与 lint/static 工具链——现在会在共享池上执行，作者并未经过任何审核。

## 隔离边界（以及它的洞）

`lint_and_static` 在 job 级把 `HOME` / `USERPROFILE` 钉到
`${{ runner.temp }}/qwen-ci-home`，于是 fork 写下的 `~/.gitconfig`、`~/.npmrc`、
`~/.cache/qwen-code/npm` 随 job 结束消失，不会被同一台机器上下一个可信 job 继承。
仍然接受的两个限制：

- **缓存是冷的。** npm 与 pnpm store 都落在 per-job HOME 下，每次运行都要从 registry
  安装。实测冷装约 900 s，而 90/45 的时限本来就是按这个口径定的。
- **`$GITHUB_WORKSPACE` 仍然共享。** 检出前的 "Restore workspace ownership" 与检出本身
  只能减轻、不能消除同机并行 job 留下的残留。这条车道没有任何持有秘密的步骤，这是残留
  不值得一枚 token 的原因。

将来若出现必须用真实 home 的步骤，需要重新给它单独设门。

### 为什么不用容器

`qwen-triage` 的 `tmux-testing`/`verify` 用 `container: node:22-bookworm`
包裹 PR 代码。本车道考虑过该路径并否决：车道自己的 "Restore workspace
ownership" 步骤正是因为容器化 job 在这些主机上留下 root 属主残留物而存在，
再加一条容器化车道会加重该问题；pnpm store/bundle 缓存行为也需要在池上重新
验证。per-job HOME 以几行成本关闭了自动配置继承这一类；它不是沙箱，下文的
残余暴露面仍属接受范围。

## 残余风险（已接受）

- **同机暴露是具体可达的，不是理论上的。** `publish-tmux` 在该池上持有
  `CI_BOT_PAT`、未容器化、`runs-on` 无信任门禁；同 UID 进程可读
  `/proc/<pid>/environ`。一个在 90 分钟上限内空转的 lint 步骤可以扫描这类
  窗口并在连续 fork PR 中重试。结构性解法是隔离 fleet——不在本变更范围内。
- **云 metadata。** 若池实例绑定了 RAM 角色，任何 job 进程都可访问 metadata
  端点。建议 fleet 侧开启加固模式，与本 workflow 变更独立。
- **`/tmp` inode 耗尽。** 池的 tmpfs `/tmp` 有约 100 万 inode 上限，磁盘下限门
  未覆盖（它查工作区与 `RUNNER_TEMP` 挂载）。2026-10-31 `ecs-qwen-hz1-9` 上的
  一次 lint 失败即此类。后续：把下限门扩到 `os.tmpdir()` 并清理主机 `/tmp`
  积压。

## Kill switch

`MAINTAINER_ECS_RUNNER_DISABLED=true` —— 所有 Linux 车道（含本车道）回落到
`ubuntu-latest`，并采用更紧的 45 分钟上限。

## 测试

`scripts/tests/ci-platform-lanes.test.js` 钉住三件事：`runs-on` 读 `lint_runner` 的
每个 job 必须钉一个 `runner.temp` 下的 HOME；`test` 必须继续读 `ubuntu_runner`；每条
车道的 `timeout-minutes` 只允许引用它自己 `runs-on` 读的那个输出。

## 决策记录与开放问题

- 接受记录：jinjing 于 2026-10-31 评审并接受共享池代码执行风险，边界变更仅限
  Lint & Static 一条车道。欢迎第二位维护者确认（triage stage-3 正是因此暂缓）；
  这是人的决定，不是代码变更。
- PR 自身 CI 在池上验证路由管道（作者是 collaborator，该运行中两个输出一致）；
  fork 分歧由路由回归矩阵证明，其首个线上端到端见证是下一个不可信 fork PR。
- 另行拥有的后续：per-job HOME 下恢复热共享缓存（如通过 `XDG_DATA_HOME` 把
  pnpm store 指回 runner 账号真实 home），找回约 900 s 的冷装成本；磁盘下限门
  覆盖 `/tmp` inode；fleet metadata 加固；若重新审视已接受的残余暴露面，则建
  隔离 fleet。
