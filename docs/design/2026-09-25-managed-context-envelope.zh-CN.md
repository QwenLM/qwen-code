# Managed Context Envelope（W0a-2）

[English](2026-09-25-managed-context-envelope.md) | [简体中文](2026-09-25-managed-context-envelope.zh-CN.md)

状态：契约已定义。自 W0c-1 起 worker 提供它（[Managed Context Worker](2026-09-26-managed-context-worker.zh-CN.md)），尚无 Broker 写出 boot v2。更新：2026-09-26。本文是 Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的第二个 W0 切片，建立在 [Workspace 绑定契约](2026-09-25-managed-workspace-binding-contract.zh-CN.md)（W0a，#12681）之上。[这条答复](https://github.com/QwenLM/qwen-code/issues/12380#issuecomment-5825755703)要求现在就定下 envelope 的形状，契约先行：“先 envelope 形状 + 共享 schema/fixtures，后处理器”。下文的“参考设计”指该提案的 [Workspace 与 Session cwd 设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-context.md)、[契约收口](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-contract-closure.md)和 [attestation 设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-runtime-attestation.zh-CN.md)，都取自 #12380 所链接的提交。

## 问题

Managed Runtime worker 通过 boot 文档得知自己的身份，再通过 attestation 证明这个身份。两者都只用一个目录 `workspaceCwd` 来描述 Runtime 的 Workspace，并把 `workspaceId` 当作不透明的标签。

W0 用 Registry 中的 Workspace 取代这个目录：一个租户、一个 Workspace ID、一个 generation 和一个 storage ID，Broker 把它的文件挂载在某个根目录下。W0 还加入了每个 Session 的上下文：一个相对目录、一个配置引用和一个 revision。W0a 把这七个值绑定成 `ContextBinding` 及其 `contextDigest`。

目前 worker 无法接收其中任何一项。在 boot 文档、attestation 或 Tool v2 上原地加字段，会破坏它们的封闭形状；而把 W0 Session 交给一个旧 worker，可能让工具在错误的目录中运行。因此 W0 需要一个协商出来的协议 `managed-context/1`，并配上新的严格版本，让旧 worker 在任何东西运行之前就拒绝 W0 Session。

## 现状

以下事实基于 `main` 的 `ab61e04161`。

- **Boot v1。** `LocalProcessRuntimeProvisioner` 向 worker 的标准输入写入一个 JSON 对象并关闭输入。该对象有 14 个键：Runtime 身份、`tenantId`、`workspaceId`、`workspaceGeneration`、`workspaceCwd`、`capabilityDigest`、`isolationClass`、`token`、`type: "boot"` 和 `version: 1`。worker 在 32 KiB、30 秒以内只接受恰好这个键集，然后通过 attestation 身份检查各字段的类型。被拒绝的 boot 会让 worker 在输出 ready 行之前退出，Java 报告为可重试的 `runtime_provision_failed`。
- **Ready v1。** worker 在标准输出上回一行：`type`、`version: 1`、`runtimeInstanceId`、`runtimeIncarnation`、`leaseId`、`epoch` 和一个回环地址 `url`。Java 会比对回显的值，但忽略多余的键。
- **Attestation v2。** `POST /internal/managed-runtime/v2/attest` 的请求封闭为 8 个键，响应为 12 个键。每个 scope 字段（包括 `workspaceCwd`）都与 boot 文档逐字比较，不一致返回 409 `managed_runtime_identity_conflict`。
- **Tool v2。** execute、status 和 cancel 路由只通过 lease 请求头绑定到 Runtime。每次调用的 reference 带有 `sessionId`，但不带任何 Workspace、目录或上下文字段。自 #12671 起，worker 通过一个以 boot 中 `workspaceCwd` 为根目录的工具执行器提供这些路由，其原始路由 gate 只放行已声明的 v2 路由。执行器不会把工具路径或 shell 命令限制在该目录内；工具契约要求 Harness 在准入调用时决定 Workspace 边界，而这一准入尚未接通。
- **放置。** `RuntimeScope` 的六个字段参与计算 Broker 的 request key 和 scope key。一个按 Workspace 隔离的 Runtime 由解析到同一 scope 的所有 Session 共享。
- **契约。** Attestation v2 和 Tool v2 有共享的 schema 和 fixtures。boot 文档和 ready 记录都没有；Java 测试启动的 fake worker `fake-attestation-worker.mjs` 也什么都不校验。
- **W0a。** `ContextBinding` 有七个字段：`tenantId`、`workspaceId`、`workspaceGeneration`、`storageId`、`cwdRelative`、`contextConfigRef` 和 `contextRevision`。Java 与 TypeScript 计算出相同的 `contextDigest`，由共享 fixtures 固定。

