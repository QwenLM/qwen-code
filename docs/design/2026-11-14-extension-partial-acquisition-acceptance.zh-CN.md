# 扩展部分安装验收

[English](2026-11-14-extension-partial-acquisition-acceptance.md) | [简体中文](2026-11-14-extension-partial-acquisition-acceptance.zh-CN.md)

## 状态与问题

本 Draft 为维护者提供可复现的验收实验，尚非 Ready：下文所列 Bun 和平台缺口仍未解决。初始测试准备和第一轮矩阵使用历史 main
`6f754be6548903e545e6ff0ed43a34927fe3bfb9`，那些结果保留各自范围。
PR15950 的宽度修正仍是独立的未合并依赖，不能隐含算作 main 通过。

Discover 和 Sources 已有实现。现有公共 acquisition 用例覆盖单个本地插件、拒绝、批准与冷启动，
没有证明两个远程插件的部分成功及对失败选择的重新明确授权。历史原目录变更语义仍待用户决定，
远程 command-only fixture 无法解决该问题。

## 测试设计

新增一个公共交互用例和一个小型 HTTP Git fixture。fixture 在新 owned Git 仓库创建两个
command-only 插件，以固定 fixture 身份提交，建立 bare publisher，并将 publisher 设为只读。
owned loopback server 提供 HTTP JSON catalog，并通过真实 `git http-backend` 提供只读 smart Git
请求。应用必须自行 clone 和转换，不调用私有安装 API。

catalog 使用现有 structured URL source 合同解析各插件。声明过的 owned Git launcher 记录真实
参数、cwd、父 PID 与实际子进程结果；clone 目标必须位于会话显式传入的 owned
`TMPDIR`/`TMP`/`TEMP`。这是有限进程观察，不是独立 birth 或无损瞬态追踪。Git fixture 的准备
使用显式隔离环境，不继承调用者的 `GIT_INDEX_FILE`。

无扩展名 launcher 使用独立的 CommonJS package 边界。相对已记录的 canonical cwd 解析真实 clone
目标（当前安装器使用 `./`），要求严格位于 owned temp 之下，并在操作解决后验证目标已清理。
关闭两个 server 后，在写入持久结果之前重新检查模型 HTTP0、fixture 错误和最终保护全图；
延迟失败保留首个错误，不能生成通过结果。

在 Node+Ink、Bun+Ink 和 strict Bun+OpenTUI 使用相同的原公共 UI：选择 A+B，选择 user scope，
批准 A 并拒绝 B；要求 partial1/failed1、A 的精确字节和策略、已清空的选择；明确只重选 B 并批准；
验证两者不同的 URL/plugin 身份和命令字节；自然退出后冷启动，再验证两个命令补全并自然退出。
每个捕获阶段 publisher 及无关 workspace/settings 全图必须完全不变。模型 HTTP 为0；catalog/Git
HTTP 单独记录。

## 边界与验证

所提交用例的固定合同为整案120s、conditionLocal15s/conditionCI45s、零重试。已记录实验另由外层 controller 限制180s，该 controller 不属于提交的用例。现有 wait helper 仅在
`CI=true` 时乘3；执行前须记录真实环境，不能声称 CI 的条件上限也是15s。仅运行用例时启动 fixture。保存第一次真实失败及输出，不得为求绿追加
Enter/Escape 重试、策略绕过、私有 import 或延长预算。若真实策略拒绝 loopback HTTP，应记录路线
未资格化，不能据此更改 Core 策略。

不修改 CLI/Core 生产代码，不声称用户/global 安装、hook-sensitive 行为、原目录语义、桌面体验或
迁移整体完成。新增文件仅为公共用例、fixture 与双语设计，E2E 计划保持 ignored；本增量不改 CI 路由。

复现前应构建并 typecheck 候选，记录真实 runtime、Git 客户端/backend 和 bundle 身份。可用时先运行 global Ink 基线并保留其版本范围，再串行运行最终候选的各 renderer。验证
source/publisher 全图、两次真实自然退出、精确提升内容和策略及模型 HTTP0。宽度几何合同在包含对应
修正的候选上独立运行。下列观察不代表所有 renderer 或平台均已资格化。本四文件 Draft 不包含本地诊断生产改动。

## 已记录快照结果

下面两轮矩阵都使用冻结的 main 快照 `8646b0a70552af5297b433fbbdb4c2b73b63bc32`，并非最新或最终 main。公共用例保持 SHA256 `0cae8e5657ae279ba771d0511d329c911e8ad27242bf3f16a1d894a1d7d591e8` 不变。第二个候选仅在该快照上包含四份测试/设计文件，没有 CLI/Core 诊断插桩。

