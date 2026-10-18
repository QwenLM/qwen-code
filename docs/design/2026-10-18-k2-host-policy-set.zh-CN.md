# K2 完整宿主策略工件集

[English](2026-10-18-k2-host-policy-set.md) | [简体中文](2026-10-18-k2-host-policy-set.zh-CN.md)

## 状态与问题

拟实施的软件增量。策略 target 已命名 runtime、kubelet、registrar、CSI backend、
PID 1 及 system bus 标签，但 renderer 和 compiler 当前只生产五个 Qwen profile。
source 将这五个已加载 profile 与原 packed 工件比较。peer 标签及少量配对权限
都不能替代完整宿主策略。

## 工件契约

增加必填且独立审阅的 `host-policies.json`，格式为 `qwen-k2-host-policies/1`。
唯一其他字段为 `files`，恰好记录 `host-runtime.rules`、`host-kubelet.rules`、
`host-registrar.rules`、`host-plugin.rules`、`host-systemd.rules` 和
`host-system-bus.rules` 的字节数及 SHA-256。这些固定文件包含对应角色完整、已展开
的基础规则正文，不能仅提供 K2 新增规则。每份正文必须是非空 UTF-8，至多 1 MiB；
manifest 至多 64 KiB。渲染要求独立已审 manifest 摘要，不接受调用方文件名进入图。

生成器拥有每个 profile 的 header、attachment 及 enforce flags。五个 executable
attachment 使用受保护 target 中的对应路径；独立 system bus profile 没有
attachment，安装时需要显式进入。其名字不能以 `/` 开头，否则 AppArmor 会推导
出隐式 executable attachment。Header 使用 `flags=(enforce,mediate_deleted)`。
system bus 仅在两个角色的完整基础规则字节相同时，才可保留已有宿主标签；只合成
一次该 profile，并组合两个角色的固定新增权限。五个 executable 宿主标签仍必须
互不相同。这不能证明 PID 1、bus 或每个线程实际进入了该标签。
全部宿主标签均为根 namespace 内的字面名字，不含 `:`、`//`，不以斜杠结尾，
首字符必须为字母、数字或 `/`。
以斜杠开头的 bus 名字仅在复用已显式 attachment 的宿主 profile 且完整基础
字节相同时接受。

首条支持输入通道刻意采用平面形式：每行一条逗号结尾、两个空格缩进的规则；不接受
preamble、注释、续行、变量、include、alias、ABI、嵌套 profile、hat 或条件块。
包含花括号的路径及其他 AARE 值必须加引号。扫描识别引号及转义，将这些值与结构
花括号区分；不能猜测最后一个花括号并在其前插入文本。基础规则保留完整原字节，
包括 deny。括号深度及唯一末尾顶层逗号防止同行第二条规则。文件规则采用带引号
路径、随后权限的拼法，可带 `file` 及普通 qualifier；其他拼法拒绝。此通道遵循
[AppArmor 语法](https://www.apparmor.net/man/4.0/apparmor.d/)，但只接受该子集。
未知规则类型、自主 profile 变更、继承以外的文件执行均拒绝。
runtime 到固定 shim、PID 1 到固定 service 的必要转换由生成器拥有。
真正固定的 parser 仍负责 AppArmor 语法及 feature 兼容性；输入校验不能替代
隔离语义审查。

## 合成与消费方

五个 Qwen profile 保持由代码生成。追加完整宿主 profile，以及既有 peer 操作
所需的固定 ptrace、Unix、signal、D-Bus 配对规则。source/gateway 必须能读取
全部七个新增工件叶子。不提供通用 allow-all 基础、自动发现策略目录或自动删除
deny。基础 deny 与新增 allow 冲突时仍是 deny，原生验收应失败，不能静默删除。

pathname Unix socket 使用字面路径文件访问规则。Unix `peer=(label=...)` 规则
覆盖 abstract/anonymous socket，不能强制 pathname peer 标签。实际程序仍保留
SO_PEERCRED、executable、process、namespace 及原持有 peer 检查。
actor/admission 排除及原生资格化仍是必要条件，不能推导出 pathname LSM peer 保证。

candidate 升为 `qwen-k2-profile-candidate/2`，installation 升为
`qwen-k2-installed-artifacts/2`；旧 candidate 拒绝且不转换。两个文件图均包含
manifest 及六份完整基础正文。编译通过已固定输入核对精确的已生成宿主后缀，
然后执行既有不加载内核的 parser 命令。compilation/2 和 target/2 字段不变。
完整 source 仍至多 16 MiB，packed 输出至多 8 MiB，安装图至多 64 MiB。

Go 工件校验器与 Java 独立 metadata 读取器执行相同的固定文件、预算及嵌套摘要
约束。从已验证 target 派生完整、去重的宿主标签集合。source 持有每个新增原
profile 对象，并在既有策略边界复查 enforce mode、目录/对象身份及其指向同一
原 packed `raw_data` 的链接。该集合也覆盖另外三个 Qwen birth actor。
保持既有 source/worker observation；这组字节关联无需新增 authority 字段、
source/7 版本或 SQL schema 变更。

## 文件与验证

变更涉及 profile renderer/compiler 及测试、Go 工件校验器/assembler 和
已加载策略守卫、Java 已审字节读端及测试，以及双语 pre-exec 设计链接。验证
完整合成及 bus 标签复用、缺失/变化/额外基础正文、带引号及转义的 AARE、结构
逃逸、环境依赖、禁止转换、旧版本、嵌套摘要变化及共享字节预算。
inert parser/packed 夹具必须与原生证据明确区分。

使用已有 AppArmor 5 parser 的无加载、无 cache、stdin 语法 smoke，与已审目标
Ubuntu 24 parser/features 的编译分开。它不产生正向 compilation 或 installation
协议记录，也不资格化原生隔离。

运行全局 CLI baseline，对本私有离线阶段使用直接脚本回退；运行 Python、Go
测试及 Linux amd64/arm64 编译、root build/typecheck、受影响 Java 测试及
无过滤 Maven verify。保留失败尝试、两轮完整 diff 自审，并取得独立审查。

## 验收与剩余工作

软件验收要求完整固定的 source/installation 图、匹配的固定角色消费方，以及
不支持输入时拒绝且不产生部分输出。它不资格化实际安装。独立已审可运行基础
策略、真实固定 parser 编译/导出、内核加载标签及全部线程进入、正常
Create/Start/Delete、整节点 policy lock、actor/admission 排除及冷启动
CSI 独占仍是原生验收要求。D-Bus message body 仍不在 AppArmor 比较范围内。
最终物理 authority、四行原子 release、RELEASED 历史读取及安全后续周期复用
仍未完成且保持门禁。本软件增量不包含云变更或策略加载。

此通道没有待定的软件格式问题。原生基础策略内容及实际 PID-1 进入必须针对
新建自有节点审阅，不能从 executable 路径、标签或历史 ACK 数据推导。