## 目标

- 定义 Broker 与 worker 如何就 `managed-context/1` 达成一致，以及任一方如何拒绝它。
- 定义 boot v2 和 ready v2：boot v2 是携带 Workspace 绑定和挂载根目录的封闭形状，ready v2 是接受它的封闭记录。
- 定义 attestation v3，让 W0c 复用现有的 gate，而不是另起一套 Workspace attestation。
- 定义上下文安装请求及其回执，把一个 Session 的 `ContextBinding` 绑定到 Runtime。
- 用一份两种语言都运行的共享 schema 和 fixtures 文件固定以上全部内容。
- 保持 boot v1、ready v1、attestation v2 和 Tool v2 不变。

## 非目标

- **接线。** 本切片中没有 worker 接受 boot v2 或挂载 v3 路由，也没有 Broker 写出 boot v2。W0c 会在 #12671 完成的 worker 之上完成接线。
- **挂载与文件系统检查。** 把 storage 解析为挂载根目录，以及检查存在性、realpath、符号链接和挂载身份，属于 W0c 的 storage 解析器和安装处理器。
- **后续的绑定。** 根据 `contextConfigRef` 安装配置、activation gate、Tool v2 调用外层的逐次调用绑定，以及 journal 和 checkpoint 中的回执，属于 W0c 及之后的切片。
- **放置。** `RuntimeScope`、Broker 的 request key 和 scope key 以及它的 schema 都不变。

## 协商

`managed-context/1` 是一个能力标记，命名风格与 `qwen-hosted-harness/1` 相同；下文称它为协议标记，以区别于 bearer `token`。以后如有不兼容的改动，就换一个新的协议标记。

- **提出。** Broker 通过写出携带协议标记的 boot v2 来提出这个协议。只有当 Runtime 绑定的 Session 带有 Workspace 上下文时，Broker 才写 boot v2；其他绑定仍用 boot v1。
- **接受。** 实现了该协议的 worker 用 ready v2 回应，并重复协议标记。之后它提供 attestation v3 和安装路由，并对 attestation v2 返回 404，这样一个 Runtime 永远不会呈现两种身份。Tool v2 路由的形状不变，但在 boot v2 下，工具调用只会为已安装上下文的 Session 执行，并且在该上下文的实际目录中执行。W0c 通过按调用绑定实现这一点。
- **在任何副作用之前拒绝。**
  - 只实现 boot v1 的 worker 会因为封闭键集而拒绝 boot v2，并在输出 ready 行之前退出。
  - 收到 ready v1 记录、不带协议标记的 ready 记录，或者 v3 路由返回 404，都说明对端不兼容。
- **不降级。** Broker 绝不会用 boot v1 为 W0 Session 创建 Runtime，也绝不会把被拒绝的 boot v2 改成 boot v1 重试。没有 W0 上下文的绑定永远不会收到 boot v2。

## Boot 文档 v2

传输方式不变：标准输入上的一个 UTF-8 JSON 对象，最大 32 KiB，30 秒内关闭。该对象恰好包含以下键。

