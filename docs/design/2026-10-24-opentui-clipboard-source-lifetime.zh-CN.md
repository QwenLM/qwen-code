# 剪贴板粘贴与输入来源生命周期——实施计划

[English](2026-10-24-opentui-clipboard-source-lifetime.md) | [简体中文](2026-10-24-opentui-clipboard-source-lifetime.zh-CN.md)

## 状态与交付边界

实施基座为B #15389，e2e80ab46423a918e1b7f504a5369074e62bc360。相关输入源码与验收整合版本e7ac逐字相同。同一fd4安装包在Node+Ink及Bun+Ink下通过精确模型请求断言；strict OpenTUI发送原始内容，缺少来源说明。该失败已走到真实模型回复并自然退出，HTTP关闭及原生运行时证据齐全。原差异RED保留，当前进入实现阶段，修后验证尚待完成。本提案不重新移植已合并Vim/live-output，不加入voice、screen reader、marketplace、工具外编、分发或checkpoint持久化。

一个完整批次覆盖剪贴板/粘贴接入、提交、延迟/steering、取消恢复与召回。预计约1.8–3.0k变更行，包含独特测试、真实E2E与双语文档；不是为了达标删断言的硬上限。不新增store、React树、core schema、运行时开关或通用输入框架。

## 当前精确生产者与消费者

| 边界               | 真实源码                                                                                                | 当前合同/缺口                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Ink编码            | components/InputPrompt.tsx146–230、741–798                                                              | 精确归因说明；反斜杠与字面标记转义；仅实际匹配placeholder才加一次suffix；humanInput原文；shell及无附件slash保持raw。         |
| Ink恢复            | InputPrompt850–865；AppContainer2753/3250/3674/3758/3922；hooks/useMessageQueue172                      | 召回去framing；raw/display/source/paste快照与冲突改名已存在，保全所有消费者。                                                |
| 共享raw工具        | utils/paste-placeholders.ts8–65                                                                         | 原文展开与restorePasteDraft冲突改名；不得把raw展开暗改成model编码。                                                          |
| OpenTUI认领        | input-prompt518–564、609–632、840–1070                                                                  | 已有draft.valid/pending/claimed、后继替换及结构化拒绝恢复；提交却仍用同一raw展开值作为model与human。                         |
| 剪贴板接入         | input-prompt1131–1228、1287–1310；clipboardUtils826+                                                    | queuePaste在draft owner内排序异步结果；无图/save失败未读Linux offered-text；纯图路径提升未看shell。原helper非Linux返回null。 |
| 排队/来源          | input-submission全文；app-shell1070–1200、1230–1304；live-turn315、555–723                              | 已区分display/model/submitted/human/map/unknown；弹回未编辑草稿覆盖modelText；编辑未知内容不能变已知。                       |
| steering/Retry     | live-session787–865、1377–1410；live-turn queue消费者                                                   | 普通发送携带一次来源；Retry复用prepared内容，不得重新framing或重读；steering读取完整队列项。                                 |
| history/Vim/editor | input-prompt1430–1540、1895–1978；input-history；start-opentui-ui249；vim-buffer；input-prompt1339–1386 | Vim走同submitDraft；搜索取消快照已有map/unknown/provenance；shell历史独立，不重写这些owner。                                 |

读点包含OpenTUI之外的AppContainer/useMessageQueue。提取pure函数时这些消费者合同必须保持等价。Ink原exports保留re-export以兼容现有测试/导入，禁止一个renderer导入另一个renderer组件。

## 最小修改方案

