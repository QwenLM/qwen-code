# REPL 持久化闭包绑定

[English](node-repl-live-bindings.md) | [简体中文](node-repl-live-bindings.zh-CN.md)

## 状态与问题

已实现并通过Kernel层验证，随后用于本地case50 R3/R4整任务运行。全部20个任务的回归与效率验收仍未完成。冻结的OSWorld case50运行时已复现：在后续cell替换观察状态后，旧helper仍读取旧状态。普通JavaScript执行`let x=1; const read=()=>x; x=2; [read(),x]`得到`2|2`；此前REPL跨cell测试明确期待`1|2`。这与其文档描述的持久状态/helper工作流冲突，并导致重复token查找。

## 设计

每个绑定仍由首次声明它的module持有，导出引用该词法绑定的私有accessor。后续cell通过accessor解析沿用绑定的引用，不再把值复制到新词法变量。新声明和内部作用域仍使用原生JavaScript语义。沿用绑定的声明占位保留原生重复声明错误；重复`var`的初始化写入原绑定，包括解构和循环目标。改写时保留裸调用的`this`、对象简写、词法遮蔽和声明模式。

不把用户绑定挂到`globalThis`：本地导入模块共享VM context，不应因此获得REPL词法绑定或失去原来的全局对象。也不只在语句边界同步：同一语句内赋值后，旧helper必须立即看到新值，旧helper写入也必须立即可见。

## 失败与取消

检查点值与live accessor分开保存。成功cell保留原绑定所有权。普通错误恢复到最后完成语句/声明器的值；取消或超时恢复到cell进入时的值，不发布新绑定。对象原位修改和外部副作用仍与此前一样不回滚。已有异步续执行保护与native终态屏障保持有效。

## 验证与验收

使用真实Kernel覆盖替换观察状态、旧helper写入、同语句读取、异步helper、重复`var`、解构、循环目标、遮蔽/默认参数、const/TDZ、裸调用/可选调用、导入模块/全局隔离、部分提交、超时和取消。运行包build/typecheck及transform/Kernel测试，再独立复现和审查。冻结历史runtime保持不变，新runtime作为独立实验处理组。不能根据这些控制测试宣称整任务提速。

最终build/typecheck及70项transform/Kernel测试通过；独立19个cell审查无发现。审查修复保留严格模式下裸标识符delete的错误，以及匿名函数/类的推断名称，覆盖带注释括号和类静态初始化器。对尚未在可见module声明的名称仍沿用已有行为，并非全局Script REPL。证据：`.qwen/pr-reviews/node-repl-live-bindings.md`和`.qwen/investigations/node-repl-live-bindings-seventh-tests.log`。

Case50R2结束后，旧runtime的源码链接让后续build改动了三个编译文件。已恢复其记录的精确字节，独立复制包及依赖，重新核验全部54项原runtime哈希；R2任务轨迹和计时未变。新R3使用独立完整依赖manifest。事后恢复记录在R2的`post-run-runtime-mutation-audit.json`中，不把它描述为历史依赖始终未变的认证。
