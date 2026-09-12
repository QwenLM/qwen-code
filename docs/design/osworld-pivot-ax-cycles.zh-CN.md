# 避免 AX 祖先循环

[English](osworld-pivot-ax-cycles.md) | [简体中文](osworld-pivot-ax-cycles.zh-CN.md)

## 证据与范围

Case50R2的Create PivotTable控件重复到max_depth，facade随后因incomplete丢弃全部token。对独立工作簿的遍历通过CFEqual证明两个AXTextField的AXChildren[0]都是自身，并非仅标签相同。去重树有21节点。AXPress同时存在返回-25204但实际开窗的独立问题，本改动不解释或修复它。

## 候选与验证

整次遍历用保留引用的AXIdentity及CFHash/CFEqual维护已访问身份集合，保留每个身份的首次DFS出现，跳过循环与跨分支别名。revision store要求唯一身份，重复保留同一控件会使整个facade观察不稳定。未访问的兄弟和后代继续遍历，身份集合大小受遍历上限约束，不把属性错误、非循环深度截断或真实缺失节点改成complete。引用在离开作用域时释放。

状态：同一真实对话框、冻结新旧native及相同JS的验证已通过。Native测试和构建、facade完整token、未重复控件保留、真实对话框token动作及正常NameBox观察均通过。去循环后观察完整，不等于整任务效率已经达标。

仅处理祖先的aee52939候选把同窗输出从10343降至1900字节，但仍无facade token：两个Collapse Dialog控件还存在跨分支CFEqual重复。该失败候选保留为证据。b47e0102采用整次遍历身份唯一性，357项native测试及release构建通过。独立23项检查通过：89行输出降至17行，全部17条唯一语义行及9个可操作控件保留；两次观察均完整且token稳定，首次Cancel token实际关闭对话框。NameBox聚焦及B2选区回归通过。首次观察445.420→284.413ms仅是局部对照，不代表整任务提速。独立代码审查无发现。证据：`.qwen/issues/osworld-pivot-ax-cycle.md`。