| 键                                                                         | 规则                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `type`                                                                     | `"boot"`                                                                   |
| `version`                                                                  | `2`                                                                        |
| `managedContext`                                                           | `"managed-context/1"`                                                      |
| `runtimeInstanceId`、`runtimeIncarnation`、`leaseId`、`provisionRequestId` | W0a 的标识符规则 `[A-Za-z0-9._:-]{1,128}`                                  |
| `token`                                                                    | 采用 token68 语法 `[A-Za-z0-9._~+/-]+=*`、长 1 到 512 个字符的 bearer 凭据 |
| `epoch`                                                                    | 1 到 2^53−1 的整数                                                         |
| `capabilityDigest`                                                         | 匹配 `sha256:[0-9a-f]{64}` 的字符串                                        |
| `isolationClass`                                                           | `"session"` 或 `"workspace"`                                               |
| `tenantId`、`workspaceId`                                                  | W0a 的标识符规则 `[A-Za-z0-9._:-]{1,128}`                                  |
| `workspaceGeneration`                                                      | W0a 的十进制规则：1 到 2^63−1 的规范十进制文本                             |
| `storageId`                                                                | W0a 的 storage 规则：1 到 256 个可打印 ASCII 字符                          |
| `mountRoot`                                                                | 1 到 4096 个 UTF-8 字节的绝对路径，格式良好，不含控制字符                  |

- **挂载根目录。** `mountRoot` 取代 v1 的 `workspaceCwd`，是 Broker 的 storage 解析器挂载这个 Workspace 的根目录。绝对路径以 `/` 开头，或以盘符加分隔符开头（`C:\` 或 `C:/`），或以两个反斜杠开头（`\\`，UNC 路径）。长度上限按 UTF-8 字节计算，限制的是线上的值；路径是否存在由安装处理器验证。在安装处理器验证之前，worker 只把它当作数据。
- **不带路径哈希。** daemon 的路径哈希（路径 SHA-256 的前 16 个十六进制字符）不在其中。worker 需要与 daemon 兼容的本地 ID 时，会从验证过的挂载根目录自行推导，因此公开的 `workspaceId` 永远不是路径哈希。
- **不带 Session 上下文。** 按 Workspace 隔离的 Runtime 服务多个 Session，而 `cwdRelative`、`contextConfigRef` 和 `contextRevision` 必须留在放置身份之外。无论哪种隔离级别，每个 Session 都按下文所述单独安装自己的上下文。
- **有界的标识符。** v1 接受任意长度的标识符，并在启动时拒绝 attestation 响应会超过 16 KiB 的 boot。v2 改为给四个 Runtime 标识符设定上界，因为 attestation 响应和回执会重复它们；所有被重复的字段都有上界，这些记录就总能放进各自的上限（见[大小](#大小)）。v2 还把 token 限定为 `Authorization` 请求头能够携带的语法，并限定在 Broker 自己的上限 512 个字符以内，远低于 worker 的 HTTP 服务器所能接受的请求头大小。
- **Broker 的取值。** Broker 目前的标识符是 UUID，或者是 UUID 形式的 binding ID 后接 `:` 和其 generation；它的 token 是不带填充的 base64url。这些都满足上述规则。`BrokerValues.requireId` 本身允许最多 512 个除 NUL 以外的任意字符，因此 W0c 要确保它写入 boot v2 的值符合上述规则。

## Ready 记录 v2

worker 在标准输出上回一行。这一行是一个 JSON 对象，恰好包含以下键：`type: "ready"`、`version: 2`、`managedContext: "managed-context/1"`、`runtimeInstanceId`、`runtimeIncarnation`、`leaseId`、`epoch` 和 `url`。

- 四个身份值重复 boot 文档中的值。
- `url` 为 `http://127.0.0.1:<port>`，端口为 1 到 65535 的规范十进制（不带前导零），不带路径、查询、片段或用户信息。
- 与 v1 不同，Broker 会检查精确的键集。

## Attestation v3

Attestation v3 保留 v2 的 gate，只改变身份字段。

