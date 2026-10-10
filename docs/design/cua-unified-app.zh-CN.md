# 统一三平台 ComputerUse App 工作流

[English](cua-unified-app.md) | [简体中文](cua-unified-app.zh-CN.md)

## 状态与范围

实现、确定性原生 GUI 验收和三个选定标准 AP 运行已完成，2026-09-22。Windows 原始 VLM 成绩存在下述既有校准限制。用户已批准统一 App API、短数字元素 ID、自动跟踪窗口/对话框、内部切换并恢复焦点、稳定观察身份，以及完整的单入口 skill。使用 macOS、Linux、Windows 的有界 AP job 验证。用户随后批准提交本功能 PR，并在其中准备 SDK 0.20.11；正式发布为后续独立步骤。基线包含另行 review 的 SDK 0.20.10 无 Metal 截图修复。

## 当前缺口

本次变更前，共享 JavaScript App 层依赖仅 macOS 实现的窗口标记与 App 观察投影。Linux/Windows 仍使用 exact-window 工作流。Windows 对纯预算截断也丢弃 revision 身份。skill 路由到不同平台流程，部署文档遗漏 Windows UIAccess companion。

## 实现方案

三平台复用 ComputerUseApp。应用列表统一为紧凑身份，详细发现记录保留在内部。原生 adapter 依据 OS 元数据选择应用当前/最近活动窗口及所属模态窗口，绝不借用其它应用的窗口。目标不明确或不支持时在输入前失败。每次动作重新解析目标，窗口或 runtime generation 变化时使已有元素 ID 和坐标失效。

将既有 app_context 输入和 app-tree-v1 revision 投影扩展到 Linux/Windows。数字 ID 来自原生保留的元素身份，不在 JavaScript 中按文本行重新编号。纯预算省略保留身份，相同采集视图才能 no_change；变化的有界视图返回 full，不产生删除 diff。读取失败和不可信 fallback 仍使保留身份失效。Linux 临时观察暴露限定于当前快照的 ID/token；Windows UIA 纯预算截断但读取完整时，转移保留 ID 对应的原生绑定。

App 内部允许 foreground 准备，复用原生精确目标输入与焦点恢复；不在结果不确定后自动重放动作。焦点恢复应尊重用户中途的主动切换，恢复失败应明确报告，不能声称动作未生效。App 观察继续内部采集当前坐标帧，仅在请求时向调用者暴露图片。唯一最小化窗口仍可被选中；截图观察将其恢复并检查就绪状态，同时保留此前焦点。同进程但无所属关系的窗口取得焦点时返回不确定结果，不能据此声称恢复成功。

唯一规范来源 computer-use/SKILL.md 包含完整共同 API 和工作流；npm 打包副本必须一致。移除旧平台流程资源，更新 staging 和相关测试。平台尚不支持的文本操作明确返回 unsupported_platform 并如实说明；不为方法名称一致而新增剪贴板实现或平台 worker。

## 架构与边界

宿主加载现有原生 SDK runtime。Windows 继续通过 named pipe 使用既有签名 UIAccess worker；macOS 使用既有 AX/截图/输入后端；Linux 使用既有 AT-SPI 与 X11/Wayland 路径。Wayland App 选择使用既有 Sway 或可信 GNOME 前台元数据。按进程寻址的 compositor injection 路径无法确认精确 App 窗口，因此在输入前拒绝；旧 exact-window 调用保留原有路由。不新增服务、协议、凭据存储、权限授予或签名信任。OS 焦点/权限限制仍是有效的失败条件。保留 exact-window API 供既有程序调用者使用，模型侧 skill 全部采用 App。

## 文件与兼容性

变更涉及共享 App facade/types、Linux/Windows 窗口解析和观察 adapter、必要的原生输入/schema、skill staging 与指引、原生/facade 定向测试和部署契约文档。保留 macOS 现有行为及底层封闭动作结果契约。Windows 快捷方式的原始命令参数与可执行路径别名分开保留，不按快捷方式时间戳将冲突 launcher 归入某个运行 PID。POSIX 身份规范化独立于 Node 宿主并保留大小写。listApps 的紧凑结构在三平台一致；需要 Linux/Windows 详细发现字段的调用者应使用低层 driver API。

## 验证与验收

先记录全局 CLI/版本及 facade 复现基线，不将其当作原生 GUI 证明。执行 SDK/native 定向测试、构建和类型检查，再完成两次完整自查。AP 验证必须从真实 worker 证明候选 native/JS/skill 哈希、App 数字 ID 动作、模态转换、稳定 ID、焦点恢复和有效的 agent/evaluator 完成。保留 job/attempt 谱系，固定模型/pipeline/判题/媒体配置，归档指标和轨迹。基础设施无效尝试及已复现的 SDK 缺陷可在最小修复、保留谱系后重试，有效低分不重跑。每个平台先跑有限 smoke case，不扩展为完整评测组。

## 风险与待定事项

原生应用身份因平台而异，尤其是 Windows 多进程应用与 Linux compositor 限制。共同 schema 或 mock facade 通过不代表成功，必须联合验证 API 和 native adapter。候选 artifact 与各平台一个标准 AP case 已固定并提交。macOS、Windows 和 Linux X11 的确定性原生 GUI 测试已通过。随后标准 Linux 运行暴露 ImageMagick 抓取已销毁窗口时阻塞 X server 的问题。fallback 现已并发读取输出、设置五秒截止并在返回前终止和回收子进程。真实 X11 回归验证了服务器恢复和随后截图成功；固定的 Linux 最终修复产物已在同一 job 的 attempt4 完成验证。GTK 同一个菜单对象还会同时出现在主窗口树和 popup 树中。精确窗口的指针目标现只在已确认的窗口树内解析原生身份；无窗口限制的歧义拒绝与应用级旧索引含义保持不变。真实 GTK 回归验证了数字 ID 选择使 Alpha 变为 Beta、未知窗口拒绝和同窗口歧义拒绝。popup grab 仍可能阻止焦点恢复，此时明确返回不确定结果并要求重新观察。三端 agent/pipeline 均正常 exit0：macOS57/57 AX、7/7 VLM；Linux48/51程序化、1/1 VLM；Windows68/79程序化、原始54/69 VLM。Linux三项失败对应生成应用行为，没有新的已确认SDK缺陷，也未按分数重跑。Windows固定worker将legacy清单62项VLM替换为schema-v2全部69项，重新纳入7条基线失败项（本次4通过、3失败）；保留原始54/69并注明校准限制，不事后改分母。独立的 review 回归已在隔离原生 Sway 桌面验证同进程 App 窗口选择；更广泛的 Wayland 输入/观察及完整评测组仍未验证，不能据三个case声称完整分数恢复。完整运行标识与证据记录于 `.qwen/e2e-tests/cua-unified-app.md`。
