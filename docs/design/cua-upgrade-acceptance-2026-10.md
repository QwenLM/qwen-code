# Computer Use 升级验收记录（2026-10-16）

实现以 [讨论结论](cua-upgrade-2026-10.md) 和 [平台移植清单](cua-upgrade-platform-ports.md) 为准。工作位于 `lazzy/cua-upgrade-2026-10`，基于 `a8eb74fdf5b60851e1fc4a8e258e043273df4411`。版本 `0.26.0` 是本地开发目标，尚未发布；没有推送、创建 PR、合并或运行发布工作流。

## 本地实现

P1–P6 的代码和打包改动已落在独立 worktree。Node REPL 只暴露 `js/js_reset`，默认 30 秒，预载全局 `cua` 和当前平台文档。Driver 管理应用/窗口解析、短 ID、三平台观察 diff、截图坐标和派发错误；直接 MCP 默认 19 个操作。macOS 保留后台 AX/定向事件；Windows/Linux 仅在明确派发前拒绝时转前台。显式桌面输入和 held keys 绑定会话，正常结束/reset 等待释放。浏览器接口直接返回仓库 browser-use SDK 的对象，未修改浏览器功能。

Native Wayland 实现已删除，X11 应用（包括 XWayland 中的 X11 应用）保留。SDK、原生、browser-use 和 Node REPL 统一为 `0.26.0`；独立 npm 安装使用固定版本依赖，原生包按校验和下载。Windows 默认安装无需签名 UIAccess worker；显式 opt-in 仍校验签名和安全安装路径。Qwen CLI/core 的产品差异只有删除两个 bundled `SKILL.md`。

本地检查点：P1 `cf89555254`、P2 `d2995a50c5`、P3 `b7c4d9c86c`、P4 `56a3ec2ba5`、P5 `fcc473d4a6`；P6 由本记录所在提交承载。

## 已取得的证据

| 范围              | 结果与边界                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库构建/类型     | 根目录 build、typecheck 通过；最终 browser-use 类型检查通过。                                                                                                                                                       |
| Node REPL         | 68 个相关测试通过，含真实子进程 reset/dispose 异步清理。独立 tarball 在无仓库依赖的消费者目录安装，通过文档预载、变量持久化和 reset 验证。                                                                          |
| SDK / browser-use | SDK 51 通过、6 跳过；浏览器 594 通过。浏览器包装测试使用原 SDK，无 Chrome GUI 成功声明。三个 npm 包均实际打包，仅执行 publish dry-run。                                                                             |
| Linux 原生        | 独立 ARM64 容器中 locked all-target check、SDK/driver 构建通过。规范坐标测试 38、Computer Use 测试 5 通过。Xvfb 真实桌面链 96/96、App 坐标链 29/29；实际 display resize 跳过。                                      |
| Linux 首次安装    | 实际 archive/checksums HTTP 下载、缓存命中、残缺修复、坏 SHA 拒绝、缺 checksum 拒绝及 postinstall 14/14；从下载缓存加载真实 SDK/桥并完成 GTK 输入/截图/按键释放链 14/14。不是 native override 或开发 symlink 验收。 |
| macOS 原生        | all-target check、ARM64 和 Intel SDK/桥构建通过，组合的两个 universal 文件均包含 arm64/x86_64。仅在 ARM64 主机执行加载；未声称 Intel 运行或 notarization 验证。                                                     |
| Windows           | GNU 交叉 all-target check 通过；未执行 Windows 桌面/UAC 测试。派发后 UIA 错误和 worker 断连的纯状态回归确认不再发送第二次点击。                                                                                     |
| 发布配置          | 同版本约束、依赖发布顺序和 production gate 测试通过。工作流没有被触发。                                                                                                                                             |

收尾审查修复了三个消费者问题：旧归一化环境变量重复变换规范像素坐标；Windows UIA 派发后错误被当成可再次点击；直接 MCP initialize 仍给出旧工具和归一化说明。对应失败复现与修复后证据分别保留。

最终原生源清单为 P6 v5：688 文件，树 SHA-256 `c8a662cdc5c53eaa4cbbd14b146b8e844a86fc060d1b8f16a8f7bb4014c7dbee`。v5 再次通过 Linux/Windows GNU all-target、真实 MCP initialize/list 11/11、精确桌面链 96/96、实际下载 14/14 和缓存加载 SDK GUI 链 14/14。v5 SDK/driver 重新构建；桥因源和 ABI 未变，明确复用 v2 的 fresh build。早期 v2/v3/v4 证据仍保留各自版本。

详细原始日志与独立测试报告保存在当前 worktree 的 `.qwen/e2e-tests/cua-upgrade-2026-10-artifacts/`，主报告为 `.qwen/e2e-tests/cua-upgrade-2026-10.md`，P6 报告为 `p6-validation.md`；自审记录位于 `.qwen/investigations/cua-upgrade-2026-10/parent-self-audit.md`。

完整差异和消费者自审在修复后连续两轮无新发现，独立测试工程师的 P6 边界复核为 CLEAN。当前环境未提供 Codex `/review` 工作流，未使用 Qwen Review 代替。

## 尚未完成的外部验收

macOS 官方 Computer Use 接口确认桌面被锁定，自动解锁失败后未继续 GUI 尝试。Windows 仅正常登录/UAC 路径获准，未借用其他进程令牌。Linux 容器没有真实 uinput/MPX、物理用户输入或 XWayland 共享桌面设备，因此这些场景仍需实机验收。

工具层三方对照与 OSWorld 20 题模型评测尚未完成。全局 qwen 模型基线在工具调用前因 provider 400 / 缺少配置凭据失败；20 题清单已准备，执行数为 0。没有 AP 网络请求，没有任务成功率、token、轮次、耗时或 Codex/上游等效性改进结论。这些发布前验收条件仍然有效。