1. 将现有CLIPBOARD_PASTE_FRAMING、wrapClipboardPaste、framePasteExpansion、unframeClipboardPastes原样移入既有pure paste工具（体量要求时可放相邻pure模块），导出当前局部frame函数。Ink原分类与exports不变，保精确匹配、空白、转义、无匹配行为；expandPendingPastePlaceholders/restorePasteDraft仍是raw语义。这是两真实提交者共享代码，不是新抽象层。
2. OpenTUI submitDraft在await前认领raw文字、source快照和现有draft，pending完成后才结合当前提交捕获的shell模式与最终附件数决定model文本：shell raw；无附件slash用Ink同一isSlashCommand分类保持raw；其余仅给实际匹配的折叠粘贴加一次framing。humanInput始终raw展开且遵守原known规则；displayText保持可编辑placeholder，submittedPrompt保持真实用户形式，imagePaths独立。带图slash仍走model。不能在paste时、dequeue、@file展开或Retry时追加归因。
3. 异步来源映射继续归现有draft owner。优先捕获已有map引用；若必须把map挂在Draft上，它是同一pending map的别名，不建第二store。真实写者为newDraft/restorePasteMap/接入，读者为late paste、submit快照、拒绝恢复及Vim capture。claimed草稿保自己的map，活动后继保另一map，旧操作不得读取后继当前map/mode。late文本fallback复用同折叠/placeholder逻辑，包括submit已claim情形；编号由捕获map推导，restore冲突仍用restorePasteDraft。不新增持久来源或provenance schema。
4. Ctrl+V无图或save失败调用既有readClipboardText，再走同一普通粘贴接入；只覆盖原helper支持的Linux offers，null/空读不插入。每个await后核捕获draft.valid/session再通知、插入、附件、提交。无重发、无paste事件重复插入、无全局clipboard新机制。bracketed纯图路径提升加!shellModeActive；shell路径保持字面命令参数。保留已文档化的OpenTUI失败路径全保留/不部分附图，以及shell+真实附件拒绝并保留，不把Ink已知图像shell缺陷偷塞进本批。
5. 保现有queue/steering/cancel接口。弹回单项且未编辑时保原捕获modelText/human子集/图像，禁止重读文件或剪贴板。多项已framed内容合并为一个可编辑提交时，只移除各有source依据的精确suffix再合并，并为真实framed块追加一次suffix；保转义wrapper与所有非framing model字段。不能靠识别标记授予human来源。编辑恢复仍用原map/冲突规则，unknown成员继续unknown；最终归一化位置要先加真实joined consumer回归再定。不得有死optional开关或第二队列。app-shell延迟项须完整透传；live-turn未编辑modelText覆盖属于本次读点，不能用组件绿绕过。
6. 在composer历史填回边界复用unframe（普通history与接受reverse-search），不改history store。userMessages常已用recallText，转换应幂等并兼容旧framed历史。搜索Esc精确恢复原text/map/unknown快照；shell Up/Down保持raw。召回不能将导入/未知来源变成known humanInput。外编读取raw展开，未改内容保map与undo语义，同最终提交；Vim/普通Enter、completion提交、Ctrl+Q共用该finalizer。

已认领提交保留提交时的模式。接收拒绝后恢复当前后继时，分类读取后继的当前模式，包括等待接收期间发生的 shell 切换。两个方向均有真实 composer 回归；这不等于已完成终端层面的模式切换验收。

## 必须保持的不变量

- 两真实折叠粘贴=两转义block+一次精确suffix；placeholder删光/没匹配就不加suffix。字面tag、预转义tag、反斜杠、Unicode、CRLF归一化、placeholder冲突按原helper规则保raw human内容；不超出Ink现有trim行为承诺空白逐字等价。
- raw humanInput、submitted/display/recall与model framing经queue/steering/rejection/cancel/resubmit仍区分。未知/混合恢复仅保原已知human成员，识别framing不等于来源证明。
- 提交只等自己的pending。旧read/copy不可写入后继、切换session、clear/unmount或取消claim。拒绝准入的图文map只能恢复一次，与后继合并仍用原冲突helper。
- shell及无附件slash raw；shell纯图路径不变chip，原真实shell附件拒绝保留。model图像bytes/MIME与image-only Enter no-op不变；Retry不多做@file展开或图片转换。
- 每次新model提交只framing一次，prepared Retry不动，accepted steering不重复。修复来源解释，不新增权限，也不承诺防御所有prompt injection。

## 回归与实际验收计划

保全部原wholefiles，新增collocated用例，不能只有快照/helper自证。

