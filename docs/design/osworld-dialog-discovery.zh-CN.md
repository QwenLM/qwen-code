# 发现非零层的可见应用对话框

[English](osworld-dialog-discovery.md) | [简体中文](osworld-dialog-discovery.zh-CN.md)

## 问题与范围

已验证的native47e会漏掉位于layer8的Excel Format Cells。Excel转到后台时，同一CG窗口会变为layer0。独立AXWindows将其识别为AXWindow/AXDialog、AXModal=true，直接属于应用。指定已知ID的观察可以正常工作，但普通SDK调用方无法发现该ID。独立的存活补丁负责避免已观察的非零层目标被500ms清理线程误删。

## 拟实现行为

list_windows显式传入pid时，保留原layer0记录，并补充由该进程AXWindows独立证明为对话框的可见非零层窗口。只接纳AXSheet，或具有AXDialog/AXSystemDialog子角色、或AXModal=true的AXWindow；AX窗口ID必须匹配当前存活且同PID的WindowServer记录。不公开任意菜单、提示、Dock或覆盖层窗口。未传pid时，发现仍保持原layer0行为。

在阻塞工作线程上最多读取64个AX根节点，AX消息超时100ms，总截止时间500ms；工作线程失败则显式返回工具错误。仅在指定进程存在屏幕上非零层CG候选时读取AX。AX读取失败不添加窗口，不删除普通窗口，也不授权输入。使用最终同一次CG快照重建PID列表，使所有z_index使用同一标尺，保持原可见性及Space元数据规则。后台输入守卫、精确窗口观察、截图选择、主窗口选择和1秒动作观察保持原行为。

## 验证与限制

真实MCP验证：cmd+1后，按pid发现layer8的Format Cells；精确ID观察返回正确对话框；延迟token点击确实取消它；关闭后的旧token仍拒绝。检查激活/层级改变前后身份一致、无重复记录、普通名称框选区、未出现无关覆盖窗口以及不传pid的列表仍过滤。记录有/无对话框的发现耗时。单测覆盖sheet/dialog与普通窗口、缺失/失败元数据的准入区别。native测试、release构建、两次自审和独立审查通过后才能标为已验证。

这是机制修复，不是整项OSWorld任务提速结论。AXWindows不可用或没有可识别对话框证据的窗口，仍不会由此补充入口发现。1秒动作返回仍可能没有延迟出现/非零层窗口的提示；调用方使用既有listWindows(pid)发现路径。
