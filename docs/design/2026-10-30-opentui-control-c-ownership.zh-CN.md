# OpenTUI 字段清空与 Ctrl+C 所有权

[English](2026-10-30-opentui-control-c-ownership.md) | [简体中文](2026-10-30-opentui-control-c-ownership.zh-CN.md)

## 问题与状态

本改动前，OpenTUI 的 Auth、Permissions 字段缺少 Ink TextInput 的 Ctrl+C 清空操作。进程全局退出 handler 也仅检查键名/control，没有遵守原 QUIT 绑定排除 Shift 的规则。这是同一输入的两个独立 owner，不应把它们视作互斥的命令解释。

新增 12 个单元回归均已到达预期 RED 失败。本分支现已应用实现，本批范围内的验证结果见下文。初始运行还保留了既有 resize fixture 的失败：绝对临时路径超过对话框的 100 列上限。尝试扩大视口时，先出现 `wideWidth` 作用域错误，修正后仍受该上限影响；两个观测均保留。便携性修正现在只在四列隐藏输入阶段前后、宽度 100 时检查可见的父目录 basename；提交仍要求精确完整 realpath。隐藏输入、补全和尾随 TAINT 守卫保持。

首次全局安装 Ink 运行在发送 Ctrl+C 前就因原输入行观察器失败：Ink 绘制双层边框及 `> ` 前缀。修正为两个显式 renderer 行模式，仍精确匹配 `WebFetch`。另行绑定的第二次全局 Ink 运行通过了整个新公开场景，模型请求为零并自然退出。首次观测失败保留；该安装基线不证明候选 OpenTUI 已通过。

## 决策与范围

在既有字段 hook 增加明确的 `clear()` 事务。非空且有效的字段只提交一次空值，保留文本/光标 Undo 及既有 100 条历史合同；空字段或 settled 字段不操作。保留[对话框编辑设计](2026-10-30-opentui-dialog-editing.zh-CN.md)中的 owner 接受/检查点限制。真实数字上下文 owner 接受空字符串；测试其接受后的 `auto` 显示，以及 Undo 后提交原数字。自定义 model 文本先原样接受，再单独归一化 model IDs；model search 原样接受文本。

只在具有焦点的 Auth URL/API-key/自定义 model/search/数字字段和 Permissions 规则/目录字段接入原 CLEAR_INPUT matcher。保留视图、可见性和 settled 守卫。不把 Ctrl+C 加进同时服务密码/手写输入的纯 reducer。Sources、AskUserQuestion 和非敏感 acquisition 设置继续明确待办；不自动替换 Discover 手写搜索及敏感密码 Ctrl+U 行为。外部编辑器另行处理。

局部清空不能通过 `preventDefault`、`stopPropagation` 吞掉进程全局事件。Ink 将 Ctrl+C 广播给字段与 app owner：首击可以清空同时预置退出，既有窗口内第二击可以退出。全局入口复用原 QUIT/EXIT matcher，不改变 release 过滤、取消、guard 窗口或 composer 非空时的 Ctrl+D 门槛。Ctrl+D 不编辑对话框字段；全局能否处理它不取决于该字段长度。

主 composer 的独立 Ctrl+C 分支也使用自己的 CLEAR_INPUT matcher 与 owner 回归，使 Shift+Ctrl+C 保留草稿。全局 matcher 修复不能证明 composer 行为，mock 的已解码按键测试也不能资格化终端字节解析器或完整 C/D modifier/时序对等。没有真实生命周期证据时，不能从局部成功推广到 parked question 的 Cancel 顺序或认证专用退出窗口。

## 公开验证

复用既有 `tui-editor-parity.test.ts` scenario 与公开 `InteractiveSession`，不新增 driver。新增 `permissions-clear-undo-replace-without-model` 用例沿用 90 秒限制、零重试：进入 `/permissions`，paste `WebFetch`，清空到 placeholder 并观测退出提示，Undo 恢复精确原字段行，在独立的再次清空前观测 guard 到期，替换为 `Read`，实际经过 scope 选择并要求设置只含 `Read`。返回 composer，以 `/quit` 自然 exit 0/signal 0，并要求模型 HTTP 请求为零。

在已记录的全局安装 Ink 基线之后，对单独构建的候选执行 Node+Ink、Bun+Ink、strict Bun+OpenTUI。固定的公开 `options.command` 必须携带原完整 CLI 参数。除非另有独立观测，基线只记录有限的启动器字节/realpath；产品 commit/version/runtime 保持未知，并与 harness HEAD、diff、Node 身份分开。不能用 harness bundle 或版本探测代替安装产品身份。

保留原 RED 和任何基线观测失败。若新观察器不能建立预期 UI，应检查真实帧，不能放宽精确行、推定基线通过，或未经资格核定就宣称不同安装版本存在缺陷。验收前运行受影响完整单元文件、既有退出/取消守卫、build/typecheck 和 lint。本批次不完成整体迁移、不切默认 renderer、不移除 Ink。

最初八个完整单元文件共 612 项通过。随后审查发现接受 Tab 补全后旧目录错误仍显示；新回归先实际失败，一行修正后两份完整 Permissions 文件共 28 项通过。修正后 build、typecheck、lint 及正常 bundle 均完成。最终源码 bundle 在 Node+Ink、Bun+Ink、strict Bun+OpenTUI 下各通过三个公开整案：Source 历史/取消/冷启动读取、Permissions 补全及 Ctrl+C 清空/Undo/替换。九次执行共 12 次自然退出，模型请求为零；初始空 store 和持久化数组均加强为精确断言。这是受审 working diff 的源码 bundle 证据，不代表安装包或已合并 main 的最终资格。
