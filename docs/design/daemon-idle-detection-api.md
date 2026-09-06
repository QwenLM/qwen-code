# Daemon 闲置检测接口设计

## 背景

### 问题

Qwen Daemon 会部署在多台机器上作为长驻服务。当 Daemon 长时间无任务执行时，继续占用机器资源是浪费。外部调度器（K8s HPA / 自定义 Scaler）需要一个可靠的信号来判断 Daemon 是否处于闲置状态，以便做缩容回收。

### 现状

目前可用的接口：

| 接口                           | 返回信息                                          | 局限                                                                  |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /health?deep=true`        | `{ sessions, pendingPermissions }`                | 只有 session 数量，无法区分"有 session 但空闲"和"有 session 正在工作" |
| `GET /workspace/:cwd/sessions` | 每个 session 的 `hasActivePrompt` + `clientCount` | 需要额外一次请求，且无时间维度信息（多久没活动了？）                  |

**核心缺失**：

1. 没有汇总级别的"是否有活跃 prompt"指标
2. 没有"最后活动时间"，外部系统需要自己维护状态机来计算空闲时长
3. 没有 SSE 连接数暴露（已内部维护 `activeSseCount`，但 `/health` 未返回）
4. 没有 channel（agent 子进程）存活状态暴露

## 设计目标

提供一个**单次 HTTP 调用即可完成闲置判断**的接口，满足：

- 外部调度器一次 GET 即可判断是否可回收
- 支持时间维度（空闲了多久），避免外部维护状态
- 向后兼容现有 `/health` 行为
- 零额外依赖，利用已有内部状态

## 方案

### 增强 `GET /health?deep=true` 响应

在现有 `/health?deep=true` 返回中追加字段：

```jsonc
// GET /health?deep=true
{
  "status": "ok",

  // --- 已有字段（不变）---
  "sessions": 2,
  "pendingPermissions": 0,

  // --- 新增字段 ---
  "activePrompts": 1, // 正在执行 prompt 的 session 数
  "connectedClients": 3, // 活跃 SSE 连接数
  "channelAlive": true, // agent 子进程是否存活
  "lastActivityAt": "2026-06-10T08:30:00.000Z", // 最后一次活动时间（ISO 8601）
  "idleSinceMs": 120000, // 距离最后活动已经过去的毫秒数
}
```

### 字段定义

| 字段               | 类型             | 语义                                                                              |
| ------------------ | ---------------- | --------------------------------------------------------------------------------- |
| `activePrompts`    | `number`         | 当前 `promptActive === true` 的 session 计数                                      |
| `connectedClients` | `number`         | 当前活跃 SSE 连接数（已有 `activeSseCount`）                                      |
| `channelAlive`     | `boolean`        | agent 子进程是否存活（已有 `bridge.isChannelLive()`）                             |
| `lastActivityAt`   | `string \| null` | 最后一次 prompt 开始或完成的 ISO 时间戳；daemon 启动后从未有过 prompt 时为 `null` |
| `idleSinceMs`      | `number \| null` | `Date.now() - lastActivityAt`；无活动记录时为 `null`                              |

### "活动" 的定义

以下事件视为"活动"，会刷新 `lastActivityAt`：

- prompt 开始执行（`promptActive` 从 false → true）
- prompt 完成/失败（`promptActive` 从 true → false）
- 新 session 创建（`spawnOrAttach` 成功）
- session 恢复/加载（`loadSession` / `resumeSession` 成功）

**不**视为活动的事件（避免误判）：

- SSE 连接/断开
- 心跳 heartbeat
- `/health` 请求本身
- permission 请求/响应

### 闲置判断规则（供外部调度器参考）

```python
def should_reclaim(health, idle_threshold_ms=300_000):
    """建议回收条件：空闲超过阈值（默认 5 分钟）"""
    if health["activePrompts"] > 0:
        return False  # 有任务在跑
    if health["connectedClients"] > 0:
        return False  # 有客户端连着
    if health["idleSinceMs"] is None:
        # 从未有过活动 — 可能是刚启动的 cold daemon
        return True
    return health["idleSinceMs"] >= idle_threshold_ms
```

## 涉及代码改动

### 1. `packages/acp-bridge/src/bridgeTypes.ts`

在 `AcpSessionBridge` 接口新增：

```typescript
/** 正在执行 prompt 的 session 数量 */
get activePromptCount(): number;

