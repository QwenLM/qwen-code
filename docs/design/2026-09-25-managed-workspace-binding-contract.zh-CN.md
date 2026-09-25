# Managed Workspace 绑定契约（W0a）

[English](2026-09-25-managed-workspace-binding-contract.md) | [简体中文](2026-09-25-managed-workspace-binding-contract.zh-CN.md)

状态：已在模块边界实现，尚未接线。更新：2026-09-25。本文是 Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 中 W0 的第一个切片。模块位置和启动信封的时机，仍在[这条评论](https://github.com/QwenLM/qwen-code/issues/12380#issuecomment-5819009126)中等待评审。

## 问题

托管的 Managed Session 必须在管理员注册过、且当前 actor 有权使用的 Workspace 中运行工具。工具从创建 Session 时选定的相对目录开始执行。这个选择必须经得起重试、重启和租户默认值的变更。Java 准入、Runtime Broker 和 Runtime worker 三方还必须对它逐字节一致。

目前没有任何一层定义这个选择。Broker 接收的是调用方解析出的任意 `RuntimeScope`。没有代码校验相对目录、检查 actor 的访问权限、应用租户默认值，也没有代码生成 worker 可以核验的身份。如果之后各层按各自的规则校验，就可能出现两种故障。一层规范化了而另一层拒绝的路径，可能让工具跑到错误的目录。重试时重新解析的默认值，可能把 Session 挪到另一个 Workspace。

## 现状

以下事实基于 `main` 的 `3413e8cc57`。

- **Broker 范围。** `RuntimeScope` 包含 `tenantId`、`workspaceId`、`workspaceGeneration`（字符串）、`canonicalCwd`、`capabilityDigest` 和 `isolationClass`。`HarnessSessionResolver` 为每个 Harness Session 解析一个 scope，Broker 不验证这些值的真实性。`LocalProcessRuntimeProvisioner` 把 `workspaceId`、`workspaceGeneration` 和规范化的 cwd 复制进 worker 的 boot 文档。
- **Worker 契约。** boot 文档是封闭键的 `version: 1`。v2 attestation 请求重复携带租户和 Workspace 字段：`workspaceId` 是不透明值；`workspaceGeneration` 是非空字符串（数字会被拒绝）；`workspaceCwd` 只检查是否非空。
- **Daemon 注册表。** daemon 的 TypeScript `WorkspaceRegistry` 负责本地多工作区的路由。它的 `workspaceId` 是规范化 cwd 的 SHA-256 的前 16 个十六进制字符，generation 是内存中的计数器。它有五种状态，没有租户概念。它不是托管侧的 Registry，W0a 不改动它。
- **Session 记录。** #12302 的 managed session record 位于 TypeScript core。它们以 `{tenantId, workspaceId, sessionId}` 标识一个 Session，不带 cwd 或绑定字段。
- **缺失的部分。** 上游没有 Java 控制面，没有 `managed_agent_session` 表，也没有 Managed Agent 公共 OpenAPI。没有任何代码定义 Workspace 选择、相对 cwd、context revision 或 ContextBinding。
- **摘要。** Java 与 TypeScript 之间没有共享的摘要规范化方式。Broker 的 JDBC repository 已经用“长度前缀 + UTF-8 字段”上的 SHA-256 生成键（`JdbcRepositorySupport.digest`）。TypeScript core 为 session record 实现了一个私有的规范化 JSON 摘要。

## 目标

- 为相对工作目录（`cwdRelative`）制定唯一的词法规则，以参考契约中的 `WorkspaceRelativePath` 规则为基础。由语言无关的 fixtures 固定下来，让 Java 与 TypeScript 拒绝和规范化同样的输入。
- 定义 Workspace Registry 的记录与读取契约，先由部署配置提供数据。
- 定义三级的 actor 访问权限。它决定列表可见性、`can_create_session` 提示和创建准入。
- 提供一个纯函数式的解析器：输入 actor 和可选的选择，输出一个已解析的 Workspace，或者恰好一个类型化的错误。它覆盖选择缺省时的租户默认值。
- 定义 `ContextBinding` 值，Java 与 TypeScript 算出相同的 `contextDigest`，由共享 fixtures 固定。
- 为调用方的选择提供一个规范化形式（含缺省标记），供 W0b 并入请求摘要。

## 非目标

- 持久化 Session 绑定、创建回执或 operation。这属于 W0b。
- 把存储解析为挂载点；接线 Broker、Harness 或 worker；打开 activation gate。这属于 W0c。
- 带版本的启动信封 `managed-context/1`，以及任何 attestation 版本升级。见[启动信封](#启动信封)。
- 公共或 BFF DTO、路由、游标和能力声明。`workspace_context` 保持 false。这属于 Stage D 和 W0d。
- 准入时的 Agent、Bundle 与配置兼容性检查。这属于 W0b。
- 文件系统检查：是否存在、realpath、符号链接和挂载身份。这些在 W0c 中由 Runtime 负责。
- Registry 的 JDBC 表。基于配置的 Registry 不需要表，Runtime Broker 的 schema 保持不变。
- 改动 daemon 的 `WorkspaceRegistry` 或 daemon 路由。

## 模块位置

已按方案 A 实现，该选择仍在 #12380 中等待评审。无论选哪个方案，代码都保持不依赖框架：不用 Spring，不依赖 CLI 内部实现，不依赖调度器，也不在持久化数据源失败时退回内存状态。

| 方案      | 位置                                                                                                     | 优点                                                                                                                                                                             | 缺点                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A（推荐） | 新模块 `packages/sdk-java/managed-workspace`（artifact `qwen-managed-workspace`，Java 21，无运行时依赖） | Registry、访问控制和解析属于控制面准入，不属于 Broker 状态。该模块与未合入的 Broker PR（#12627、#12630、#12637）没有重叠。Broker 在 W0c 中依赖其中小巧的 `ContextBinding` 类型。 | SDK Java workflow 是逐个模块显式运行的。self-hosted 与 hosted 的 Java 21 步骤、Checkstyle 步骤以及 `scripts/tests/sdk-java-workflow.test.js` 都需要加入新模块。 |
| B         | `runtime-broker` 内的一个包                                                                              | 不改 CI。`ContextBinding` 与它的第一个使用方放在一起。                                                                                                                           | 该模块的 README 与 QWEN.md 把它限定为 Broker 状态，并排除公共 Agent 资源。它的 README 也正在被 #12627 修改。                                                    |

两个方案中，共享 fixtures 以及规则和摘要的 TypeScript 实现都放在 `packages/cli/src/serve` 下，与现有的 Runtime 契约相邻。

## 术语

下面几个词在本仓库中已有其他含义。

| 术语                 | 本文含义                                                                                                  | 不要混淆为                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Workspace ID         | 由管理员分配的不透明值。它符合 `[A-Za-z0-9._:-]{1,128}`，在租户内唯一，按字节比较。                       | daemon 基于路径哈希的 `workspaceId`。                                                 |
| workspace generation | Registry 的替换计数器：正的 64 位整数，对同一个 Workspace ID 只增不减。在线上和摘要中用十进制字符串表示。 | Runtime 绑定的 generation、daemon 的 `generationId`，或 `workspace_generation` 能力。 |
| storage ID           | Workspace 持久文件的逻辑身份。                                                                            | 挂载路径。                                                                            |
| ContextBinding       | Session 已提交的 Workspace 上下文。                                                                       | Runtime 绑定（用于放置 Runtime）。                                                    |
| contextRevision      | Session 上下文的版本。创建时为 1，W2 会递增它。                                                           | workspace generation、配置 revision 或 activation epoch。                             |

## Workspace Registry

### 记录

Registry 记录包含以下字段。记录不可变。

| 字段                  | 规则                                          |
| --------------------- | --------------------------------------------- |
| `tenantId`            | `[A-Za-z0-9._:-]{1,128}`                      |
| `workspaceId`         | `[A-Za-z0-9._:-]{1,128}`                      |
| `workspaceGeneration` | 1 到 2^63−1 的整数                            |
| `storageId`           | 1 到 256 个可打印 ASCII 字符（0x21 到 0x7E）  |
| `displayName`         | 1 到 512 个码点，合法的 Unicode，不含控制字符 |
| `state`               | `active`、`draining` 或 `removed`             |
| `policyRef`           | 1 到 512 个可打印 ASCII 字符                  |
| `configRef`           | 1 到 512 个可打印 ASCII 字符                  |

标识符格式取自 Java SDK 中 `ManagedSessionStoreConnection` 的租户格式，这里同样用于 Workspace ID。它也是 TypeScript managed session key 稳定 ID 规则的子集，因此托管的 Workspace ID 在两处都合法。标识符只用 ASCII，也意味着计算摘要前永远不需要做 Unicode 规范化。

### 状态

| 状态       | 是否列出 | 能否用于新 Session              | 能否作为默认值 |
| ---------- | -------- | ------------------------------- | -------------- |
| `active`   | 是       | 能                              | 能             |
| `draining` | 是       | 不能（`workspace_unavailable`） | 不能           |
| `removed`  | 是       | 不能（`workspace_unavailable`） | 不能           |

已有 Session 在任何状态下都保留原有绑定。draining 或 removed 对它们意味着什么，属于 W0e 和 W1。

### 配置来源

读取接口提供三种操作：

- 按租户和 Workspace ID 查找一条记录。
- 按 Workspace ID 的字节序分页遍历一个租户的记录，这与参考 schema 的 `ascii_bin` 排序规则一致。短于上限的一页表示后面没有更多记录，并且每个实现都接受 1 到 1000 的上限。
- 返回租户配置的默认 Workspace ID。

第一个实现是由部署配置构建的不可变快照。构建时遇到以下情况会拒绝该快照：

- 同一个 `(tenantId, workspaceId)` 出现两次。
- 租户默认值指向的 Workspace 不在该租户中。
- 任何字段违反其规则。

不提供公共注册 API，也不从路径推导 Workspace ID。

嵌入方通过替换快照来应用变更。后继检查会拒绝有以下任一行为的替换：

- 删除 Workspace。Workspace 通过改为 `removed` 退役，这样钉在它上面的 Session 之后仍能得到解释。
- 降低某个 Workspace 的 generation。
- 不提升 generation 就修改它的 `storageId`。

之后可以基于参考 schema 中的 `managed_agent_workspace` 表，提供实现同一接口的 JDBC Registry。

## 访问控制

嵌入方完成 actor 认证后传入租户 ID 和 actor ID。W0a 从不从请求体读取这两者。策略针对一个 actor 和一条记录返回三种访问级别之一：

- `NONE`
- `READ`
- `CREATE`，隐含 `READ`

查找始终限定在 actor 所属的租户内。无论策略怎么说，另一个租户的 Workspace 都与不存在的 Workspace 无法区分。每次调用都重新评估策略，从不把结果固化进分页或解析结果。W0a 为测试和单租户部署提供一个显式授权的策略；没有“全部放行”的默认策略。

列表返回 actor 能读取的记录，每条带 `canCreateSession`。这个字段只是权限提示；状态单独给出，由调用方把两者结合起来。记录按 Workspace ID 排序，并附带 `hasMore` 和 `defaultWorkspace`。默认项独立于当前页计算，只有租户默认值存在、处于 `active`、且 actor 拥有 `CREATE` 时才返回。分页基于上一页最后一个 Workspace ID。catalog 无论页面大小如何，都按 1000 条一批读取 Registry，因此 actor 无权读取的记录只会带来很少的往返。与租户、actor 和查询绑定的不透明游标属于 API 层。

## 工作目录规则

`cwdRelative` 是一个字符串。API 层把缺省的字段转换为 `.`，并拒绝 `null`。违反以下任一条都返回 `invalid_cwd`。

1. 必须是合法的 Unicode，不含未配对的代理项。
2. 长度必须为 1 到 1024 个码点，与 JSON Schema 的计数方式一致。空字符串非法；它不等于 `.`。
3. 不得包含控制字符，即 Unicode Cc 类：C0（含 NUL）、DEL 和 C1。参考契约只列出 NUL；见[待决问题](#待决问题)。
4. 不得包含反斜杠。
5. 不得以 `/` 开头。
6. 下文所述的规范化结果不得以盘符前缀开头：一个 ASCII 字母后跟 `:`。检查规范化结果，也会拒绝 `./C:x` 这样的写法。
7. 按 `/` 切分后，任何段都不能恰好是 `..`。

随后的规范化会去掉空段（来自重复或结尾的 `/`）和 `.` 段，再用 `/` 连接其余部分。如果什么都不剩，结果为 `.`。其他一概不改：保留空格、大小写和非 ASCII 字符，不做 Unicode 规范化，也不做百分号解码。ContextBinding 携带规范化后的值，W0b 对它计算摘要。

| 输入                 | 结果           |
| -------------------- | -------------- |
| `.` 或 `./` 或 `./.` | `.`            |
| `services//api/`     | `services/api` |
| `./services/./api`   | `services/api` |
| `a/ b /c`            | `a/ b /c`      |
| 空字符串             | `invalid_cwd`  |
| `..` 或 `a/../b`     | `invalid_cwd`  |
| `/srv/a`             | `invalid_cwd`  |
| `C:x` 或 `./C:x`     | `invalid_cwd`  |
| `a\b`                | `invalid_cwd`  |

该规则只做词法检查。它不模拟 Windows 的名称别名，例如末尾的点或 8.3 短名。在任何工具运行之前，Runtime 仍须核验目录存在、realpath 包含关系、符号链接和挂载身份，并在工具边界处复查（W0c）。工作目录只是工具的起始位置，不是安全边界。

## 选择解析

选择要么缺省，要么是显式的：带一个 Workspace ID 和一个 `cwdRelative`（调用方没写时为 `.`）。API 层在解析之前就拒绝 `null` 和 `{}`。

解析按以下顺序检查，遇到第一个失败即停止。Java API 在构建显式选择时就执行第 1 步，因此无效目录会在任何查找之前失败。

| 步骤                         | 显式选择                                                     | 缺省选择                                |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| 1. 规范化 `cwdRelative`      | `invalid_cwd`                                                | —（始终为 `.`）                         |
| 2. 确定目标                  | 它的 Workspace ID                                            | 租户默认值；没有则 `workspace_required` |
| 3. 在 actor 的租户中查找目标 | 不存在：`workspace_not_found`                                | 不存在：`workspace_required`            |
| 4. 检查访问权限              | `NONE`：`workspace_not_found`；`READ`：`workspace_forbidden` | 不是 `CREATE`：`workspace_required`     |
| 5. 检查状态                  | 不是 `active`：`workspace_unavailable`                       | 不是 `active`：`workspace_required`     |

成功时结果包含：

- 租户 ID、Workspace ID、workspace generation 和 storage ID；
- 记录的 `configRef` 和 `policyRef`；
- 规范化后的 `cwdRelative`；
- 是否使用了租户默认值。

语法检查放在最前，因为它不需要查找，也不泄露任何信息。缺省选择永远不会得到 404、403 或 409：不可用的默认值等同于没有默认值。显式选择永远不会回退到默认值。

解析器是无状态的。W0b 只在首次准入时调用它，并把结果与创建回执原子地持久化。重试必须先找到原始回执，不得再次调用解析器，否则变更后的默认值会让重试改绑。对于请求摘要，选择会给出一个固定的缺省标记，或者 Workspace ID 加规范化后的 `cwdRelative`。W0b 用下文的编码把它们并入自己的摘要。

## ContextBinding 与摘要

ContextBinding 有七个必需字段，校验规则与 Registry 记录相同：

- `tenantId`：`[A-Za-z0-9._:-]{1,128}`
- `workspaceId`：`[A-Za-z0-9._:-]{1,128}`
- `workspaceGeneration`：1 到 2^63−1
- `storageId`：1 到 256 个可打印 ASCII 字符
- `cwdRelative`：已是规范化形式
- `contextConfigRef`：1 到 512 个可打印 ASCII 字符
- `contextRevision`：1 到 2^63−1

`contextConfigRef` 指向 W0b 在准入时根据 Registry 的 `configRef` 和 `policyRef` 记录下来的冻结配置描述。W0a 只检查它的格式，其余一概当作不透明值。`contextDigest` 不由任何一方提供，始终是推导出来的。从文本读取这两个整数的解码器，必须像 TypeScript 实现那样，只接受 ASCII 形式的 `[1-9][0-9]*`，且数值不超过 2^63−1。只用 `Long.parseLong` 不够：它还会接受符号、前导零和非 ASCII 数字。

`contextDigest` 由 `sha256:` 加上一个字节序列的 SHA-256 小写十六进制构成。该字节序列按顺序拼接下列各项，每一项都是一个 4 字节大端长度，后跟相应数量的 UTF-8 字节。

1. 域标签 `qwen-managed-context-binding-v1`
2. `tenantId`
3. `workspaceId`
4. `workspaceGeneration`，写成不带符号、没有前导零的十进制字符串
5. `storageId`
6. `cwdRelative`
7. `contextConfigRef`
8. `contextRevision`，写成不带符号、没有前导零的十进制字符串

采用这种编码的原因：

- 长度前缀让字段边界对任何 Unicode 目录名都没有歧义。
- 没有 JSON 转义或数字格式问题，fastjson2 与 `JSON.stringify` 之间也就无从分歧。
- Broker 的 repository 键已经用同样的构造，在 TypeScript 中实现也只需几行。
- generation 和 revision 使用十进制字符串，JavaScript 使用方就不会把 64 位值经过 `Number` 处理。
- `sha256:` 前缀与私有 Runtime 协议中的 `capabilityDigest` 一致。session record 的 `DurableRef` 摘要是不带前缀的十六进制；之后在 session journal 中引用时必须显式转换。

摘要只覆盖 Session 的上下文。Runtime 绑定的 ID 和 generation，以及 Harness owner generation，在执行时由 W0c 的调用封装绑定。`displayName` 不影响执行。`policyRef` 通过 `contextConfigRef` 进入执行。

两种语言共同消费 `packages/cli/src/serve/contracts/managed-workspace-binding-v1.fixtures.json` 中的共享 fixtures，并用旁边的 schema 文件校验。该文件有两组用例：

- **路径：** 一个输入，以及规范化结果或 `invalid_cwd`。
- **绑定：** 各字段，以及编码后字节的十六进制加 `contextDigest`，或者一个拒绝结果。

用例覆盖每条规则边界的两侧，包括非 ASCII 名称、仅由空格组成的段，以及大于 2^53 的 generation。期望值由一个独立于两种语言的实现计算得出。

## 启动信封

启动信封是一个单独的切片（W0a-2），等待 #12380 中的答复。本切片先固定信封将要携带的内容：ContextBinding 的字段、它们的规范化方式和摘要。W0a-2 随后需要完成以下工作：

- 协商 `managed-context/1`。
- 新增一个 boot 文档版本，携带 ContextBinding 以及计算挂载根和实际 cwd 所需的输入。daemon 式的路径哈希只作为兼容别名保留。
- 新增一个 attestation 身份版本，让 W0c 复用现有 gate，而不是另造一套 Workspace attestation。
- 同时修改以下各处：TypeScript 键列表、schema、fixtures、Java 的字段集断言，以及假 worker `fake-attestation-worker.mjs`。这个假 worker 目前不校验封闭键集，所以字段对不上时 Java 测试发现不了。

该切片或 W0c 还必须决定哪些字段进入 Runtime 放置范围。按 Workspace 隔离的 Runtime 由 `cwdRelative` 各不相同的多个 Session 共享。因此 `cwdRelative` 和 `contextRevision` 不能进入 `RuntimeScope` 的放置身份；加入它们会改变 Broker 的 request key 和 scope key，使 Runtime 无法复用。它们应改为按 Session、按调用绑定。

## 错误

| 错误码                  | HTTP | 何时出现                                                         |
| ----------------------- | ---- | ---------------------------------------------------------------- |
| `workspace_required`    | 400  | 选择缺省，且没有可用的租户默认值。                               |
| `invalid_cwd`           | 400  | `cwdRelative` 违反工作目录规则。                                 |
| `workspace_not_found`   | 404  | 显式指定的 Workspace 不存在、属于另一个租户，或 actor 无权读取。 |
| `workspace_forbidden`   | 403  | actor 能读取显式指定的 Workspace，但没有 `CREATE`。              |
| `workspace_unavailable` | 409  | 显式指定的 Workspace 处于 `draining` 或 `removed`。              |

这些错误原样重试都不会成功。W0a 用一个同时携带错误码和 HTTP 状态的异常类型抛出它们，与 `RuntimeBrokerException` 的做法一致。API 层负责把它们映射到自己的错误结构。`unsupported_feature`、`workspace_generation_conflict` 和 `context_revision_conflict` 属于后续切片。

## 安全与租户隔离

- 租户和 actor 只来自嵌入方的认证。
- 错误码不区分另一个租户的 Workspace、无权读取的 Workspace 和不存在的 Workspace。
- workspace generation、storage ID 和配置引用只来自 Registry。调用方最多提供一个 Workspace ID 和一个相对目录。不接受调用方提供的绝对路径、挂载点、storage ID 或 generation，它们也不会出现在错误或列表项中。
- 解析从不回退。显式选择不会得到默认值，缺省选择也不会得到启动时的 cwd 或 daemon 的主 Workspace。
- 每次调用都重新评估访问权限。任何结果都不携带超出本次调用的授权。
- 工作目录规则只做词法检查。Runtime 仍会在安装时和工具边界处强制检查包含关系、realpath 和符号链接安全。

## 涉及文件

方案 A 的实现如下。

- `packages/sdk-java/managed-workspace/`（新增）：
  - Registry 的记录与状态、Registry 接口，以及配置快照及其后继检查。
  - actor、访问级别与策略，以及显式授权策略。
  - 负责列表与解析的 catalog。
  - 选择与已解析的 Workspace、工作目录规则、`ContextBinding`，以及异常类型。
  - 测试，包括 fixtures 的消费方。另有 README 和 QWEN.md。
- `packages/cli/src/serve/contracts/managed-workspace-binding-v1.fixtures.json` 与 `.schema.json`（新增）。
- `packages/cli/src/serve/managed-workspace-binding.ts` 及其测试（新增）。这是工作目录规则和摘要的 TypeScript 实现，暂不接入 worker。
- `.github/workflows/sdk-java.yml` 与 `scripts/tests/sdk-java-workflow.test.js`：在 Java 21 任务中运行新模块。
- 本设计文档的中英文两个版本。

`runtime-broker`、daemon 的 `WorkspaceRegistry`、worker 的 boot 文档和 attestation 契约都不变。

## 验证计划

- **Java 单元测试：**
  - 记录与快照的校验，以及后继检查。
  - 显式授权策略。
  - 列表：过滤、排序、分页，以及不在当前页的默认项。
  - 解析表的每一行，显式和缺省两种选择都要覆盖。
  - 工作目录规则，以及 ContextBinding 的校验与摘要。
- **Fixtures 消费方：** Java 与 TypeScript 都运行全部路径用例和绑定用例。TypeScript 用严格模式的 Ajv 按 schema 校验 fixtures 文件。
- **变异检查：** 逐一回退每道守卫，确认有测试失败。
- **命令：** 在 JDK 21 上运行 `mvn test` 和 `mvn checkstyle:check`；运行 `npm run build && npm run typecheck`；运行相关的 Vitest 用例。
- **CI：** 新模块在 Linux、macOS 和 Windows 的 Java 21 任务中运行。

## 验收标准

- 对每一个 fixture，Java 与 TypeScript 得出相同的规范化路径和 `contextDigest`。这包括非 ASCII 名称、仅由空格组成的段，以及大于 2^53 的 generation。
- 缺省选择只会解析到一个处于 active、且 actor 可以在其中创建 Session 的租户默认值。其余所有缺省情况都是 `workspace_required`。
- 显式选择永远不回退到默认值。
- 另一个租户的 Workspace 和无权读取的 Workspace 得到同样的 `workspace_not_found`。
- 调用方提供的绝对路径、storage ID 或 generation 都无法进入已解析的 Workspace 或 ContextBinding。
- 替换快照不能删除 Workspace、降低它的 generation，也不能在不提升 generation 的情况下修改它的 storage ID。
- Java 模块不依赖 Spring、CLI 内部实现、`runtime-broker` 或调度器。
- 文档不声称已实现持久化、接线或能力声明。

## 待决问题

1. 模块位置选方案 A 还是 B。已在 #12380 中提问。
2. 启动信封是等 worker 处理器切片（F1-b）落地，还是现在就商定它的形状。已在 #12380 中提问。
3. `cwdRelative` 应按现有实现拒绝所有控制字符（C0、DEL 和 C1），还是按参考契约只拒绝 NUL？目录名中的换行或转义序列会进入日志、UI 和 shell 提示符。
4. `removed` 的 Workspace 是否应出现在列表中，还是只出现在 Session 视图中？

## 后续工作

| 切片  | 范围                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| W0a-2 | 带版本的启动信封与 attestation 身份。                                                                                              |
| W0b   | Session 绑定与创建回执的原子提交、按原始幂等键恢复，以及明确标记为未绑定的旧 Session。                                             |
| W0c   | 通过 `HarnessSessionResolver` 按 Session 解析 Broker、存储到挂载点的解析器、worker 的安装与 attestation，以及 Workspace 轮次租约。 |
| W0d   | WebShell 的 Workspace 选择、相对目录输入，以及默认与空状态。                                                                       |
| W0e   | 恢复与上线。                                                                                                                       |

Stage D 根据评审过的 OpenAPI 生成公共和 BFF DTO。等控制面开始持久化 Workspace 时，再实现 JDBC Registry。
