# Hosted provider 故障门禁

[English](hosted-provider-fault-gates.md) | [简体中文](hosted-provider-fault-gates.zh-CN.md)

## 问题与当前状态

这是 #12872 中 FG6f 的 provider-control 切片，前置 #12868 已合入。
Shell 输出切片已由 #12954 覆盖。生产 Broker 客户端和打包 worker 已实现七字段
准备引用与关闭准入的 release。现有 provider 测试大多使用 transport 夹具；
Hosted 模型循环仍使用独立门控的 raw-tool 协议。

新门禁覆盖生产 provider 客户端、Spring Broker、Workspace transport、打包
worker 和真实 MySQL/MariaDB，不将 provider controls 接入 Hosted 模型循环，
也不开放新的公开能力。

## 场景与验收

| 场景             | 故障或重试尝试                                                                     | 所需证据                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Provider start   | 转发后丢失第一次 start 响应，再重试已保存的预留和原执行                            | 保存的引用恰有七字段且无工具参数；一次预留、派发和追加；观察与重试均指向原执行                                                  |
| 契约替换         | start 前和结算后向 provider 预留发送 raw payload；也在相同幂等键下修改已保存的引用 | 即使执行已终态，Broker 仍拒绝更换契约；原引用和副作用不变                                                                       |
| Raw 对照         | start 前和结算后对 raw 预留省略必需 payload                                        | provider start 路径不能接管 raw 预留；合法 raw start 仍可用                                                                     |
| Release 响应丢失 | worker 关闭准入后，在 Workspace transport 收到响应前丢弃该响应                     | Runtime Session 保持 RELEASING 并保留原存储所有者；worker 拒绝新准入且保留终态证据；重试 release 先确认关闭，再停用和释放所有权 |

使用确定性的短追加命令，区分重复物理执行与相同内容覆盖。独立于驱动成功标记，
核对工作区证明文件与 SQL 执行账本。无效尝试不得更改引用、派发代次或原结果。
同键替换探测分别更改 `policyRevision`、`capabilityDigest` 和 `invocationId`；
保存引用的断言则比对全部七个字段。

## 夹具设计

在既有 Hosted Workspace 集成测试系列增加可选 provider 驱动及 Java 探针，复用
Spring/数据库设置、挂载的 Workspace Session 和打包 worker 创建路径。TypeScript
驱动使用生产 Broker 客户端与 provider controls，无需模型选择准备调用。
每个场景使用独立 Runtime Session。

Java 探针仅在测试夹具内给既有 Workspace transport 的 HTTP 客户端增加转发
代理。对 release，先转发给实际拥有的 worker，确认真实成功响应，再丢弃响应。
在响应能够抵达 Workspace transport 前，核对 SQL 原所有权仍保留，并探测原
worker 已关闭准入。这个中间边界能验证顺序，而非只检查最终 RELEASED。
其他 worker 操作保留实际 transport 行为，不引入生产测试开关或替代释放实现。

不确定 release 后通过 Broker 公开路由重试，验证原终态执行仍可读取、已关闭
worker 无法重新 acquire，且只有关闭得到确认后才释放存储所有权。所有探测均
指向夹具的原 Session、租约与代次。转发的 worker 关闭次数必须等于丢弃响应数
加一次已确认关闭，确保响应丢失后的重试不能跳过 worker。
成功及失败运行都保留诊断并完成清理。

## 文件与验证

实现涉及既有 Hosted 集成入口、专用 TypeScript 驱动和 Java 探针，以及本双语
设计。既有 Hosted MySQL profile 会发现该入口，不需要新增 CI 任务或产品路由。
各场景可独立选择以开展突变验证。

在 `.qwen/e2e-tests/` 保存精确 E2E 命令和证据。先尝试全局 CLI；若缺少私有
worker 能力，记录基线不可用，不声称复现缺陷。构建、typecheck 并打包本地 CLI，
编译 Java 测试并运行 Checkstyle，执行定向 provider 测试及完整 Hosted 系列，
数据库使用 MySQL/MariaDB。H2 不能作为验收证据。

在隔离突变运行中移除相关契约及释放顺序防护，保留待提交门禁断言与真实故障，
要求命中行为断言；恢复全部源码和产物字节，再运行正常门禁。独立核对 SQL、
文件副作用与进程清理。完整 diff 做无方向与反向审计，直至连续两轮干净；
第 5 轮之后仅修复 Critical 问题。

## 范围与风险

门禁验证当前固定执行契约与关闭准入的顺序，不实现自动续跑、worker 接管或回收、
将 provider 接入 Hosted 模型回合、远端 provisioner 或公开 Shell 准入。
短本地命令使用 POSIX 行为，不作为 Windows 覆盖证明。新增 HTTP 代理和数据库
核验会增加测试时间，因此按已观察到的协议边界选择故障，不依赖定时休眠。

本测试切片没有需要额外决定的产品设计问题。