/** 最后一次活动时间戳（epoch ms），null 表示从未有过活动 */
get lastActivityAt(): number | null;
```

### 2. `packages/acp-bridge/src/bridge.ts`

在 `createAcpSessionBridge` 工厂函数内：

```typescript
// 新增状态追踪
let lastActivityTimestamp: number | null = null;

function touchActivity(): void {
  lastActivityTimestamp = Date.now();
}
```

在以下位置调用 `touchActivity()`：

- `entry.promptActive = true`（~line 2528）— prompt 开始
- `entry.promptActive = false`（~line 2551, 2559）— prompt 结束
- `doSpawn` 成功创建 session 后（~line 1906 附近）
- `restoreSession` 成功后

在返回对象中暴露：

```typescript
get activePromptCount() {
  let count = 0;
  for (const entry of byId.values()) {
    if (entry.promptActive) count++;
  }
  return count;
},

get lastActivityAt() {
  return lastActivityTimestamp;
},
```

### 3. `packages/cli/src/serve/server.ts`

修改 `healthHandler`（~line 803）中 `deep` 分支：

```typescript
const healthHandler = (req: Request, res: Response): void => {
  const deepQuery = req.query['deep'];
  const deep = deepQuery === '1' || deepQuery === 'true' || deepQuery === '';
  if (!deep) {
    res.status(200).json({ status: 'ok' });
    return;
  }
  try {
    const lastActivityAt = bridge.lastActivityAt;
    const now = Date.now();
    res.status(200).json({
      status: 'ok',
      // 已有
      sessions: bridge.sessionCount,
      pendingPermissions: bridge.pendingPermissionCount,
      // 新增
      activePrompts: bridge.activePromptCount,
      connectedClients: getActiveSseCount(),
      channelAlive: bridge.isChannelLive(),
      lastActivityAt:
        lastActivityAt !== null ? new Date(lastActivityAt).toISOString() : null,
      idleSinceMs: lastActivityAt !== null ? now - lastActivityAt : null,
    });
  } catch (err) {
    writeStderrLine(
      `qwen serve: /health deep probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(503).json({ status: 'degraded' });
  }
};
```

### 4. `packages/cli/src/serve/server.test.ts`

新增测试用例覆盖：

- `/health?deep=true` 返回新字段的正确性
- 无 session 时 `activePrompts === 0`、`idleSinceMs === null`
- prompt 执行中 `activePrompts > 0`、`idleSinceMs` 持续刷新
- prompt 完成后 `idleSinceMs` 开始递增

### 5. `packages/acp-bridge/src/bridge.test.ts`

新增测试用例覆盖：

- `activePromptCount` 在 prompt 生命周期中的值变化
- `lastActivityAt` 在各活动事件后被刷新
- 多 session 并行时 `activePromptCount` 正确累加

## 文件变更清单

| 文件                                     | 改动类型      | 说明                                            |
| ---------------------------------------- | ------------- | ----------------------------------------------- |
| `packages/acp-bridge/src/bridgeTypes.ts` | 接口扩展      | 新增 `activePromptCount`、`lastActivityAt` 属性 |
| `packages/acp-bridge/src/bridge.ts`      | 逻辑实现      | 新增 `lastActivityTimestamp` 追踪 + getter      |
| `packages/cli/src/serve/server.ts`       | HTTP 响应扩展 | `/health?deep=true` 增加新字段                  |
| `packages/cli/src/serve/server.test.ts`  | 测试          | 新增 health 接口新字段覆盖                      |
| `packages/acp-bridge/src/bridge.test.ts` | 测试          | 新增 bridge 属性覆盖                            |

## 兼容性

- **向后兼容**：新字段是追加的，不修改/删除任何已有字段
- **`GET /health`（非 deep）**：行为不变，仍只返回 `{ "status": "ok" }`
- **OTel Gauge**：已有的 `registerDaemonGaugeCallbacks` 可选后续追加 `activePrompts` gauge，但不在本次范围内

## 后续扩展（不在本次范围）

1. **自动 shutdown**：daemon 内置 `--auto-shutdown-idle-ms` 参数，空闲超时后自行退出（适合 systemd/K8s Pod 场景）
2. **OTel 指标暴露**：将 `activePrompts`、`idleSinceMs` 作为 gauge 注册到 OTel meter
3. **Webhook 回调**：空闲超阈值时主动推送事件到外部系统
