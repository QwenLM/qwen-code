# OpenTUI Vim、普通历史与反向搜索

[English](2026-10-21-opentui-vim-history.md) | [简体中文](2026-10-21-opentui-vim-history.zh-CN.md)

## 状态与基线

本文是完整交互/实时输出 Draft #15067 的输入部分，与
[dual output](2026-10-21-opentui-dual-output.zh-CN.md) 一起交付，已通过 normal merge
合入 UI `c1f802b0c1d237d9641b8217bdc97e8d37049f51`。已审源码检查点为
`7a1ab30f616c5f688224b1dac1fcf0fc76e26966`；原 A 基底、B v3 与 U4 v6 快照只作
历史来源，不分别交付。输入接纳、附件和取消沿用既有所有者；普通与 Vim 编辑
都由现有 Ink buffer 管理文字、码点光标和 undo。

实际 runtime 产物构建于 `194bfffcdd45e19f007aa28ceeb8dfea8402f84f`；7a1 只将四处
夹具等待改为观察可见模式，字面与 12 秒限制不变。生产和依赖输入逐字一致；测试
使用 7a1 源码和受守卫的 194b 产物，不声称重新构建了 7a1。
本检查点的已记录本地验证已完成：映射的 source/native 门禁、194b 新 build/type/bundle，以及 7a1 全部八个后续阶段。完整三腿 108 个测试行通过，其中 106 个功能通过、两个保留的 Ink deny 缺口；有重叠的 strict 四案另列。prepare 和真实 npm tar 六项执行位检查通过，但不证明统一 R3+B 安装产物或音频录制验收。
已接受安装在依赖/工具/runtime 守卫下复用。原 ba04/f93 声明/源码失败、d677
Unicode 失败、aab54 Escape 失败、b4 过期 `/vim` 提示和 194b raw-wait 失败均保留，
不重标为通过。OpenTUI 保持 `0.5.10`，Bun 保持 `1.3.14`。
父 UI 尚未合并；该检查点不使 stacked PR 变为 Ready。

父提交的 reset discard 结果只释放取消锁，不取回队列或恢复旧草稿；本批保留此
合同，以及旧 generation 不得触碰后继输入的保护。

冻结的 A bundle `8473becd7f80` 复现了共享 Ink 缺陷：真实 `/vim` 后，逐键输入
`2`、`d`、`w` 会把 `one two three` 变为 `three`，但一次 PTY 写入 `2dw` 保留原文。
NORMAL Enter 各发送一次 HTTP，内容与观察结果一致。两案均通过真实模式/设置前置。
此前 native 解析器探针也观察到同样差异。因此这不是 OpenTUI 独有缺陷；B 要让同批
解码按键符合 Ink 逐键语义。原启动夹具失败及两份行为失败均继续保存。

## 范围与所有权

- 复用当前 Ink 全部 Vim 命令族、计数、寄存器、查找/重复与模式切换；不增加 visual
  mode、text objects 或正则搜索。
- 只保留一个 native textarea 视图、一份现有 Ink TextBuffer 作为唯一文字/码点光标/undo
  所有者，以及现有 Vim 解析器；不增加光标历史账本、影子 undo 实现或依赖。
- 普通/shell 历史与反向搜索和实际 live-user、host-history、session 生产者一起交付；
  注入历史不能替代真实接线。
- 保留 A 的编辑、外部编辑器、claimed/pending paste、图片和取消合同。NORMAL Enter
  必须进入普通输入使用的同一接纳所有者。
- 不改变 core 历史/流协议、分发或依赖。slash eligibility/order、删除日志 purge、
  取消 transcript/logger 回滚继续属于完整历史后续工作；本批只是部分历史对齐。

## 共享解析器与 native 边界

现有 `vimReducer` 对每个 action 同步更新 ref，再通过 React state 发布快照。
字符读取使用同一 ref。不需要计时器、新输入队列、另一套解析器或全局 `flushSync`。
Provider 变化仍更新解析器，显示模式来自已发布状态。