- **路由。** `POST /internal/managed-runtime/v3/attest`，协议版本 3，沿用 v2 的大小上限（请求和响应各 16 KiB），并带 `Cache-Control: no-store`。新路径让用 v1 启动的 worker 返回 404。
- **请求头。** 与 v2 相同：bearer token、`Cache-Control: no-store`、JSON 内容类型、`X-Qwen-Managed-Lease-Id` 和 `X-Qwen-Managed-Lease-Epoch`。
- **请求。** 封闭为 `protocolVersion`、`managedContext`、`provisionRequestId`、`tenantId`、`workspaceId`、`workspaceGeneration`、`storageId`、`mountRoot`、`capabilityDigest` 和 `isolationClass`，适用 boot v2 的规则。
- **响应。** 封闭为请求中的字段，再加上 `runtimeInstanceId`、`runtimeIncarnation`、`leaseId` 和 `epoch`。
- **检查。** worker 先按上述规则检查请求；违反任何一条的请求返回 400 `managed_runtime_attestation_invalid`。然后把八个被证明的字段（即除 `protocolVersion` 和 `managedContext` 之外的每个请求字段）与自己的 boot 文档按字符串逐字比较，不对路径做规范化。任何不一致都是 409 `managed_runtime_identity_conflict`。attestation 用例会重复 boot 中每个只改动一个被证明字段的用例，合法与非法的都包括：非法的值返回 400，合法但与 boot 文档不同的值会进入比较并返回 409。fixtures 还会把每个格式错误的请求对象，在它未触及的每个被证明字段都换成另一个合法值后再重复一次，因此在检查形状之前比较任何字段的 worker 都无法通过它们。

## 上下文安装

一次请求在一个 Runtime 上安装一个 Session 的上下文，并返回一份回执。处理器由 W0c 实现；本切片固定形状和检查顺序。

- **路由。** `POST /internal/managed-runtime/v3/context`，协议版本 3，上限 16 KiB，`no-store`，请求头与 v2 相同。
- **请求。** 封闭为以下键：

| 键                | 规则                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `protocolVersion` | `3`                                                                                      |
| `managedContext`  | `"managed-context/1"`                                                                    |
| `operationId`     | W0a 的标识符规则；Broker 为这次安装给出的幂等键                                          |
| `sessionId`       | Tool v2 引用中携带的 Runtime Session ID：1 到 512 个 UTF-16 码元，格式良好，不含 NUL     |
| `binding`         | 封闭为七个 `ContextBinding` 字段的对象，每个字段适用 W0a 的规则，取 W0a 的线上字符串形式 |
| `contextDigest`   | 匹配 `sha256:[0-9a-f]{64}` 的字符串                                                      |

worker 按以下顺序检查请求，遇到第一个失败就停止：

1. 不符合形状的请求返回 400 `managed_runtime_attestation_invalid`。
2. `contextDigest` 不是 `binding` 的 W0a 摘要时，同样返回 400 `managed_runtime_attestation_invalid`。
3. `binding` 的 `tenantId`、`workspaceId`、`workspaceGeneration` 或 `storageId` 与 boot 文档不同时，返回 409 `managed_runtime_identity_conflict`。因此一个 Runtime 永远不会安装其他 Workspace 的上下文。
4. 一个 `operationId` 已经以不同的 `sessionId` 或 `contextDigest` 用过时，返回 409 `managed_context_conflict`。用相同的三个值重复安装，会返回原来的回执，不做任何改变。
5. 为已有不同上下文的 Session 安装时，返回 409 `managed_context_conflict`。
6. 在 W0c 中，处理器把 `mountRoot` 与 `cwdRelative` 拼接成实际目录并加以验证。无法验证时返回 409 `managed_context_unavailable`，不安装任何东西。
7. worker 记录这次安装，返回 200 和回执。

fixtures 固定了这一顺序：

