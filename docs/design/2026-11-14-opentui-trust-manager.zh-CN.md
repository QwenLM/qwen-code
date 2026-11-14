# 原生 OpenTUI 信任管理

[English](2026-11-14-opentui-trust-manager.md) | [简体中文](2026-11-14-opentui-trust-manager.zh-CN.md)

## 状态与问题

实现进行中。Root global 基线63028通过（42.131s、两次自然退出、零 model HTTP）；strictNative49702在 initial-options 失败（32.933s），实际只有只读占位。该次 cleanup grace 错误/signal9 保留为失败，不是自然退出。本增量之前 `/trust` 确实进入 `OpenTuiTrustDialog`，但只有 yes/no 和 Escape。Ink `TrustDialog` 支持三种持久化决定及重启。已有启动 `OpenTuiFolderTrustGate` 只处理未决定的工作区，不能关闭此命令缺口。

## 范围与行为

实现完整命令：显示捕获的文件夹、当前显式级别、父目录/IDE 继承说明；使用已有原生列表键位选择 Trust this folder、Trust parent folder 或 Don't trust。原样复用 CLI 信任求值与写入政策。有效信任不变时立即持久化，成功后关闭；有效信任改变时只保存待提交选择，显示原重启说明，按 `r` 后才提交并调用真实 `relaunchApp`。Escape 丢弃待提交选择，关闭而不写入。后续选择必须在尝试写入前清除更早的待提交选择。读写失败显示真实错误，不关闭、不重启。父目录/IDE 信任仍然生效时显示已有警告。关闭 folder trust 时仍遵循同一政策求值器。

不直接修改 Config 内存信任、不授予批准、不改启动政策、不删除继承规则，也不跳过重启使信任变更立即生效。不增加 Core API、存储或通用所有权框架。

原生 frame 内使用一个真实滚动区域，按传入 popup 高度减去已有四行边框/padding 分配。所有正文文字的宽度扣除 scrollbar 一列，避免遮住文件夹或提示字符；选项再扣除指示符和数字列后自然换行，不裁成单行。highlight 或 scrollbox 真实尺寸变化只标记一次待跟随；局部公开 renderAfter 在 native root 完成布局计算并更新全部后代坐标后消费标记，再调用已有 scrollChildIntoView，滚动结果在请求的下一帧绘制。不使用 label onSizeChange：TextBufferRenderable 重写 resize 而不调用该 base 回调。PageUp/PageDown 和鼠标滚动可查看完整文件夹、继承说明和待重启/错误文字；普通重渲染和用户滚动不重复抢回焦点。这只是 Trust 局部布局变化，不改 shared dialog 通用行为。

## 最小复用与所有权

以同目录原生组件及测试替换占位，保留命令和路由。复用 `TrustLevel`、`loadTrustedFolders`、`isWorkspaceTrusted(settings.merged, previewConfig, capturedWorkspace)`、`relaunchApp`、原生 DialogSelect/frame 与现有 host history 错误/警告通道。只移植 `useTrustModify` 的小型状态转换，不沿用其 ambient `useSettings`/`process.cwd` 输入。Ink 和启动 gate 生产代码不动。当前 `isWorkspaceTrusted` 已接受显式工作区并委托 `getWorkspaceTrustStatus`，包括有范围的 IDE 信任；不能从 primary cwd 推导 IDE 信任或绕过政策求值器。

mount 显式传入选中的 Config/settings/host。捕获 Config 身份、settings 身份、session ID、Config 的规范工作区、实际解析的 `settings.workspace.path` 与请求代际。捕获该 settings 路径不变；已有 loader 合法解析到祖先设置文件时，不能强制要求 cwd 下存在合成设置文件。预览、同步持久写入、错误发布、关闭和重启前，验证 host.config/settings 相符且当前 getters 仍匹配。关闭、卸载或观测到替换永久撤销该代际，A→B→A 不能复活旧回调；真正新挂载可以重新操作。不能把整个 trust 文件指纹当 owner：授权写入本身会改变它，现有 writer 已在自身锁内合并磁盘新值。不宣称外部文件替换的原子保证。

进程重启必须作用于实际拥有该选中 live runtime 的进程。提交/重启前再次核对启动工作区、选中工作区及所有权；不支持或不匹配的 runtime 显示明确错误，绝不回退退出/重启 primary。已有 `onRestartRequest` 只是普通 quit，不能替代信任 relaunch。在进入进程级不可逆 cleanup 前立即检查重启 owner；现有函数没有 cleanup 后的 owner 回调，不能宣称已有此保护。保留 `relaunchApp` 的 cleanup 等待与错误处理，不增加 flag 或强制 no-relaunch 路径。

共享 CLI relaunch 入口现在在任何 `runExitCleanup` 前调用已有公开 `prepareFileWatchersForProcessExit`，补齐 quit 已遵循的进程退出准备不变量：relaunchApp 的每个生产消费者都会退出或 re-exec。五个消费者是原生 FolderTrustGate/TrustDialog 与 Ink IdeTrustChangeDialog/FolderTrustDialog/TrustDialog。它们的文件、Core 实现、cleanup 期限、r 所有权、exec flags 和重启机制不变。本次不扩大到 relaunchForUpdate 或 client shutdown。

## 验证与验收

先对已安装 global Ink 身份和当前 strict-native 占位运行配对公共基线；旧 global 是对照，不是最终候选证据。随后在当前 NodeInk/BunInk/strictNative 运行同一完整公共场景。复用 `tui-extension-acquisition.test.ts` 和 `tui-skills-manager.test.ts` 的 owned HOME/runtime/temp、fake server、InteractiveSession 与证据模式，保持自然退出和零 model 合同。必须包括有界的真实 `r` relaunch，不能 mock 重启或只验 parent/cancel。详见 [public E2E plan](../../.qwen/e2e-tests/opentui-trust-manager-20261114.md)。

单测覆盖三种选择、立即/延期保存、parent/IDE 警告、trust-disabled 政策、读写失败、替换待提交后失败、Escape、owner 替换/ABA、过时重启及同 owner 成功。Root 原生几何60236和首次修正49670均记录三种尺寸通过、两种失败；后一次实际揭示跟随早于最终坐标、scrollbar 遮盖 hint 字符，不是 stale source。后续 Root12927 原生几何与固定用户 PageDown 已通过，仅属布局证据。此前源码 normal97728 通过，但实际当前 profile 重启仍暴露失败：NodeInk30907 完成两次 r/四次自然退出；Native9236 首次 untrust 已写入却没有 fresh record，BunInk83110 首次 same-PID/fresh-session 重启成功、第二次没有 fresh record。两次失败最终 cleanup signal9。尚无实际栈证明具体 FSEvents 根因。新增共享准备后的全部 normal 与三个 profile 验证仍 pending。扩展 global1069 协议真实执行两次 r 重启、四次自然退出，仅属对照证据。现有通用几何脚本仍不包含 Trust；有限 Trust 矩阵证据是另一次 Root12927，不能借通用脚本通过。更广平台几何仍独立保留。后续需验证完整标签与重启/错误文字，不削弱 oracle。完成前需要 build/type、相关 whole tests、零 warning lint、format、bundle、公共各 profile 及两轮完整 diff clean 自审。

## 限制

仅修改原生 CLI Trust 路由及共享 CLI relaunch 准备。现有 CLI config 政策函数只是消费者，不是修改目标；若必须改共享 config，另行维护者分诊。Windows/relaunch 平台资格、原生设备/voice/IME、同一最终 main 打包、默认切换及 Ink 移除批准均独立保留。本工作不宣称修复以前 Skills 初始化失败。
