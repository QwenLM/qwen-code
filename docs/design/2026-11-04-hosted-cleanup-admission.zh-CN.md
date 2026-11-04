# 对原 Runtime 验证 Hosted cleanup 债务准入

[English](2026-11-04-hosted-cleanup-admission.md) | [简体中文](2026-11-04-hosted-cleanup-admission.zh-CN.md)

## 问题与证据

首次 `hosted.cleanup` 债务只将 descriptor 与此前的 cleanup 引用比较，没有确认
原 Runtime binding 及其 generation 仍然存在。retention 可以先删除 binding，
随后 journal 事务仍创建指向它的引用。仅恢复串行锁无法拒绝这个后到的事务。

在主线 `5f0474abc42eaf1e11c9920be0809878e08396e6` 上，真实 MySQL 8.4 生产 API
测试复现了三类失败：回收后仍提交债务、债务使用错误 Runtime generation，以及
writer 与 sweep 竞争时在 sweep 获胜后提交悬空引用。这些是正确性问题，不是吞吐
测量结果。

## 决策与锁顺序

只有包含 `hosted.cleanup` 事件的 journal 事务才在 Session/root 锁之前取得已有
的有界租户 placement guard。从已校验的 record bytes 识别事件，覆盖混合事务与
JSON 转义；不依赖调用者填写的 operation 名称或 resource 列表。不含该事件的普通
事务保留 Session-first 路径。

| 路径                 | 相关锁顺序                                        |
| -------------------- | ------------------------------------------------- |
| Cleanup journal 事务 | Placement → Session → storage → head → 原 binding |
| Runtime retention    | Placement → slot → binding → 引用/Session 检查    |

共同的 placement guard 在双方进入不同的 Session/binding 顺序之前将其串行化。
如果只在 journal head 后追加 binding 锁而没有这个共同入口，可能形成锁序环。
Lifecycle-authority 与 CSI 协议保留已有 guard 和拒绝处理。

对每个非 confirmed 的 cleanup 事件，通过锁定当前读读取 binding，并要求其
tenant、Workspace、Workspace generation 和 Runtime generation 与 descriptor
一致。binding 不存在或不匹配时，用 `managed_session_cleanup_conflict` 拒绝整个
journal 事务，不留下新增 resource、journal 条目或 cleanup 引用。

Retention 已明确使用 READ COMMITTED。等待 placement 后，其已有引用查询能够
看到先完成的 cleanup 提交，因此无需修改 retention 隔离级别或引用查询。如果
retention 先完成，cleanup 准入看到 binding 缺失并拒绝；如果 cleanup 先完成，
retention 看到债务并保留原 Runtime。

## 兼容性与范围

- Confirmation 在原 Runtime 已回收后仍可删除引用；它不新增债务，不要求 binding
  仍然存在。
- 已提交命令重放原 receipt，不重新执行新债务准入；确认并回收后也保持该语义。
- 既有 descriptor/重放身份检查保持不变。本次增加持久化 binding 的作用域与
  generation 校验，不重新设计 Runtime Session 所有权或 release 授权。
- 不涉及 schema、公开 API 结构、配额、Workspace 创建或 provider 变更。Cleanup
  事务现在可能等待租户 placement，并使用已有的有界可重试拒绝；其他 journal
  流量仍保持独立。

## 验证与验收

在真实 MySQL 上执行修改前后的生产 API 回归，验证 retention-first 和
cleanup-first 两种顺序。覆盖缺失 binding、作用域/generation 不匹配、resource/
reference/journal 状态回滚、回收后的 confirmation 与命令重放、shared binding，
以及无关 placement 被持有时普通 journal commit 仍能前进。复用已有 H2/MySQL
cleanup、journal 锁契约和锁序测试，并运行 Checkstyle。

遵循 Managed Agent 模块的共享本地验证预算。完整 Java、MySQL 和相关 Hosted/fault
验收仍由 CI 完成；本地定向通过不等于完整验收。