- 每个格式错误的请求对象都会在一次成功安装之后重复一次；再把它的 binding 中未触及的每个 Workspace 字段换成另一个合法值，又重复一次。
- 违反规则的 binding 携带按其原始字段计算的摘要，因此只有规则本身会拒绝它。
- 对四个 Workspace 字段中的每一个，都有三个序列检查 Workspace 部分的检查先于操作检查、先于 Session 检查，也先于对另一个 Session 复用的操作的检查。

把形状、binding 规则或摘要的检查放到后面，或者把 Workspace 部分的检查放到操作或 Session 检查之后的 worker，都无法通过它们。

- **回执。** 封闭为 `protocolVersion`、`managedContext`、`operationId`、`sessionId`、`runtimeInstanceId`、`runtimeIncarnation`、`epoch`、`contextDigest`、`contextRevision` 和 `workspaceGeneration`。最后三项让 Broker 可以核对 Runtime 安装的是哪个上下文、哪个 revision 和哪个 generation。
- **Session ID。** Broker 自己对 Runtime Session ID 的检查允许未配对的代理项，而它的 JSON 编码器会把它们替换成 `?`，于是两个不同的 ID 到达 worker 时会变成同一个。安装规则能拒绝以转义形式到达的未配对代理项，却看不到编码器已经造成的碰撞。只有 Broker 能避免这种碰撞，因此 W0c 必须在把 Session ID 写入安装请求之前，把 Broker 的检查收紧到本规则。
- **每个 Session 一个上下文。** 一个 Session 已安装的上下文，只能通过之后用于目录变更的协议（W2）来改变；在那之前，第 5 步会拒绝不同的上下文。同一个 Session 以同一个上下文、换一个新的 `operationId` 安装时会成功，并得到新的回执。

## 大小

响应中重复的每个字段都有上界。因此，由合法 boot 文档和合法请求构造出的 attestation 响应和每张回执都不超过 16 KiB，最大的合法 attestation 请求和安装请求也同样不超过。TypeScript 测试会构造出其中每一种的最大值：attestation 响应约 9.9 KB，安装请求约 9.4 KB。这些大小按不转义非 ASCII 字符的 UTF-8 JSON 计算，`JSON.stringify` 和 Broker 的 fastjson2 编码器都这样写出。转义所有非 ASCII 字符的编码器可能让最大的安装请求超出上限，因此双方都不能使用这种编码器。

## 错误

| 状态码 | 错误码                                  | 类别         | 何时                                                                                  |
| ------ | --------------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| 401    | `managed_runtime_unauthorized`          | credentials  | bearer token 缺失或错误                                                               |
| 400    | `managed_runtime_attestation_invalid`   | protocol     | 形状、请求头或协议版本错误，或 `contextDigest` 错误                                   |
| 413    | `managed_runtime_attestation_too_large` | protocol     | 请求体超过其上限                                                                      |
| 409    | `managed_runtime_identity_conflict`     | identity     | lease 请求头、attestation 或 binding 与 boot 不一致                                   |
| 409    | `managed_context_conflict`              | identity     | 以其他值复用 `operationId` 或 Session                                                 |
| 409    | `managed_context_unavailable`           | recovery     | 无法验证实际目录；或在 boot v2 下，`execute` 调用的 Session 没有已安装的上下文（W0c） |
| 404    | 无                                      | incompatible | 该 worker 的 boot 版本不提供的路由                                                    |

前四个是 attestation v2 和 Tool v2 已经在用的错误码，Broker 对它们保持现有的分类。与 v2 不同，这里的 409 可能带三种错误码之一，而现在的 transport 只按状态码对拒绝分类。因此 v3 客户端按状态码和错误码一起分类，并把错误码未知的 409 当作身份冲突。共享 fixtures 中包含这张表。`managed_context_conflict` 不可重试。`managed_context_unavailable` 会保持该 Session 的工具 gate 关闭，并按参考设计的要求把它的上下文标记为 `recovery_blocked`；它绝不会回退到其他目录。

## 安全