解析器当前读取 33 个 Vim 动作、实时 `text/lines/cursor`、范围编辑、undo、INSERT
处理；清空现在属于各真实提交调用方。用结构类型收窄所需输入，不为未使用的 TextBuffer viewport/selection
方法填写假值。现有几何算法和 undo reducer 保持不变；native 只接受视图投影，编辑后不能用显示
坐标反向覆盖所有者的精确码点光标。

解析器位于持久的 OpenTuiEntryApp，与 Ink AppContainer 的生命周期一致；modal 或
session reset 不另行清除计数、寄存器和 dot 状态。composer 仍按 A 的合同卸载，
buffer ref 在卸载时清空，modal 无输入订阅通向 Vim；不保留 disposed textarea。
既有窄 adapter 仅转发到当前 Ink buffer，不存文字、坐标或 undo 历史。
NORMAL Enter 通过当前 composer handle 回到 submitDraft，不绕过 claimed/pending
和拒绝恢复。native 回归验证卸载前后 register/count/dot，以及 modal 按键不消费。

已验收 A 上的纯 API 探针用真实 `0.5.10` 通过了 7 个光标与 6 个 no-op 检查点：
任意光标替换、redo 后输入 marker、移动不增加 undo，以及空 `dd` 保留 Ink 撤销点。
该探针的 `parserInput=false`，不证明本 adapter。原 `2dw`、`fx;` 批次失败继续
保留，包括被夹具阻止的剪贴板调用。

输入所有者顺序遵循当前 Ink：focus/release 与 bracketed paste、可见类别箭头、
Vim，然后适用的搜索/补全/chip/默认处理。启用 Vim 时 raw Backspace 让给解析器。
INSERT 复用现有纯 TextBuffer 键分派及九个编辑回调，不再进入 native 默认键表。
词删除复用 Ink 几何分支，只有现有 Ink buffer 记录编辑、undo 和 redo。pending `r/f/F/t/T` 在 NORMAL 提交
之前拥有 Enter。只有解析器实际接受 Enter 的分支可以调用接纳；清空交给真实调用方，
保留 Ink 行为与 OpenTUI 的拒绝/successor 恢复。不能只依据模式抢先拦截。

## Unicode 修复与视图边界

精确 d677 在 native 门禁和独立诊断中均失败：`i甲🙂éZ` 后 Ink 为 `甲🙂éZ`，
adapter 却为 `甲🙂eŹ`；Escape→x 删除不同码点，undo 恢复相同文字后逻辑光标
仍不同。三序列诊断 v2 完整结束为 TEXT_DIVERGENCE；v1 的 clipboard stub 控制错误
另行保留。不能用显示单元格相等替换精确文字/码点光标断言。

在 OpenTUI React composer 中直接复用 `useTextBuffer`，使用它的同步 state ref/getter
和既有 reducer 处理所有编辑与 undo，不增加离屏 Ink renderer 或复制 reducer。
持久 entry 保留 `useVim` 解析器，通过当前 composer-buffer ref 转发动作为真实所有者。
Vim 热切换不 remount、替换、清空或迁移 buffer/history。dialog 卸载保留既有 composer
生命周期和解析器寄存器、count、dot 状态。

明确采用 Ink 既有 100 条 undo 历史合同，包括 no-op Vim snapshot 和一次有变化的
外部编辑导入；不并行保留 native history。普通输入、raw backspace、bracketed/clipboard
paste、补全、历史/搜索、捕获输入、queue/cancel 恢复及外部编辑均写同一 buffer。
来源/附件继续由既有 composer 事务持有；仅文字/光标变化不能接管 pending 图片或
使后继输入失效。

