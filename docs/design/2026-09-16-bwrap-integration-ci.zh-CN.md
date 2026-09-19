# 真实 Linux bwrap 集成 CI

[English](2026-09-16-bwrap-integration-ci.md) | [简体中文](2026-09-16-bwrap-integration-ci.zh-CN.md)

## 问题与范围

PR #11614 交付了显式选择的 bwrap 后端，但延后了 Linux 集成 CI。模拟进程测试无法证明挂载约束、网络隔离或宿主可见的进程归属。本次跟进针对构建后的 CLI 和系统 bubblewrap 增加确定性集成覆盖，不改变沙箱策略、后端默认值或生产代码。

## 设计

显式命令 `npm run test:integration:sandbox:bwrap` 使用独立 Vitest 配置及 `integration-tests/sandbox-bwrap/` 下的测试。普通集成配置排除此套件。显式命令在非 Linux、bubblewrap 不可用或命名空间探测失败时直接失败；不支持的环境不能以跳过套件获得绿色结果。测试串行执行，不重试，限制进程等待时间并清理资源。

每项测试独占相互分离的工作区、HOME、Qwen 状态、缓存及临时目录。子进程环境仅包含必要的可执行文件/系统路径和夹具配置，不继承模型凭据或沙箱标记。工作区外写入目标是各授权目录的临时兄弟目录，不能位于沙箱可写临时目录内。测试先证明目标在非受限状态下可写，再要求受限状态返回 `EROFS`，并检查其内容保持不变。

复用现有 fake OpenAI server 驱动真实 headless CLI 工具调用。仅模型响应是脚本化的；CLI、工具、bubblewrap、内核、Git、socket 和子进程均真实执行。本地代理夹具验证代理流量和清理，无需外部服务或 API key。网络测试分别证明 open 模式可以连接同一存活宿主端点、closed 模式不能连接；仅枚举接口不足以证明这些行为。

会话归属通过真实进程中的生产 `SessionWriterLease` 服务验证，一个经沙箱命令启动，另一个位于宿主。测试验证存活 owner 冲突以及该 owner 死亡后的接管。这是跨边界服务级集成，不声称覆盖 ACP UI 或 daemon 全链路：普通 headless CLI 不启用 writer lease。

## 验收

| 领域       | 必须观察到的结果                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 入口和验证 | 使用真实 bwrap；保留运行时标记和宿主 PID 命名空间；open 与 closed 模式的完整行为检查通过。                |
| 文件系统   | 工作区写入成功；原本可写的外部夹具返回 EROFS 且内容不变。                                                 |
| Git        | linked worktree 可以 stage 和 commit，其 common 仓库位于工作区及其他可写根之外。                          |
| 模型和网络 | fake model 工具调用经普通 CLI hop 写入工作区；open 可连接宿主而 closed 不可；配置的代理观察到流量。       |
| 归属       | 宿主竞争者不能抢占存活的受限 owner；owner 死亡后可以获取归属。                                            |
| 生命周期   | 正常退出及 SIGINT/SIGTERM 后，夹具载荷/代理进程终止；在清理之前断言进程消失，不能把清理操作当作验证证据。 |
| 失败关闭   | 显式选择 bwrap 而可执行文件缺失时，不能静默运行载荷。                                                     |

## CI 与涉及文件

独立 workflow 在 pull request、main push、merge group 和手动触发时使用临时 GitHub-hosted Ubuntu 22.04 runner。它安装 bubblewrap、Git 和 curl，使用固定的 Node 版本，安装并构建仓库，检查集成测试类型，然后执行显式套件。仅授予仓库只读权限，不使用凭据，并限制任务时间。无需修改共享 runner 的内核全局策略。失败时也上传测试报告。

变更限于集成测试/配置、npm 脚本、workflow 和同步的设计文档。现有无沙箱和容器套件保持原行为。

## 限制与后续

这些用例验证声明的 P0 行为回归，不构成完整沙箱安全审计。共享 PID/procfs、宿主 Unix socket、可写 Git/Qwen 状态和建议性代理路由仍是已记录策略。SIGTSTP/SIGHUP 生命周期调整、Landlock、seccomp 和默认启用保持独立。只有实际 hosted 运行后才能声称 CI 本身已验证；本地 Linux 结果单独报告。本次仅增加测试，无需新的产品策略决策。