- token 只出现在标准输入和 bearer 请求头中，绝不出现在命令行参数、环境变量、响应或错误信息里。
- `mountRoot` 和实际目录只留在私有协议之内，绝不出现在公开 DTO、公开错误或离开 Broker 的日志行中。
- worker 从不从请求中获取身份。attestation 把请求与 boot 文档比较；安装把 binding 中 Workspace 的部分与 boot 文档比较，并重新计算摘要。
- 路径逐字比较。规范化和包含关系检查是安装处理器的职责，而不是比较的职责。
- 实际目录是 Session 的工具开始执行的位置，而不是沙箱。按照 Tool v2 契约的要求，Workspace 边界由 Harness 在准入调用时决定。

## 共享 schema 与 fixtures

`packages/cli/src/serve/contracts/managed-context-v1.schema.json` 和 `.fixtures.json` 包含整个契约：

- 协议标记、boot 和 ready 的版本，以及两条 v3 路由；
- 合法和非法的 boot 文档与 ready 记录；
- attestation 请求和安装请求，各自带期望的状态码和错误码，针对同一个规范的 boot 文档重放；
- 检验幂等和冲突的安装序列；
- 期望的 attestation 响应和回执；
- 错误表，以及每个错误码的分类。

schema 固定每种记录的形状，以及它能以可读方式表达的规则。JSON Schema 无法表达 UTF-8 字节数或 UTF-16 码元数的上限、binding 的摘要，以及与 boot 文档的比较；2^63−1 的上界和目录规范形式中关于路径段的规则虽然能用 pattern 表达，但只能写得难以阅读。schema 确实表达了目录可用的字符，以及目录既不以 `/` 开头、也不以盘符开头。这些规则由 fixture 用例固定，TypeScript 测试还会检查 schema 与模块在其他用例上没有分歧。

由于规则会拒绝未配对的代理项，有些用例以 `\uXXXX` 转义的形式携带它们。使用方必须用能保留这类转义的解析器读取文件，`JSON.parse`、Jackson 和 Python 的 `json` 都可以。默认配置下 Rust 的 `serde_json` 会拒绝这个文件。`jq` 会拒绝未配对的高位代理项，并把未配对的低位代理项替换成 U+FFFD，所以同样读不了这个文件；Go 的 `encoding/json` 则会静默地把每个未配对的代理项都替换成 U+FFFD。

与 W0a 一样，期望值和每个 `contextDigest` 都由一个独立于两种语言的实现计算得出。

- **TypeScript。** `packages/cli/src/serve/managed-context-envelope.ts` 校验 boot 文档、ready 记录、attestation 请求和安装请求，构造 ready 记录、attestation 响应和回执，并保证安装的幂等性。其中对 ready 记录的校验是 W0c 中 Broker 侧校验的参照。它复用 W0a 的校验和摘要。在 W0c 之前，worker 不会引入它。
- **Java。** `runtime-broker` 中的一致性测试读取 schema 和 fixtures，固定每个封闭键集、路由和常量，用 `ContextBinding` 重新计算每个安装摘要，并检查 attestation 响应和每张回执都重复了 boot 文档和绑定中的值。boot v2 的 Java 构造器和 v3 客户端随 W0c 的接线一起加入，那时它们才有调用方。
- **Fake worker。** 它只提供 v1，本切片不改动。W0c 会把它扩展到 v2，并让它对两个版本都强制封闭键集。

## 涉及文件

- `packages/cli/src/serve/contracts/managed-context-v1.schema.json` 与 `.fixtures.json`（新增）。
- `packages/cli/src/serve/managed-context-envelope.ts` 及其测试（新增）。
- `packages/sdk-java/runtime-broker/src/test/java/com/alibaba/qwen/code/runtimebroker/managedworkspace/` 中的一致性测试（新增）。
- `packages/cli/src/serve/managed-workspace-binding.ts` 导出它的三项 W0a 检查以供复用，行为不变。
- 本设计文档的中英文两个版本（新增），以及 W0a 文档的“启动信封”一节和后续工作表，它们现在指向本文。
- runtime-broker 的 `README.md` 和 `QWEN.md`，其中关于摘要的维护规则现在也点名这些 fixtures。

