# External Workspace 存储注册

[English](2026-10-25-external-storage-registration.md) | [简体中文](2026-10-25-external-storage-registration.zh-CN.md)

状态：已实现兼容性增量，验收等待 CI。对应
[issue #15512](https://github.com/QwenLM/qwen-code/issues/15512) 的 PR-A。

## 问题与范围

控制面需要先登记 provider 所有的存储，才能安全绑定未来的 external Workspace。
本地目录身份无法表达 provider 的持久存储：服务器无法检查远端文件系统，sandbox ID
也无法在 sandbox 更换后保持不变。

本增量只注册不可变元数据，不创建 Workspace、不启动 worker、不发远程请求、不选择
provisioner，也不授予执行权限。CLI admission、adapter、Kubernetes、退役与重新注册
均留给后续增量。现有 LOCAL/UNREGISTERED 行为保持不变。

## 契约与决策

Operator 提交 `ExternalStorageIdentity`（`providerId`、`physicalKey`、正数
`registrationRevision`）与 `StorageAlias`（`tenantWorkspaceId`、`aliasPath`、
`mountRoot`）。ID 使用 `[A-Za-z0-9._-]{1,128}`。路径必须绝对、非根目录、最多 2048
字符，由非空 `[A-Za-z0-9._-]+` 分量组成，并排除 `.` 与 `..`。这是可移植的词法
契约，不是文件系统证明；远端权限与目录存在性仍未验证。

`tenantWorkspaceId` 保留一个租户内 storage ID，不接管已有 alias、Workspace 或
Runtime binding。物理 owner key 对 provider 与 physicalKey 做 hash，不包含 revision，
使新 revision 无法绕过单租户 ownership。每个物理 owner 只对应一个不可变 alias。
External alias path 全局排他。冲突返回脱敏的 HTTP 409。

注册接口属于持久 Workspace 范围的 operator 控制面：
`POST /internal/managed-workspaces/v1/storage:register-external`。它要求显式 loopback
监听、本地与对端地址均为 loopback、现有 Broker bearer 凭据及 tenant header。
该凭据是 operator 全局凭据；Workspace grant 与 forwarded header 不授予访问权限。
输入上限为 16 KiB，拒绝重复或未知 JSON 字段，响应使用 no-store。

租户范围内的 `idempotencyKey` 使用 `[A-Za-z0-9._:-]{1,128}`，请求 digest 仅包含
registration。可选的可见 ASCII `requestId`（1–128 字符）只设置 HTTP 关联，不参与
幂等身份。同内容重试在重启后仍返回原 registration ID 与毫秒时间戳；同 key 改内容
返回 `idempotency_conflict`。新请求也不能修改已有 owner。

## 持久化与兼容性

在一个事务中写入现有 `ma_storage`、`ma_storage_owner` 与 `ma_request_receipt`。
唯一 schema 扩展是在 fresh V1 baseline 及共享 Java 契约中增加 `EXTERNAL_STORAGE`
receipt namespace。已有开发数据库需要重建；不提供升级或 repair 路径。

先获取现有 tenant placement lock，再获取共享 external-registration lock。后者使跨
租户 alias 检查串行化；元数据线性扫描是针对低频 operator 操作的明确取舍。Owner
保持 `mount_state=UNVERIFIED` 且无 holder。本地执行、恢复及 CSI 注册拒绝 EXTERNAL
alias；本地 Files 调用不会解释这些路径。

## 验证与后续工作

聚焦注册测试覆盖基于 SQL 的成功与重试、重启、身份漂移、租户及 alias 冲突、并发
注册、旧 alias 兼容性、执行拒绝、loopback/bearer admission 和脱敏错误。同一组用例
通过现有集成 profile 在 MySQL 上执行。路由 admission 与 capability 清单包含这个
operator 专用接口；CLI parity 清单明确将其排除在客户端能力之外。

本地验证仅运行新增测试、编译和 Checkstyle，共享 Java 预算为十分钟。真实 MySQL、
路由契约测试与完整 CI gate 仍是验收前置条件。未来激活必须先证明远端存储身份，
并安装 writer/generation fence，再开放工具；单纯注册永远不构成充分证明。
