# Hosted Hook 注册确认门禁 FG13a

[English](2026-10-21-hosted-hook-registration-ack-gates-a.md) | [简体中文](2026-10-21-hosted-hook-registration-ack-gates-a.zh-CN.md)

> 跟踪 #14449。FG13a 的最后一格把确认丢失移到 `hook_registration` 域——这里
> 的调用方是准入路径：结算确认丢失后，重试必须能复用已有注册，而不是再钉一次。

## 问题与范围

FG13b 的表格把注册结算移到这里，因为注入缝当时没有 catalog 阶段。现有
catalog 格丢弃 worker 的 `hook-catalog` 回复，让第一次准入在注册提交之前失败；
它没有覆盖相反的一面：注册的结算提交已经落库，调用方收不到确认，而准入重试
必须找到并复用这个已落库的钉，不能重新注册。

本切片给注入缝加 `hook_registration` 阶段，并在该结算提交上落一格。

## 用例

`HostedHookReplyLossFaultGatesIT` 的
`fg13aRegistrationStoreAckLossReusesThePinnedRegistrationOnMySql`：

| 步骤 | 发生什么                                      |
| ---- | --------------------------------------------- |
| 1    | 注册的结算提交落库，随后缝报告确认丢失。      |
| 2    | store 客户端重试同一份提交，服务端走重放。    |
| 3    | 准入继续，复用已落库的注册与钉住的 revision。 |
| 4    | Hook 执行一次，模型收到一个工具结果。         |

期望：

- 恰好一条 `hook_registration` 记录，状态 `settled`，钉在定义携带的 catalog
  （`fg13-hooks`，revision 1）。
- 故障恰好触发一次：客户端重试走重放而非重新应用；若重新应用会二次触发。
- 物理 `hook.call` 一次、`hook.allow` 一次、发出的调用对应一个工具结果。

## 接缝

`StoreFaultGate.Phase.HOOK_REGISTRATION_SETTLED` 在 `hook_registration` 域的
`run.state` 为 `settled` 时命中；目标 id 是 `registrationId`。注入缝的域白名单
新增 `hook_registration`，否则该提交根本不会被检查。`armAck` 与其他格同一
分割：`inspect` 静默，`afterApply` 在事务的 after-commit 回调里抛错，所以
调用方看到失败时结算已经落库。

`StoreFaultGateTest` 钉住该阶段：准入提交不被命中，确认模式下只有结算提交
触发故障。

## 覆盖

- catalog 丢回复格在注册提交之前丢弃 worker 的回复；本格让结算落库并丢掉
  它的确认。
- FG13b 的结果格钉住结算丢失对 Hook 执行意味着什么；本格钉住它对准入路径
  读回的注册意味着什么。

## 变异见证

- 改用 `arm` 而非 `armAck`：结算回滚，重试重新注册，单条已结算注册断言变红。
- 从故障 store 去掉 `afterApply`：不触发故障，等待 `attempts` 超时。
- 重试时另起一条新注册而不是复用已落库的那条：出现第二条记录或重复钉被拒，
  单条记录断言变红。

## 非目标

- 派发确认丢失：本堆叠链的上一格。
- store 客户端重试耗尽：由 FG13b 的拒绝格覆盖。
- 把注入缝移进生产代码：它保持测试专用。

## 验证

证据来自 Linux 上的 `hosted-harness-mysql` 车道，MySQL 8.4 与委派的 cgroup
v2 根。`managed-agent-gate.yml` 在 `pull_request` 上只选 `fast` 档；完整套件
由维护者对 head 提交的首次批准触发。本格给共享 fork 增加 150 s：healthy
10500 s、fork 11100 s、Verify 195 分钟。