worker、attestation 契约、provisioner、transport、fake worker 和 CI workflow 都不变。

## 验证计划

- **TypeScript：** 用严格模式的 Ajv 按 schema 校验 fixtures；让每个用例（包括安装序列）经过该模块重放；用每个用例检查 schema；并测量最大的记录是否在上限之内。
- **Java：** 一致性测试固定封闭键集、路由、常量和错误表，并用 `ContextBinding` 重新计算每个安装摘要。
- **独立性：** 期望值来自根据本文编写的实现，而不是来自任何一种语言。
- **变异检查：** 逐一变异 TypeScript 模块中的每项检查并重跑测试；结果写在 PR 中。

## 验收标准

- TypeScript 与每个 fixture 一致，Java 与其中的每个键集、路由、常量、错误和安装摘要一致。boot 文档、ready 记录和 attestation 响应的 Java 检查随 W0c 一起加入。
- 由合法输入构造出的每条记录都不超过其请求体或响应体上限。
- Boot v1、ready v1、attestation v2 和 Tool v2 保持不变，worker 和 Broker 的行为也都不变。
- Workspace 部分与 boot 文档不同的安装会被拒绝，摘要与 binding 不符的安装也会被拒绝。
- 重复安装是幂等的；以其他值复用它的 `operationId` 或 Session 会被拒绝。

## 待决问题

1. 拒绝 boot 文档的 worker 是否应在退出前写一行拒绝记录？这能让 Broker 区分拒绝（绝不能重试）和崩溃（可以重试）。只实现 v1 的 worker 写不出这样的记录，所以 Broker 仍然需要为 boot v2 设置重试上限。目前 Broker 区分不了这两种情况：它丢弃了 worker 的标准错误输出，拒绝 boot v2 的 v1 worker 和崩溃的 worker 都以同样可重试的 `runtime_provision_failed` 结束。
2. 安装请求是否也应携带 `contextConfigRef` 对应的配置安装，还是留给这条路由的后续版本？
3. W0a 关于 `cwdRelative` 中控制字符的待决问题（拒绝所有 Cc 字符还是只拒绝 NUL）仍然适用；安装处理器沿用 W0a 的规则。
4. Runtime 应把安装记录保留多久？契约在 Runtime 的整个生命周期内保留每个操作和每个 Session 的上下文，而在新的 `operationId` 下安装同一个上下文会成功，所以长期运行、按 Workspace 隔离的 Runtime 会不断累积记录。W0c 必须定下保留规则，例如在 Session 结束时释放它的记录，同时不能破坏 Broker 所依赖的幂等重放。

W0c-1 已为 worker 回答了第 1、3、4 个问题：它不写拒绝记录，原样沿用 W0a 对 `cwdRelative` 的规则，并在 Runtime 的整个生命周期内保留安装记录。见 [Managed Context Worker](2026-09-26-managed-context-worker.zh-CN.md#envelope-的待决问题)。第 2 个问题仍待决。

## 后续工作

| 切片  | 范围                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W0c-1 | 已在 [Managed Context Worker](2026-09-26-managed-context-worker.zh-CN.md) 中完成：worker 接受 boot v2，并提供 attestation v3 和安装；支持 v2 的 fake worker；activation gate，它把每次 Tool v2 调用绑定到其 Session 已安装的上下文。 |
| W0c-2 | provisioner 写出 boot v2；v3 transport 客户端；在写出标识符和 Session ID 之前，把 Broker 对它们的检查收紧到上述规则；测试 Broker 的 JSON 写入器不转义非 ASCII 字符。                                                                 |
| W0c-3 | storage 解析器，以及控制面中的 Session 解析。                                                                                                                                                                                        |
| W0e   | 在整个 W0 链路验证通过之后，再声明能力（`workspace_context`）。                                                                                                                                                                      |
