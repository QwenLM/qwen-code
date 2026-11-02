# OpenTUI 输入框附件与提交所有权

[English](2026-10-21-opentui-input-ownership.md) |
[简体中文](2026-10-21-opentui-input-ownership.zh-CN.md)

当前交付（2026-10-21）：本工作与输入所有权、编辑和状态栏统一整合到
[#14964](https://github.com/QwenLM/qwen-code/pull/14964)。下文原分批边界、代码基线、
验证结果及 stacked PR 转正式步骤均为历史记录；当前推进顺序以
[交付计划](2026-10-20-opentui-migration-delivery.zh-CN.md)为准。
统一验收仍待完成，必须以整合提交的新结果为依据。

状态：U2A 已完成基线复现、实现及本地验收。基线是 U1
`69ffa32d46a1283fb1f1dc224e105275c1ebe493`；分支
`codex/opentui-input-ownership` 依赖 `codex/opentui-dialog-acceptance`，
因为复用 U1 的真实产品 renderer/runtime fixture。本次完整交付一个输入事务，
包括恢复和回归测试。

## 问题与范围

基线 OpenTUI 在异步命令入口确认前清空文字和附件；晚到剪贴板结果可能进入下份
草稿，并行粘贴可能颠倒图片顺序，纯字符串 live 队列会丢图。Ctrl+Q 有提示却无
生产输入消费方。独立基线在两个正控通过时复现六项组件/hook 缺陷；native 和
真实产品证据分开记录。

覆盖粘贴、附件选择/删除、接收、拒绝、steering、延后、取回、取消及继续编辑。
复用原生 textarea、React refs、现有命令/shell/model 队列、剪贴板工具和 core
媒体策略。不新增状态框架、队列服务、依赖或运行时变更。Vim、通用编辑与历史
搜索、外部编辑器、语音、IME、无障碍仍单独跟踪，本批不宣称全部输入能力对齐。
全局 Ctrl+C 与退出处理级联尚未在本批验收，U2B 将对当前 Ink 建立产品基线；
本批不宣称已修复或完整对齐取消/退出按键。

## 与 main 输入来源的整合

[剪贴板与来源生命周期批次](2026-10-24-opentui-clipboard-source-lifetime.zh-CN.md)在现有所有权事务上补齐共享的 Ink 模型归因、原始 human 文本、Linux offered-text 回退及保留来源的队列合并。待完成的文本粘贴继续使用已认领草稿捕获的映射，后继使用独立映射。该批次仍在实现，候选验证单独记录；下文旧结果保留历史范围。

本次 normal merge 固定 main `8545558a25db342683cb84a6814e591c6fcf6c67`，
保留 #14876 的 workflow 关闭设置、human-input 描述、显示/历史取回文本分离与
粘贴展开快照。元数据随现有结构化提交流经 composer、shell 延后、live 队列及
取消恢复，不增加第二队列或隐式的全局取回文本。等待图片前同步捕获文字、来源
和 paste map；后继草稿不能改变这份快照。混合来源原样恢复时只保留原有已知
human 成员，编辑未知来源文字不会获得 human 身份。队列取回保留图片，并使用
现有 helper 重命名冲突的占位符。

session 轮换使待完成图片、已占有提交和取消回调失效；仍挂载的编辑器按 main
回归合同保留同步可见文字、粘贴映射及未知来源资格。reset 结算只清取消 latch，
不能弹出队列或恢复旧内容。本次组合仍待新验收，旧分支绿灯不覆盖此 merge。
保留两父分支的回归，并新增 pending-image/后继草稿、接收拒绝及 session 轮换
来源断言后再验收。

## 基线决策

精确 U1 artifact 的真实 Node+Ink、Bun+Ink PTY 确定了以下行为：

| 输入               | U2A 决策                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 空闲/流式 Ctrl+Q   | 空闲时立即接收一次；流式时等 turn 结束，不参与工具边界 steering。                                                    |
| 仅图片 Enter       | 保持 Ink 的 no-op，保留 chips。                                                                                      |
| 图片加 `/help`     | 按已观察 Ink 路由发给模型。completion submit-on-accept 共用该路由；其 Ink 接线目前依据源码。                         |
| 图片加 shell 模式  | 拒绝并保留草稿。Ink 会尝试执行前缀图片路径；这是已见证缺陷的明确例外。                                               |
| 有效加缺失图片路径 | 所有复制成功才提升；任一失败保留整段原文，不附加部分成功项，并提示错误。Ink 静默丢失缺失路径，这是第二个已见证例外。 |

Ink 现有 `@` 图片 overview 将 69 字节 PNG fixture 转为稳定的 268 字节 JPEG；
OpenTUI 结构化路径保留 PNG。按各路径检查预期 hash、MIME、长度，不能为相同
线上编码改动媒体策略。全局 0.23.0 dry-run 仅作历史对照。

## 接收与草稿所有权

Enter、Ctrl+Q、补全 submit-on-accept 共用一个事务。读取原生当前文字，展开
占位符，捕获图片及原始提交来源，在第一次 await 前同步占有；重复激活不能再次
占有同份草稿。boolean 确认表示 dispatcher、shell 队列、live 队列或 turn 已接管，
不表示模型已响应。缺少接线、gateway 拒绝、接收异常或图片读取失败不能确认成功。

立即清掉已占有编辑器内容，让后续输入拥有独立草稿；确认前保留快照。拒绝时按
现有空行聚合约定把文字和图片恢复到后续草稿之前；恢复的显示占位符必须与
捕获的展开映射一起保留。
原样重试保留来源，合并或编辑后重新计算。在 `finally` 中释放占有；补全和 chip
重置只作用于该草稿。session 轮换或卸载使晚到恢复和粘贴完成失效。

附件 ref 同步拥有载荷，React state 负责展示。异步 paste 在 await 前捕获草稿；
后端工作可以并行，结果必须按到达顺序应用。提交等待已占有 paste，后续文字和
paste 属于下一草稿。Enter 已占有后，Ctrl+C 只清空可编辑的后继草稿，不会取消
正在等待 paste/admission 的已占有提交。清空/销毁 owner 后忽略晚到结果。纯图片
路径先于大段折叠
分类，复制到现有 owned clipboard 目录；混合文字保留为文字。剪贴板不可用复用
现有翻译回调，仅提示一次；普通文字剪贴板保持安静，错误必须可见。

输入首行 Up 选择附件，Left/Right 移动，Delete/Backspace 删除，Down/Enter/Escape
回到编辑；删除最后一项时退出选择。其他按键退出选择并继续正常输入分派，
包括文字和 Ctrl+Q。队列取回同时
返回文字和图片；early-input 的 get/set handle 保持兼容。

## 队列与送达所有权

现有 live 队列保存结构化提交：文字、图片路径、原始来源及 `deferUntilIdle`；
私有载荷保留接收后的图片字节和 generated 内容/options。接收前读取图片，任一
读取/格式失败就拒绝整份草稿；已接收队列不依赖后续源文件变化。可见队列仍是
文字投影，数量按提交计。generated prompts 保留 invocation echo 和 per-turn
options，延后执行，不进入无法应用每条 options 的 steering。

| 边界                  | 必须结果                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 流式期间 Enter        | 将一份完整图片载荷放入可 steering 队列。                                                                                |
| 工具边界              | 按顺序取走可用条目，Ctrl+Q/generated 留在队列。                                                                         |
| steering 解析期间取消 | 原结构化 batch 恢复到后续条目前面且仅一次。                                                                             |
| continuation 结算     | 复用 core `SteerInput` 所有权回调；accept 后提交 echo/recording，拒绝时 restore。任意首个 stream event 不代表送达确认。 |
| turn 结束             | 现有 follow-on drain 接收下一条，包含延后提交。                                                                         |
| 取回                  | 删除并返回 composer 条目的图片/来源；generated 载荷保留其执行 owner。                                                   |
| session 重置/退出     | 旧工作失效并丢弃关闭 session 的队列。                                                                                   |

这里的 core accept 表示本请求已接管 chat history 内容，不等于 HTTP 成功或模型
响应。后续 stream 报错也必须服从该回调，不能按 event 类型猜测所有权。唯一
live-turn 调用方传入当前 generation 判断：重置/卸载回合的晚到 accept 不能写入
后继 recording 或 echo；同 generation 的 interrupt 不撤销 core 已接管的历史。

shell 延后队列保留既有命令顺序和 shell-intent 标签。shell 执行阻塞的带图普通
prompt 保留 options/图片；后续 live owner 拒绝时，条目继续允许取回重试，不能
丢弃或自动循环重试。

新 turn 和 steering 的 typed `@` 引用在现有 vision bridge 前解析，同时保留图片
Parts。现有 `@` 明确读取拒绝/超时以及 vision bridge null 仍按 Ink 提示后消费，
不新增 parked retry 队列。解析完成即显示这些失败卡片/提示，即使 core 随后恢复
同 batch 的有效条目；成功卡片/echo 则等待 accept。因此本批不承诺每种发送前
拒绝都保留输入。core 媒体
限制、超限提示和 provider 合同保持不变。

## 生产修改与消费方

| 接口             | 生产方及所有受影响消费方                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 接收结果/options | 输入 Enter/补全/Ctrl+Q → app-shell gateway → 原 start 转发 → live-turn submit；shell 延后 prompt drain 同样消费结果。                                  |
| 结构化载荷       | `input-submission.ts`；composer 恢复；live-turn push/drain/restore/pop/reset/follow-on；live-session 解析及 continuation 所有权；shell 取回/展示投影。 |
| 粘贴/chips       | 输入剪贴板/路径处理、选择/删除、原始 Backspace、占位展开及销毁。纯路径分类器与 Ink 共用，不改 Ink 行为。                                               |
| 展示/session     | 原队列展示/footer 数量、input queueLength、session 轮换和 early-input 注入；每个新增字段都有实际生产消费方。                                           |
| 回归             | 原 input/app-shell/live-turn/live-session suites；真实原生输入脚本；U1 PTY/xterm/localhost fake-model fixture；现有三腿 CI。                           |

不能形成 live-session → live-turn 循环导入。检查 #14287（busy admission）、
#14172/#6829（剪贴板）、#7957（Windows 路径）、#12227（Ink activity）的冲突。
不带入 #13606 的 provider/media 大范围架构或 #12228 的 Vim 工作；stacked PR
提升前 rebase 到 U1 实际合并结果。

## 验证与完成

使用隔离 HOME/QWEN_HOME/runtime/workspace 和本地假模型，不改用户剪贴板，不访问
付费 provider。组件受控 Promise 证明顺序，不能冒充 native/系统剪贴板 E2E。
原生测试使用真实 textarea/input decoder，并标明注入的 clipboard backend；产品
测试使用真实路径粘贴和 HTTP 载荷。缺原生资源或 fallback 不能算 PASS。

覆盖拒绝/throw 后继续输入、同 batch CJK/emoji+Enter、两次 paste 逆序完成、
clear/unmount/session reset、仅图 no-op、chip keys、Ctrl+Q 与 steering、图片
排队、取回、混合 `@`+image 成功及明确拒绝、部分路径复制、continuation
accept/restore 恰好一次。检查 100×30、80×12、40×10 及 resize/restore；断言
次数、顺序、MIME、解码长度和预期 hash，不能只看图片字段或截图。

完成前在最终 artifact 上跑 build/typecheck、定向 unit、native 回归，以及
Node+Ink/Bun+Ink/Bun+strict OpenTUI 产品三腿。在 `.qwen/e2e-tests/` 记录
source/bundle/fixture/runtime 身份、原始输入、viewport、请求及清理结果。修复后
完整阅读 diff 并反证绿色 oracle，连续两轮干净自审才完成。parent 统一协调单一
重型 lease。macOS 结果不代表 Linux/Windows 剪贴板或 IME 覆盖，须保留在迁移
总清单中。

macOS arm64 本地验收已通过完整 build/typecheck、313 项定向用例与四项既有
classifier、固定 Bun 原生回归，以及 Node 24.19.0+Ink / Bun 1.3.14+Ink /
Bun 1.3.14+strict OpenTUI 六项正式产品测试。独立验收通过 24 项所有权、九项
native 和 14 项产品场景；四个已见证 Ink 例外单元明确跳过。修正后的图片场景
验证 typed 文件展开，以及两张不同图片经 Enter steering / Ctrl+Q 延后的完整
字节，分别使用各路径空闲发送作为 oracle。

独立 before/after snapshot 中 17 个源文件及 1,453 个构建文件完全一致；包含
保留的 fixture 失败尝试在内，17 次 PTY 均完成清理。原始失败继续保留：held
stream 无法达到输出静止、Ink 标题冒号被裁切、active 路径补全消费 Enter。
仅修正 fixture 假设，产品源码与 bundle 始终冻结。两轮干净全 diff 自审、独立
审查及原始报告随候选 manifest 保存在 `.qwen/`。本地结果不能替代剩余平台门禁，
也不代表完整 Ink parity。
