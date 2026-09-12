# 通过语义点击聚焦可编辑组合框

[English](osworld-editable-combo-focus.md) | [简体中文](osworld-editable-combo-focus.zh-CN.md)

## 问题与证据

OSWorld 44、45、50 多次尝试点击 Excel 名称框。历史 case 44 Qwen 运行出现 AXPress -25206，随后 call 6–23 约159.5秒用于恢复选区；其中包含模型决策，不能全算作 SDK 分派耗时。独立真实 MCP 在94eb59d2 native上复现相同错误，调用1185.18毫秒。

名称框是 AXComboBox，声明 AXShowMenu/AXConfirm，没有 AXPress。独立设置 AXFocused 成功且 AXValue 不变；实际焦点进入其直接 AXTextField 子节点，通过 AXParent 与组合框的 CFEqual 确认。随后前台输入并按 Enter 可选中目标单元格。这证明候选语义操作有效，不代表整任务已经提速。

## 改动

无修饰键的 AXPress 命中 AXComboBox，且 AXValue 可写、未声明 AXPress 时，改为设置 AXFocused。要求发送前值可读，焦点写入成功，新读到的焦点元素是组合框自身或其直接 AXTextField 子节点，发送后值仍可读且不变。条件全部满足才返回经辅助功能读回确认的结果。写入或读回失败就报错，不再发送第二种动作。

继续使用每次调用既有的前台或后台目标与焦点策略。不增加全局输入、坐标回退、标题匹配、值写入或公共选项。显式菜单/确认、已声明的 AXPress、不可编辑组合框、其他角色和修饰键处理保留原路径。焦点确认只能证明聚焦，不能证明随后输入的值已经提交。

## 验证与边界

执行已有点击测试并构建 native。独立测试工程师验证本地真实 MCP 链路：名称框聚焦且值保留、后续选中单元格、其他字段焦点不能冒充确认、显式菜单/确认兼容，以及既有旧 token/错误窗口拒绝。保留哈希和耗时。

合并修复之前，Excel 还有 AX 树不完整问题，facade 因而清除 token。raw legacy token 测试必须明确标注，不能证明模型使用的 facade 已可用。须完成下方独立过滤修复后，才能验证 facade 链路。整任务耗时实验使用历史任务描述、原始输入、setup 和评分规则，目标为 baseline 的1.5倍以内；不能根据本补丁直接声明整任务达标。

## Help 搜索空子节点与观察完整性

第二次独立复现将不完整捕获定位到应用 Help 菜单 AXTextField/AXSearchField 的一个子节点，位于工作簿子树之外。其 AXRole 返回 NoValue（-25212），AXSize 恰为零，AXChildren 成功返回空数组，所有内容缺失，AXValue/AXFocused 不可写，AXFocused 为 false。该节点原本就不会显示在树中，但角色缺失导致所有真实元素 token 被清空。旧 d8dd 和94eb均有这个现象。

walker 在判定必要角色缺失之前，仅跳过经直接验证的空搜索框子节点。要求再次读取的角色严格为 NoValue、父节点具有观察到的角色/子角色、尺寸类型正确且为零、子节点为成功读取的正确类型空数组、标题/描述/值/占位文字/help 缺失、沿用既有稳定错误分类确认没有动作、值/焦点不可写，且实际 focused 为 false。success/null、瞬态错误、未知类型、可见或非空节点、可编辑或已聚焦节点、其他父类型保留不完整路径。不匹配应用名或 Help 标题；顶层角色检查和 facade 清除 token 策略不变。剩余诊断改为必要角色不可用，不再声称原始 API 必然返回 success。

独立验证需保留同一个实际空子节点，对照新旧 native，确认 facade 完整树和真实名称框 token 可用，并证明父搜索控件与菜单内容仍在。不能仅凭现有 native 单测将此修复标为已验证。

## 已验证的本地构建

最终native47e2d968通过355项library测试和release构建。独立真实MCP在同一个Book1及保留的空叶上确认：两次facade观察complete/stable（662.45/243.43ms；第二次选中no-change正文81bytes），Help/搜索父控件保留；真实facade名称框点击1359.15ms，从AXLayoutArea进入其直接文本编辑子节点并保留原值A2。输入B2（1481.43ms）加Enter（1359.14ms）后选中B2，由独立AX和实际PNG确认。仅关闭自建工作簿后，旧token在0.485ms拒绝stale lineage。候选哈希前后相同，验证MCP全部退出。

独立审查发现遗漏AXPlaceholderValue检查，已在最终构建和验证前补齐。重新执行测试/构建及两次clean自审，最终审查无发现。在47e2d968验证阶段，显式菜单调用未证明视觉弹出，模型连接问题阻碍了整任务验证。后续case44、case45及case50运行已使用组合修复；下方普通文本框验证单独证明了菜单真实弹出。全部20个任务的效率验收仍未完成。证据：`.qwen/investigations/excel-facade-verified-47e2d968/`。

## 普通可编辑文本框

Case50R2独立复现Colors的hex AXTextField不支持AXPress。用Tab移走焦点后设置AXFocused，实际焦点回到该精确字段（CFEqual），FFFFFF值保持且六个字符全选。候选仅把语义焦点路径扩展到AXTextField，并额外要求AXFocused可写。只有combo允许其直接子编辑器作为焦点证明，普通文本框必须精确匹配。其他角色、显式动作和modifier保持原路径。

候选343979eb通过357项native测试和release构建。独立facade验证从非hex焦点进入hex、值保持、返回confirmed而非-25206；NameBox再输入B2并显式confirm也正常。该click仍耗1076.307ms，包含未变的一秒观察；这是修复无效动作，不是解决主要等待成本。全部15项独立检查通过，包括显式菜单的真实弹出和关闭所属窗口后的拒绝；该拒绝首先验证窗口身份，不能单独证明token寿命。最终窄范围代码审查无发现。证据：`.qwen/issues/osworld-colors-textfield-focus.md`。