Native textarea 保持焦点，显示文字、选区和终端光标；它的默认编辑/paste handler
不能修改第二份文字。鼠标和选区是显式输入事件：将可见边界映射到 buffer，执行一次
既有范围编辑，再清选区。投影产生的光标事件不能把显示列重新转换并覆盖码点。
Native widthMethod、换行、滚动和 resize 仍是真实视图边界；combining mark、ZWJ
必须验证下一次编辑，不只比较单元格。若固定 API 无法保留某项选区或投影行为，先
报告具体边界，不增加通用抽象规避。

必验项包括原三条严格序列、普通输入与选区替换/undo/redo、鼠标后输入、小/大/图片
paste、IME 提交分块及真实焦点/光标、外部编辑和同文导入、Vim 热切换、换行/resize
移动、queue/session 后继。真实设备 IME 和未执行平台仍为 NOT_RUN。上方检查点
记录真实 owner 验证；不以旧 d677 unit 通过证明已变更 owner。

## 历史、搜索与模式消费者

作为完整能力恢复保留的历史/搜索改动，不搬回旧整批候选。复用历史/搜索 hooks 与
当前按键 matcher；仅在实际 host-history/session 变化时刷新 logger 快照，丢弃旧
响应，并合并当前普通用户消息，不在每个 token 重读。shell 历史/搜索和 Escape
快照遵循当前 Ink。

历史取回优先使用 `recallText`，并保留 non-steer 过滤。反向搜索选中的历史项即使与
当前草稿文字相同，也属于导入输入，必须在接纳前丢弃恢复来源身份。查询被编辑或
清空后，Esc 恢复原文字、光标、known/unknown 来源、restored draft，以及粘贴内容
和占位 ID 映射；选中的历史行不得复用已放弃草稿的映射。Vim 既有的非空粘贴回调
接到当前 composer，并将导入输入标为 unknown；空剪贴板粘贴保留来源。Ink 同时
保留真实提交 metadata 与此回调。合并边界不改变 parser 命令族；Unicode 修复改变编辑所有者，但不改变 metadata 合同。

搜索与 Ink 共享无 renderer 依赖的 label 计算：150 个 UTF-16 单元、相同匹配窗口/
高亮，以及 active 长候选上的 `→`/`←`。保留 149/150/151、inactive 行、首/中/尾
匹配和实际展开/折叠证据；不改变 slash/@ 补全或无关建议列。

现有 Vim provider、`/vim` action、设置与可见模式提示已有真实生产者/消费者。
统一父提交提供共享 status-line hook：entry 的已启用模式同时传给 footer 和 hook
的 `vimMode` 输入。NORMAL、INSERT、关闭状态有 collocated 接线回归，既有 hook
测试覆盖 JSON 生成。检查点按声明范围记录整合后的 native/产品证据，不复制 U3 实现。

## 交付与验收

解析器同步、native adapter/所有者、历史/搜索和 status 模式与现有 live-output
bridge 接线一起交付。原 B v3 草案为 3137 变更行，U4 v6 为 1869；相加不代表
最终净差异。整合冻结清单分别报告实际生产、测试和文档规模。本次归一遵循用户要求
的同一 review 批次，不为行数删除命令族或负向断言。

验收要求共享 parser/action 测试、真实 native batch/caret/no-op/undo/owner 测试，
以及 Node+Ink、Bun+Ink、strict Bun+OpenTUI 三条产品腿。验证真实 `/vim` 持久化、
精确提交与拒绝恢复、本会话 submit→HTTP→Ctrl+R→候选→resubmit、搜索箭头/窗口、
shell 历史和 resize；同时覆盖 A 的输入/附件/取消回归。unit callback 不能证明
decoder、剪贴板、native 所有权或 HTTP 行为。冻结完整 source/dist/fixture/runtime
身份，保留首败并核实 owned cleanup。构建/typecheck、受影响门禁及两次全 diff
干净自审完成后再独立验收。当前检查点及 source/artifact 映射见上文。统一 R3+B 安装产物、真实 middleware
和未执行平台仍是独立门禁。