永久 clipboard 产品用例保留 Node+Ink、Bun+Ink、strict OpenTUI 原有首轮粘贴完整精确断言。仅 native 分支继续召回原始 raw 文本，在不换行的第二行末进行独立原输入所定义的编辑，再显式提交，验证两次 HTTP 关闭及两个真实模型侧 JSONL user 记录的 UUID、session、promptId、parent 链接与祖先。oracle 来自原始用户输入字节，不来自模型输出。finally 在断言失败时也保留原始 journal 文件。这些模型记录不证明普通 TUI 已持久化 humanInput。

当前 Ink 历史记录的是 compact display placeholder，因此新增 native 原文召回合同不声称三 renderer 一致。保留 Ink 参考失败及恢复原始粘贴内容的明确后续项 [#15397](https://github.com/QwenLM/qwen-code/issues/15397)，不能把 placeholder 当成通过预期，也不能跳过首轮粘贴用例。native 条件续段是公开的行为边界，不是 skip。独立 strict 产品证明已存在；新整合的永久版本仍需重新进行整文件三腿验证。

| 层级                | 必需用例/复用                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pure helper         | 保/迁原Ink framing测试；共享paste工具加两块一次suffix、no-match、伪闭合/打开tag、双/预转义斜杠、重叠ID、raw逆变换；原raw展开/恢复测试不改弱。                                                                                                                                                   |
| 真实composer        | input-prompt.test既有Ctrl+V图正控；Linux无图/save失败small/large文本；shell图路径raw；paste图叠加；fallback前Enter；拒绝+后继；session/unmount/clear；同尺寸ID；普通/Vim Enter/Ctrl+Q/completion的精确model+human+display。                                                                     |
| 真实queue consumers | input-submission/live-turn/app-shell：未改/已改/混合unknown弹回；两项来源合并一次suffix；未改modelText覆盖；延迟shell；元数据透传；steering一次；旧取消+健康后继；prepared Retry不变。                                                                                                          |
| recall/editor       | input-prompt/input-history及既有Vim/editor：Up/Down、reverse-search接受/取消/提交、shell隔离、framed历史raw编辑重发、不升级来源、pending editor同draft；不重写Vim。                                                                                                                             |
| 实物                | 复用InteractiveSession/FakeOpenAI：先global Ink基线及同源码NodeInk/strict真实差异RED；修后同bundle NodeInk/BunInk/strict，核wire精确framing、raw human journal/sidecar/recall、loopbackHTTP、取消owner、自然退出。Linux真实clipboard工具offer另列环境限定门禁，mac helper返回null不能假LinuxP。 |
| native              | 原input-ownership脚本七提交/图bytes断言全部保留；仅现脚本能观察真实最终model输入时加集中来源用例，不改其原合同、不带无关渲染。                                                                                                                                                                  |

实际RED后root实施，再正常build/type、完整受影响CLI单元文件、targeted integration/native、lint/format/bundle、精确artifact产品验收及两轮开放cleanpass。精确counts/hashes/budget等实际freeze再绑定。其他installed8/checkout/CI绿不证明新paste合同。

## 双语文档与完整体量

新增完整paired docs/design/2026-10-24-opentui-clipboard-source-lifetime.{md,zh-CN.md}。既有input-ownership双语“Integration with main input provenance”“Baseline decisions”同步当前来源事务及保留的图像例外；editor-transaction双语pending-paste/外编段改引用，不改历史通过数。更新.qwen/e2e-tests原计划记录baseline/RED/green。旧delivery/CI保持历史标识，不改写成本批PASS。

预计完整范围：pure共享提取+Ink兼容100–180行；OpenTUI finalizer/owner/fallback/recall及必需queue180–330生产行；独特pure/composer/joined回归900–1400；实际产品fixture/证据250–450；双语文档200–350。约1.6–2.7k，真实joined race需要时接近3k；以实际diff衡量，不承诺行数。若保来源安全需要更多，应保完整事务并解释体量，不能删测试或拆散setter/consumer。实现必须保留此完整边界，验证结果另行记录。
