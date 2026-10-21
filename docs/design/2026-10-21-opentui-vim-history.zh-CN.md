# OpenTUI Vim、普通历史与反向搜索

[English](2026-10-21-opentui-vim-history.md) | [简体中文](2026-10-21-opentui-vim-history.zh-CN.md)

## 状态与基线

本文是同一交互与实时输出后继批次的输入部分，通过 normal merge 合入统一 UI 提交
`4cabbc7f5af1b344d4648d7e316b8c2b574de74a`，保留 B 从
`e5143ba8e4cb431ef48f390f59922216544849fd` 到
`12039c2cb4fe4065fe73c57d392219c8a767cf08` 的历史。本批整合冻结 B v3 和
[dual-output v6](2026-10-21-opentui-dual-output.zh-CN.md) 草案，不分别交付。
原 A 基底设计与证据保留作来源。输入接纳、附件、取消与 native undo 沿用既有所有者。

ba04 的实际 frozen setup 已通过；依赖/lock 输入和八项已安装工具/hook 身份未变，
允许复用，无需重新安装。ba04 构建因两处测试/类型声明失败；f93 源码独立复现了
五个失败回归案例，六个正控通过，原始失败均保留。声明修正和两处生产修复现已提交，
但最终整合源码的全量构建、typecheck、focused、native 和产品验证仍为 **NOT_RUN**。
此前结果不能证明本树。OpenTUI 保持 `0.5.10`，Bun 保持 `1.3.14`。

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
- 只保留一个 native textarea、一份 native undo 历史和现有 Vim 解析器；复用逻辑
  移动/范围算法，不用 native 词边界或视觉移动替代。
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
方法填写假值。现有几何算法原地复用，保留 Ink 兼容入口；native 使用现成工具转换
逻辑码点坐标。

解析器位于持久的 OpenTuiEntryApp，与 Ink AppContainer 的生命周期一致；modal 或
session reset 不另行清除计数、寄存器和 dot 状态。composer 仍按 A 的合同卸载，
ref 回调清空 native editor，modal 无输入订阅通向 Vim；不保留 disposed textarea。
NORMAL Enter 通过当前 composer handle 回到 submitDraft，不绕过 claimed/pending
和拒绝恢复。native 回归验证卸载前后 register/count/dot，以及 modal 按键不消费。

已验收 A 上的纯 API 探针用真实 `0.5.10` 通过了 7 个光标与 6 个 no-op 检查点：
任意光标替换、redo 后输入 marker、移动不增加 undo，以及空 `dd` 保留 Ink 撤销点。
该探针的 `parserInput=false`，不证明本 adapter。原 `2dw`、`fx;` 批次失败继续
保留，包括被夹具阻止的剪贴板调用。

输入所有者顺序遵循当前 Ink：focus/release 与 bracketed paste、可见类别箭头、
Vim，然后适用的搜索/补全/chip/默认处理。启用 Vim 时 raw Backspace 让给解析器。
INSERT 复用现有纯 TextBuffer 键分派及九个编辑回调，不再进入 native 默认键表。
词删除复用 Ink 几何分支，只有 native buffer 记录编辑、undo 和 redo。pending `r/f/F/t/T` 在 NORMAL 提交
之前拥有 Enter。只有解析器实际接受 Enter 的分支可以调用接纳；清空交给真实调用方，
保留 Ink 行为与 OpenTUI 的拒绝/successor 恢复。不能只依据模式抢先拦截。

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
保留真实提交 metadata 与此回调。合并边界不改变 native undo 或 parser 命令族。

搜索与 Ink 共享无 renderer 依赖的 label 计算：150 个 UTF-16 单元、相同匹配窗口/
高亮，以及 active 长候选上的 `→`/`←`。保留 149/150/151、inactive 行、首/中/尾
匹配和实际展开/折叠证据；不改变 slash/@ 补全或无关建议列。

现有 Vim provider、`/vim` action、设置与可见模式提示已有真实生产者/消费者。
统一父提交提供共享 status-line hook：entry 的已启用模式同时传给 footer 和 hook
的 `vimMode` 输入。NORMAL、INSERT、关闭状态有 collocated 接线回归，既有 hook
测试覆盖 JSON 生成。这些源码接线仍须整合后的 native 与产品验收，不复制 U3 实现。

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
干净自审完成后再独立验收。最终整合源码的新验证仍为 **NOT_RUN**；已接受的安装复用
见上文。
