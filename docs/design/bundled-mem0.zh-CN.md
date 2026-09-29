# 主包内置 Mem0

[English](bundled-mem0.md) | [简体中文](bundled-mem0.zh-CN.md)

状态：已实现；PolarDB V2 已经通过私网隧道验证，并未验证公网直连。其他 provider 契约仍以各自记录的证据为界。

## 问题与范围

[#12596](https://github.com/QwenLM/qwen-code/issues/12596) 要求普通 Qwen Code 安装即可使用 Mem0。额外依赖未发布的包、单独的 MCP 配置和手工安装的写入确认 Hook 不符合目标。[#9964](https://github.com/QwenLM/qwen-code/issues/9964) 还要求 OSS 交互写入覆盖。

主 CLI 提供可配置搜索和主动启用的写入。不实现任意 REST 方言、未知协议版本、自动召回或新的服务。保留现有高级配置。对这条主动启用的内置路径，本设计替代此前 direct-external-context 设计中“仅管理员配置、单独安装”的交付要求。

## 配置与协议合同

在用户设置（`~/.qwen/settings.json`）中加入并重启 Qwen Code。与 `modelProviders` 一样，顶层 `env` 字段可定义凭证值，`envKey` 选择变量名：

```json
{
  "env": {
    "MEM0_API_KEY": "<your-provider-key>"
  },
  "memory": {
    "mem0": {
      "baseUrl": "https://your-mem0-endpoint.example",
      "protocol": "mem0-v2",
      "envKey": "MEM0_API_KEY"
    }
  }
}
```

`envKey` 默认为 `MEM0_API_KEY`。历史字段 `credentialEnv` 保留为别名；两者同时指定不同变量名时报错。两个字段都不存储密钥值。复用现有环境加载器：非空进程环境优先于 `.env`，再优先于 `settings.env`。MCP 子进程继承解析后的环境；生成的绑定配置仅包含变量引用，不含凭证值。不新增凭证存储或加载器。单文件配置无需 shell export，但 JSON 会明文存储凭证，应使用用户设置且不能提交或公开。shell export 和 `~/.qwen/.env` 仍可使用。

`baseUrl` 是 origin 加可选的反向代理前缀，不是完整操作地址。不允许凭证、query、fragment、空白和反斜杠。除回环 HTTP 外必须使用 HTTPS；可信的纯 HTTP PolarDB 地址需要 `"allowInsecureHttp": true`。该开关不绕过网络路由或服务白名单。

`protocol` 选择完整协议合同，不是简单往 URL 拼一个版本号：

| ID                 | 认证                   | 搜索                            | 写入                          | 范围                            |
| ------------------ | ---------------------- | ------------------------------- | ----------------------------- | ------------------------------- |
| `mem0-v2`（默认）  | `Authorization: Token` | `/v2/memories/search`，`limit`  | `/v1/memories`，同步 ID       | 必须有 `userId`；可选 `agentId` |
| `mem0-v3`          | `Authorization: Token` | `/v3/memories/search/`，`top_k` | `/v3/memories/add/`，异步状态 | 必须有 `appId`                  |
| `mem0-oss-2026-08` | `X-API-Key`            | `/search`，`top_k`              | `/memories`，同步 ID          | 必须有 `userId`；可选 `agentId` |

默认是 PolarDB 风格的 v1 写入/v2 搜索合同，不保证兼容所有标称“Mem0 v2”的服务或 Hologres。OSS 合同固定为现有集成定义；假服务验收不等于兼容所有上游 OSS 版本。

保留旧 ID `mem0-platform-v3` 和 `mem0-oss-rest-2026-08` 作为别名。`aliyun-polardb-mysql-2026-08` 也继续接受并保留历史 `top_k` 字段及原样搜索内容，不会默默映射成 `limit` 或 V2 规范化行为。私网隧道验收验证了 `mem0-v2` 的 limit 处理和直接导入文本；这不证明公网路由或所有服务都可用。适配器始终把最终搜索结果限制为五条。

## 绑定与生命周期

只有用户、系统和系统默认设置可配置绑定。工作区设置不能启用它、重定向地址、更改 scope，也不能通过替换父级 `memory` 字段抹掉操作者的绑定。

CLI 自动创建名为 `external-context` 的 stdio MCP 服务，运行随主包交付的 `mem0/main.js`。默认只暴露 `context_search`，不安装自动召回 Hook。操作者设置/会话/CLI 显式配置了同名服务时，报配置冲突；内置绑定优先于工作区设置和项目 `.mcp.json` 中的同名项。现有 MCP 优先级也会覆盖扩展提供的同名服务；切换到内置路径时应禁用高级 external-context 扩展，同时移除旧的手工确认 Hook，否则可能运行两份确认。用户 Hook 使用相同 matcher 也不会替代内置的必需确认。

默认 scope 是 `qwen-` 加 SHA-256 前 32 个十六进制字符，输入为本机 home 目录、换行和规范化 Git 根目录（非 Git 项目则是规范化当前目录）。重启和 Git 子目录保持相同 scope；其他 checkout 或移动后的仓库使用不同 scope，包括临时 `--worktree` 和 agent 隔离工作树。哈希只是标识符，不是服务端权限隔离。要复用已有记忆或主动跨工作树共享范围，设置 `scope.userId`（V2/OSS）或 `scope.appId`（V3），仅在支持的协议中使用可选 `scope.agentId`。

bare、safe、不可信、临时和 SSH 工作区会话不启用此本地绑定。非交互/ACP 或禁用 Hooks 的会话保留搜索，但即使设置启用了写入也不暴露写入工具。重启重新读取设置；`/hooks` 重载保留当前绑定的确认 Hook。

## 写入与失败语义

`"enableWrites": true` 在启用 Hooks 的交互 CLI 中暴露 `context_remember`。Qwen 自动安装现有精确内容确认 Hook。普通 MCP 权限仍生效，YOLO 保留内容确认。取消不发送写入请求。写入使用 `infer: false`，只发送批准内容。

有效同步 ID 才表示 `stored`；V3 接受事件表示 `accepted`，不表示持久化完成。明确拒绝标记 `failed`，修正所报告的原因后再重试。结果不明确的网络/响应失败标记 `unknown`，不能自动重试。确认属于应用层 UX 保护，不是针对能修改 Hooks 或直接调用服务的本机操作者的强制隔离边界。

`timeoutMs` 默认 5000，范围 1–30000。凭证/运行文件缺失、不支持的配置和服务错误都保持可见，不自动切换其他 provider。

## 分发与兼容性

复用 direct external-context 适配器、MCP 和确认代码。打包为自包含的 `dist/mem0/main.js` 和 `dist/mem0/write-confirmation.js`，不增加 npm 依赖或单独发布步骤。npm 和 standalone 打包都拒绝缺失运行文件的产物，并包含 `mem0` 目录。

通用 dialect 集成保留为高级路径。本改动不迁移管理员编写的配置，也不声称两套实现已经完全删除或收敛。清理单独发布路径是另一项兼容性决策，不是主包可用的前置条件。

## 验证与验收

1. 单元检查：生成的 endpoint/protocol/scope、`envKey`/历史别名兼容和冲突、不序列化凭证、默认只读、仅交互写入、Hook 组合和工作区隔离。
2. 打包：npm/standalone 都要求两个运行文件；打包后的 stdio 客户端可发现工具并搜索，不依赖单独发布的包。
3. 受控服务交互检查：V3/OSS 批准、取消且无 HTTP 写入、YOLO 内容确认。OSS 使用 `memory.mem0.envKey`，凭证仅在 `settings.env` 中定义，无需 shell export 或手工注册 MCP/Hook。这些交互场景在本地和 release lane 运行，不属于 PR CI；PR 检查全绿不能单独证明该交互通过。
4. 真实 PolarDB 独立验收：认证、斜杠行为、`limit`、批准写入 ID、相同 scope 重启后搜索、定向清理。不打印或提交凭证。

第 4 项完成前只报告打包/受控服务验证，不报告真实 PolarDB 端到端验证。外部门槛是有效凭证、可达且已加白名单的服务，以及进入主 CLI 发布版本；不需要单独发布 Mem0 npm 包。
