# Managed 实时消息分页

[English](2026-10-29-managed-live-message-pages.md) | [简体中文](2026-10-29-managed-live-message-pages.zh-CN.md)

后续[快照删除](2026-10-29-managed-message-snapshot-removal.zh-CN.md)替代本变更的可选读取选择项及保留快照默认路径。在该后续变更中，直接消息读取成为默认，并移除公开快照表；其实现及验证状态单独记录。

## 问题与范围

已合并的有界查询API读取已发布快照，可能落后于消息投影，Java WebShell Provider启动时仍使用完整快照transcript路径。目标是直接SQL读取最近100个Item、滚动加载更早页，并通过既有事件流实时更新。导出读取实时消息页，不承诺冻结正文。只调整公开Managed H2/MySQL WebShell读取；daemon Legacy、执行恢复、私有CSI、canonical journal和schema保持不变。既有快照API及认证游标保留默认语义，清理它们的其他依赖另行处理。

## SQL读取与分页

在现有transcript和导出请求增加显式`view: messages`选择，省略时保留旧客户端行为。Java Provider在两项操作都设置该值。只读REPEATABLE_READ事务捕获Session消息投影覆盖序号S及投影版本，通过现有tenant/Session/first-sequence索引和完整`(first_sequence,item_id)`顺序读取最多limit+1条描述，并只读取选中正文。limit为1..100，选中的元数据、parts/资源和控制事件共享8 MiB字节预算；单个Item超限明确失败。投影资源保留现有scope/摘要检查。

UI向更早记录翻页，导出按时间正向遍历；每页Item均按时间顺序返回。带版本及scope的不透明游标包含方向、投影版本、首请求的序号上界和完整的末尾排序键。沿用既有task游标约定，它只是位置，不是授权凭证。每次请求重新校验actor/tenant/Session授权；拒绝方向/scope/形状/边界不符，遇到投影重建明确拒绝，不静默跳过移动行。不得重新解释快照游标格式。页间正文与状态可以变化，只有成员范围受首请求序号上界限制，因此持续聊天时导出仍能结束。

每次响应在同一个数据库视图读取投影进度及消息内容，包括不加行锁的私有CSI检查。投影可能落后于事件head H；transcript的`lastSequence`返回S，使SSE从S之后继续，覆盖全部未投影事件。若S低于既有replay floor，明确返回可重试的503 `message_projection_pending`，不能跨越已不可读取的事件完成交接。不得把H声称为已包含、读尽完整事件尾部、要求writer停止，或把空投影证明为Session没有历史。只读取选中Turn最新相关生命周期/控制事件，受Item数及字节预算限制。任务、审批、恢复和资源状态仍使用既有接口。读取不新增持久快照、跨实例缓存或writer写入。

Java Provider将覆盖序号缺失、负值或非整数视为transcript读取失败，不以事件head替代未知覆盖位置，也不返回undefined的续传位置使启动循环静默空转。测试响应使用transcript类型检查，防止遗漏该必填字段。

## WebShell与导出

复用既有`getTranscript`/`loadOlder`路径、MessageList滚动触发、并发排除及前插滚动锚点。Java将返回transcript标记为Item分页历史。当一页覆盖某Item时，替换该页覆盖序号内该Item的投影/原始内容，同时保留更晚流帧，避免聚合正文与流式文本重复。为每个已加载Item记录覆盖序号，过滤稍后到达、已被页面包含的SSE内容帧，不跳过未返回的Item或非内容副作用。同序号Item沿用SQL的UTF-8二进制ID顺序。gap重同步替换当前Item窗口，同时重置历史页状态；既有raw provider保留规则不变。切会话和abort丢弃过期响应。

Java显式选择实时导出。复用既有取消、scope/身份检查、数量/字节预算、重复游标拒绝和渲染。实时导出不等待快照发布，也不因为正文更新晚于初始成员边界就拒绝Item。首个导出请求若消息投影尚未追上已提交事件，明确返回可重试的503 message_projection_pending，不能把未投影消息静默导出为空；聊天读取仍从S续接SSE，不要求活跃writer停止。范围上界必须保持不变，Item必须属于该范围；正向页面已保持时间顺序。其他provider保留固定快照校验。输出元数据必须明确标记实时导出。

## 验证与验收

服务端回归覆盖：无快照、快照落后投影、投影滞后的SSE交接、同序号、双向分页、持续插入下有限导出、正文更新、游标scope/版本/重建失败、授权、超大正文、资源完整性及有界控制读取。CI在H2和真实MySQL执行相同场景。HTTP/API与surface测试覆盖显式选择及默认兼容。

前端覆盖：首屏最新页、一次更早页、不自动读尽历史、实时追加且聚合文本不重复、gap/分页竞态、切会话/abort、Turn终态、实时导出不等待快照及保留安全守卫、raw provider兼容与滚动锚点。运行受影响包测试、build/typecheck/bundle及两轮clean审阅，明确记录真实运行E2E缺口。

原本地Java验证预算保持CLOSED564.787/600，剩余35.213禁用。另行预览编译启动额度也已CLOSED315.129/600，未授权测试。禁止本地Java准备或执行，新增Java/H2/MySQL验收由准确最终head CI负责。保留5196既有ce2预览及数据，不将该预览、旧测试或合并状态当作本实现验收。

## 决策与后置事项

无需新的产品决策：用户已批准直接读取可变消息及实时导出。固定历史导出、快照表删除、投影重设计、authority/缓存窗口、派生索引、全历史恢复及Legacy优化不在本次范围。投影滞后由现有事件流交接体现，不以无界查询或本地补投影循环解决。