| 已记录候选                                        | Node/Ink               | Bun/Ink                           | Strict Bun/OpenTUI                                           |
| ------------------------------------------------- | ---------------------- | --------------------------------- | ------------------------------------------------------------ |
| 原 fixture `a574bfeb`、bundle `75d72f97`          | 整案通过，两次自然退出 | 首次 `deny-b`15s 失败，无自然退出 | 首次 `deny-b`15s 失败，无自然退出                            |
| 清理修正 fixture `a8beb92c`、纯 bundle `ef6030a6` | 整案通过，两次自然退出 | 整案通过，两次自然退出            | 首次 `deny-b`15s 失败，内层 PTY close-grace 错误，无自然退出 |

通过案均达到批准 A/拒绝 B、精确 partial1/failed1 且选择清空、明确仅重选 B 并重新同意、精确安装身份/策略/命令字节、热冷命令补全和两次自然 exit0/signal0。纯候选 Native 在 B 同意前显示 Installing，只有 A 提交，后续部分结果/重选/冷启动未达到。纯矩阵均为模型 HTTP0、无 fixture 错误、publisher 全图及源码 pins 不变，三个外层 controller 均无 timeout、强制清理或剩余 owned group。外层清理不能抹掉 Native 内层 close-grace 错误。

新增 Bun/Ink 通过只是实际观察，不证明 fixture 清理修正了旧 Bun 业务失败。原矩阵仍为1P/2F，纯矩阵为2P/1F，两者都不代表整体验收。全局 v0.22 基线达到业务流程，但未观察到冷进程自然退出。历史 `6f754be6` 观察保留其原候选范围。

Linux 为 NOT_RUN。Windows 为 SETUP_NQ，因为此 Git HTTP fixture 尚未完成该平台资格；不得新增 skip、flag 或延长等待求绿。这些仅为本地 Darwin 观察，不代表已安装包、最新/最终 main 或跨平台资格。其他功能合并不改变这些范围。本贡献仍为 Draft、非 Ready，不宣称生产修复。

## Fixture 错误路径清理

修正后的 fixture SHA256 为 `a8beb92c168c9f1d72c03f31f03058aba3aa97c2c2883d6ecac4b5be5d542a97`。spawn 或 stdin 错误后，它仍持有 CGI child，直到真实 close 事件。独立 owned backend 故障 probe 观察到旧版在 child 仍存活时提前返回，新 helper 则等待 child 消失。该 probe 仅验证 fixture 清理所有权，不证明 transport、应用根因或 Bun 修复。上面的纯矩阵是其实际应用观察，不再列为尚待验证。

所有探索性的 CLI/Core 日志、wrapper 实验及原生采样均排除。本测试/设计贡献不修改 Core 或 CLI 生产代码。

## 就绪与冷启动证据补充

后续生产候选 `b6ec1bb9` 已完成 Native 热态部分安装、重试、命令流程与一次自然退出，但冷启动未到提示符。其 Bun+Ink 在来源详情前失败；保存帧显示 Added 提示可能与仍忙的添加表单并存。Node+Ink 完整通过。这些观察不关闭 Source 门槛，也不替代更早候选的结果。

下一版 driver 强化原 source-added 条件：同一 viewport 必须同时包含成功提示、Sources 列表、聚焦的 Add marketplace 操作及已注册 URL 行，且没有 Adding。仍发送原有按键，使用原期限与重试策略。

可选测试 helper 生命周期观察记录 PTY PID、observer PID、原始字节、就绪、退出状态与清理尝试/结果。单调时间戳属于 observer 进程；PTY PID 不证明叶进程或 GC owner。回调错误不得替代原启动/清理结果，发出的状态使用副本，不暴露内部可变状态。既有启动失败回调仍只调用一次，在清理前保留原始 ANSI。start 方法继续拥有启动失败的清理责任，保留本地 30 秒首屏与 10+5 秒清理期限。

Source fixture 在每次 start 前固定 attempt index，分开冷热证据。观察可能影响调度；缺记录仍未知，强制退出不能算自然退出。helper 测试使用受控 PTY 事件及真实终端解析器，并非实际应用或原生进程。OS 采样必须独立核实进程身份及仍在等待启动的窗口。功能验收与整体迁移仍需原有证据。

## 完整 composer prefix 准入

新的仅 driver 候选保留原 completion 名称断言，并要求同一新鲜 viewport 的真实 composer 同时显示完整请求 prefix。识别最后两条完整水平边框之间的单行 `>` 输入区域，不把历史记录或下拉候选名称当成已输入文本。当前整案固定 120×42，使用能放入一行的短 ASCII prefix；多行 composer、其他布局和平台不在此 recognizer 的已证范围，缺失或不符合区域直接拒绝。

七份未改的已保存帧均缺少当时请求的完整 prefix，尽管旧名称 predicate 可放行；这是 observer 过早准入的保存证据，不证明持续丢键或 Core/renderer 缺陷。旧 83221 clear 失败及原矩阵保持，不由新的 predicate 倒改。新候选只等待相同业务条件变为可证，不增加输入、重试、按键、sleep 或整案120s/local15s/CI45s预算。须经类型/正常检查及新 driver 实际验收后才能作为最终发布树；当前尚未执行。
