# Runtime 凭据密钥轮换

[English](2026-10-15-runtime-credential-key-rotation.md) | [简体中文](2026-10-15-runtime-credential-key-rotation.zh-CN.md)

## 状态

已在 #13202 对应改动中实现；该改动合入前，发布版本中仍不可用。

## 问题

Runtime Broker 会在每条加密后的 provision seed 和 Runtime credential 旁持久化 key ID，但服务器只能配置一把 AES-256-GCM 密钥。替换这把密钥后，所有由旧密钥写入的记录都会变得不可读，即使记录本身仍明确保存了解密所需的 key ID。

## 目标

- 所有新 secret 都由一把明确配置的 active key 加密。
- 根据持久化的 key ID，使用 active key 或已配置的 previous key 解密既有 secret。
- 配置格式错误或 key ID 重复时启动失败，所需 key ID 不可用时读取失败。
- 保持现有单密钥配置兼容。

自动重加密、密钥生成、密钥过期、密钥管理服务集成和数据库迁移不在本次范围内。

## 设计

`AesGcmSecretProtector` 持有一个 active key ID 和一个 key ring。`protect()` 始终选择 active key，并把其 ID 写入 `ProtectedSecret`。`unprotect()` 只根据 `ProtectedSecret.keyId` 选择密钥；当该 ID 不存在时，绝不会回退到另一把密钥。AES-GCM 上下文绑定与密文格式保持不变。

Managed Agent server 保留现有 active 配置，并增加 previous key 映射：

```yaml
qwen:
  managed-agent:
    runtime-broker:
      credential-key-id: reference-v2
      credential-key: <base64-encoded-32-byte-v2-key>
      previous-credential-keys:
        '[reference-v1]': <base64-encoded-32-byte-v1-key>
```

每把已配置密钥解码后都必须正好为 32 字节。active key ID 不得同时出现在 `previous-credential-keys` 中。持久化 key ID 未配置时，系统继续以 `Runtime credential key is unavailable` 失败。映射键必须写成 Spring 方括号形式（`'[…]'`）：宽松绑定会规整普通键（`legacy/v1` 无论加引号与否都会绑定为 `legacyv1`），其他写法都会静默匹配不到任何持久化记录。

## 轮换步骤

1. 备份数据库和当前完整 key ring。
2. 在启动服务器前，把新密钥配置为 `credential-key-id` / `credential-key`，并把旧 active key 移入 `previous-credential-keys`。
3. 验证既有 binding 可以加载，且新写入记录携带新的 key ID。
4. 在运维证据证明没有持久化记录再引用某把旧密钥之前，保留该 previous key。删除仍被引用的密钥会按设计使这些记录不可读。

服务器不会在读取时改写旧密文。这样可以保持读取无副作用，并避免部分实例静默修改持久化凭据。

## 验证

- Protector 回归用例验证：active key 负责加密、previous key 生成的 secret 可以解密、只持有旧密钥的 protector 无法读取新密文、active/previous ID 重复时拒绝配置。
- Spring 集成测试绑定 `previous-credential-keys`，通过已配置的 `SecretProtector` 解密 previous-key secret，并证明新加密使用 active ID。
- 既有错误 context、错误 key、篡改、最大 token 和新 IV 覆盖继续适用，因为密文格式和 AES-GCM 操作没有变化。

## 验收标准

- 轮换前加密的 binding 在其 key ID 和密钥材料仍位于 `previous-credential-keys` 时可以读取。
- 轮换后创建的 binding 记录新的 active key ID。
- 缺失、格式错误、长度错误或重复的密钥配置会安全失败。
- 只配置既有 active key pair 的部署保持原有行为。
