# OpenTUI 编辑事务：编辑、外部编辑器与取消

[English](2026-10-21-opentui-editor-transaction.md) |
[简体中文](2026-10-21-opentui-editor-transaction.zh-CN.md)

当前交付（2026-10-21）：本工作与输入所有权、编辑和状态栏统一整合到
[#14964](https://github.com/QwenLM/qwen-code/pull/14964)。下文原分批边界、代码基线、
验证结果及 stacked PR 转正式步骤均为历史记录；当前推进顺序以
[交付计划](2026-10-20-opentui-migration-delivery.zh-CN.md)为准。
统一验收仍待完成，必须以整合提交的新结果为依据。

## 状态与边界

[剪贴板与来源生命周期批次](2026-10-24-opentui-clipboard-source-lifetime.zh-CN.md)让外部编辑继续使用同一原始展开草稿和最终提交所有者。模型归因只在待完成粘贴落定后添加，不由编辑器或已准备的 Retry 重做。该候选验证与下文历史结果分开记录。

A 批基于 U2A `269600799782a5c507d62f3ae0db011c768be234`
（[#14946](https://github.com/QwenLM/qwen-code/pull/14946)），从完整保存的
U2B v10 候选拆出，使一个完整事务符合预期 2–3k 行审查规模。
本机作者与独立验证已在新 A 源码和 bundle 上通过：build/typecheck、
488 项定向、两份原生脚本、三腿各 19 个正式产品场景和 U2A ownership 回归。
独立验证重新运行 16 项 Node+Ink 对照与相同的 16 项严格 OpenTUI 场景，
源码/产物 guard 未变，清理通过。Linux CI 与 Windows 仍待验证；
旧整体候选结果继续仅作来源证据，与本次新验收分开。

包括字符/词/行编辑、原生 undo/redo、外部编辑器交接，以及完整主输入
C/D/Escape 取消与退出所有权链。保留 OpenTUI 0.5.10、Bun 1.3.14、唯一
原生 textarea 和 U2A 既有队列。本批不改依赖、运行时、分发或 core。

普通/shell 召回、当前历史 producer 和 Ctrl+R 搜索留 B，与 Vim 导航/键所有权
一起设计。已保存的搜索箭头失败和 v10 未验修复继续开放。Slash 召回资格、
delete/logger purge、取消后的 transcript/core/logger 回退须另行调查，不为
行数目标加入。本批不覆盖系统剪贴板、IME、无障碍或其他对话框/worktree/
`btw` 退出合同。

## 编辑与终端交接

原生 textarea 拥有文本、选区和 undo。Home/End、Ctrl+A/E 使用视觉行边界；
Ctrl+K/U 在逻辑行边界连接相邻行。Ctrl+Z、Shift+Ctrl+Z 使用原生 undo/redo。
词移动复用 Ink 纯逻辑目标计算和现有 code-point/display-column 转换；
原生 buffer 仍是唯一写入所有者，release 不重复执行动作。

共享 Ink 外编调用：显式覆盖、首选编辑器、`VISUAL`、`EDITOR`、平台默认；
文件 mode `0o600`；原 Windows 校验/引用；继承 stdio；30 分钟超时；CRLF
归一及临时目录清理。保留 sandbox 策略和原有全部失败行为。

OpenTUI 等所属 pending paste 完成再取外编快照。Clear、submit、会话替换、
unmount 使迟到输出失效，不能覆盖 successor 或其附件。启动前 suspend，
在 `finally` resume；修改输出作为一次原生 replace/undo 事务，光标放末尾；
无修改不新增 undo。成功、无修改、非零退出、signal、延迟返回后均验证继续
输入和 resize。

## 取消与退出所有权

Ctrl+D 读取实时 composer：非空 D 继续编辑。C 在清理前 arm，快速第二 C
退出。响应中空 D 取消而不预先 arm。等待审批时 D 保留确认并 arm D/D 退出；
C 取消确认且保留退出窗口。复用既有过期/混合键 guard。确认的键盘退出在
三个 renderer/runtime profile 均须完成共享清理后以 0 退出；真实 OS signal
终止保留原信号码。历史 0/130 观测继续作为基线证据，不代表接受差异；
harness 清理不等于优雅退出。

Composer 取消在当前 live-turn sequence 注册一个回调。回调、结构化队列
pop、草稿恢复和入口 C/D 分派整体保留本批。Abort 的生成器收尾后，将返还
文字/图片放到当前 successor 前。仅未开始工具，且同一个空草稿/会话仍有效、
没有队列、pending paste 或 claimed submission 时恢复原准入提示。Generated
turn 不作为可编辑内容返还。Reset/unmount 使旧回调失效；所有 aborted turn
禁止自动重放队列，裸 `/quit` 不恢复或重启迟到的 steering。

U2A pending Enter claim 仍独立，清 successor 不取消该 claim。输入恢复不代表
transcript/core/logger 回退；保留附件 bytes/provenance、恰好一次准入及
successor 优先级。

## 产品消费方

| 合同                | 消费方                                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| 共享词目标          | Ink text-buffer reducer；OpenTUI key adapter                                  |
| 共享外部编辑器      | Ink TextBuffer → BaseTextInput/shared TextInput；OpenTUI composer             |
| 首选编辑器          | 既有 settings → app shell → composer → invocation                             |
| Composer handle     | 入口早期输入/C-D；app shell；composer                                         |
| Cancel-settled 回调 | Composer Escape/入口 C-D → live-turn 当前 sequence finally → composer restore |
| 结构化 pop          | 既有 live-turn/deferred-command 队列 → composer；裸 quit 清理但不恢复         |

## 验证与验收

使用统一 heavy lease、串行命令、单 worker、零 retry，unhandled 计失败。
改动 CLI 测试前先对 A 工作树 build/typecheck。保留共享 text-buffer/editor
测试和 composer/live-turn/start 所有权用例，包括迟到 steering/图片、pending/
claimed 输入、reset/unmount、generated/tool-start 排除及裸 abort 不重放。
PTY 取消成功不能替代这些 seam。

运行真实原生编辑/undo/decoder 和 U2A ownership 回归。原生外编 backend
为注入；真实进程由 owned editor 覆盖，在隔离 HOME/TMPDIR 中记录参数、
mode、输入输出和 exit。A 的 19 个产品场景跑 Node+Ink、Bun+Ink 和 strict
OpenTUI，断言可见文本/光标效果及精确 HTTP 载荷/次数，而非仅 exit0。

独立验收包括 exit5、word8、editor2、cancel1：无自动重发，然后显式重发
完整 successor 恰好一次。使用 A 自有夹具路径和新源码/产物 manifest；
旧树 wrapper 仅换环境变量不能验证 A。保留首次失败、输入 bytes、原始 ANSI、
可见帧、运行时 hash 和清理结果。修复并验证后完成两遍干净全 diff 自审。

本机 `.qwen/e2e-tests/u2b-editor-transaction-plan.md` 测试计划记录来源映射及
历史证据。独立原生 Markdown 对 `HELD_HEAD_1HELD_TAIL_1` 隐藏词内下划线，
取消夹具换 sentinel 并未修复该 transcript 差异。OpenTUI 0.6.6 仍有相关
编辑键位差异，因此本批不升级依赖。
