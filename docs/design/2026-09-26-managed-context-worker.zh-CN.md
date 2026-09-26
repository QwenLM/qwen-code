# Managed Context Worker（W0c-1）

[English](2026-09-26-managed-context-worker.md) | [简体中文](2026-09-26-managed-context-worker.zh-CN.md)

状态：已在 worker 中实现，Broker（W0c-2）和控制面（W0c-3）尚未使用。更新：2026-09-26。本文是 Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 中 W0c（执行目录）的第一个切片，在 [#12724](https://github.com/QwenLM/qwen-code/issues/12724) 跟踪。它在 [Workspace 绑定契约](2026-09-25-managed-workspace-binding-contract.zh-CN.md)（W0a）之上，实现 [Managed Context Envelope](2026-09-25-managed-context-envelope.zh-CN.md)（W0a-2）的 worker 一侧。下文的“envelope”指该设计，“参考设计”指该提案的 [Workspace 与 Session cwd 设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-context.md)。

## 问题

envelope 定义了 boot v2、ready v2、attestation v3 和上下文安装，但没有 worker 提供它们。worker 仍然让每个 Session 的每次工具调用都在 boot v1 指定的那一个目录中运行。于是 Broker 无处提供 `managed-context/1`，Session 也无法在其 Workspace 绑定指定的目录中运行工具。

## 现状

以下事实取自 `main` 的 `16496a71ec`。

- **Boot。** worker 从标准输入读取一个 boot 文档：最多 32 KiB，30 秒内关闭。它只接受 boot v1 的 14 个键。文档无效时，它在写出 ready 行之前以状态 1 退出。
- **路由。** 它提供 attestation v2 以及 Tool v2 的 `execute`、`status`、`cancel` 路由。一道原始 gate 只放行这四条路由，对它收到的其他任何请求都返回空的 404。
- **工具。** 一个工具执行器为所有 Session 运行 `read_file`、`write_file`、`edit` 和前台 `run_shell_command`。它们的配置以 `workspaceCwd` 为根，所以每次调用都从这里开始。一份以调用的 `callId` 为键的内存日志，在进程的整个生命周期内保留每次调用。
- **Envelope。** `managed-context-envelope.ts` 校验 boot v2、ready v2、attestation v3 和安装请求，并保证安装幂等。只有它的测试引用它。它的安装检查止于第 6 步（目录验证）之前。
- **假 worker。** Java provisioner 测试启动的 `fake-attestation-worker.mjs` 只解析 boot 文档而不检查它，并且只提供 v1。

## 目标

- 接受 boot v2 并以 ready v2 应答；在 ready 行之前拒绝其他任何文档。
- 在 boot v2 下提供 attestation v3 和上下文安装，对 attestation v2 返回 404。
- 实现安装的第 6 步：验证实际目录；验证不通过则返回 409 `managed_context_unavailable`，不记录任何东西。
- 在 boot v2 下，新的工具调用只为已安装上下文的 Session 运行，在该上下文的实际目录中运行，并且每次调用都重新验证。
- 让假 worker 支持两个封闭的 boot 键集合和 v2 的应答，供 W0c-2 的 Broker 工作使用。
- 回答 envelope 中需要由 worker 回答的待决问题。
- boot v1 的行为保持不变。

## 非目标

- **Broker。** provisioner 仍然写 boot v1。v3 客户端、重试上限和更严格的标识符检查属于 W0c-2。
- **控制面。** `managed-agent-server` 中的 Session 和存储解析，以及 Workspace 轮次租约，属于 W0c-3。
- **配置安装。** worker 检查 `contextConfigRef` 并把它计入摘要，但不据此安装任何配置。
- **修改已安装的上下文**，这需要 W2 的目录变更协议。
- **沙箱。** 实际目录是工具的起始位置。按 Tool v2 契约的要求，限制工具路径仍由 Harness 负责。

## 设计

### Boot 与就绪

worker 照旧读取 boot 文档。它只接受两种文档：与 boot v1 完全一致的文档（v1 不变），或符合 envelope 中 boot v2 规则的文档。boot v2 文档还必须是合法的 UTF-8：非法字节会被拒绝，而 boot v1 仍照旧替换它们。其他文档会让它在写标准输出之前以状态 1 退出。标准错误中是一条固定消息和调用栈，从不包含文档本身。worker 不写拒绝记录（见 [envelope 的待决问题](#envelope-的待决问题)）。

在 boot v2 下，ready 行是 ready v2，由 boot 文档和监听端口构造。与 v1 一样，它不含 token。

### 路由

| 路由                                                  | Boot v1     | Boot v2                        |
| ----------------------------------------------------- | ----------- | ------------------------------ |
| `POST /internal/managed-runtime/v2/attest`            | attestation | 404                            |
| `POST /internal/managed-runtime/v3/attest`            | 404         | attestation v3                 |
| `POST /internal/managed-runtime/v3/context`           | 404         | 上下文安装                     |
| `POST /internal/managed-runtime/v2/execute`           | Tool v2     | Tool v2，需通过下文的激活 gate |
| `POST /internal/managed-runtime/v2/status`、`/cancel` | Tool v2     | Tool v2                        |

原始 gate 只放行当前 boot 版本的路由。这样一个 Runtime 永远不会呈现两种身份；对端在 v3 路由上收到 404，就知道这个 worker 不兼容。v3 路由沿用自有路由的约束：bearer token、`Cache-Control: no-store`、租约请求头，以及不压缩、最多 16 KiB 的 JSON 请求体。它们也使用相同的错误码。

Attestation v3 就是 envelope 的检查。它把请求与 boot 文档比较，从不访问文件系统。

### 上下文安装

处理器按 envelope 的顺序执行各步。第 1 到第 5 步从不访问文件系统。一个请求通过这些步骤、又不是重复已记录的安装时，进入第 6 步，验证实际目录：

1. **挂载根目录。** `mountRoot` 必须是本机上的绝对路径：在 Windows 上是盘符路径或 UNC 路径，在其他平台上以 `/` 开头。boot 规则也接受另一平台的写法，这类写法否则会相对于 worker 的工作目录解析。worker 把根目录解析为真实路径。根目录本身可以经由符号链接到达，因为那是 Broker 配置的。
2. **挂载身份。** 第一次验证成功时，worker 固定 `stat` 报告的根目录设备号和 inode，在 Runtime 的整个生命周期内有效。此后每次验证都要求这两个值不变。这能拒绝卸载后露出下层目录的根目录、重新挂载到另一个设备节点上的卷，以及被另一个 inode 不同的目录替换的根目录。它并不能发现所有情况。在 APFS 和 ext4 上，每个卷的根目录 inode 都相同，释放的设备节点也会被复用，所以挂到原位置的另一个卷可能两个值都不变。有些文件系统还会立即复用释放的 inode，所以原地删除又重建的根目录也可能保持这两个值。worker 分辨不出一个路径背后是哪份存储：改动挂载的一方必须替换 Runtime。根目录以下的目录在每次调用时仍会被验证。
3. **实际目录。** 实际目录是真实根目录拼接上 `cwdRelative` 的各段；按 W0a 的规范形式，根目录写作 `.`，其他情况下没有 `.` 或 `..` 段。实际目录的真实路径必须与这个路径完全相同。因此根目录以下的任何一段都不能是符号链接，无论它指向 Workspace 内还是 Workspace 外。在真实路径按存储的形式报告名字的平台上，例如 macOS 和 Windows，大小写与磁盘不同的段也会被拒绝；在 macOS 上，Unicode 规范化形式不同的名字同样会被拒绝。在真实路径照搬所请求名字的文件系统上，例如 Linux 上不区分大小写的卷，这样的段指向同一个目录，会被接受。
4. **访问权限。** 实际目录必须是 worker 可以读取和进入的目录。在 Windows 上，这项检查看不到访问控制列表，因此只能确认目录存在。

任何一项检查失败，都返回 409 `managed_context_unavailable`，不记录任何东西，所以修复之后同一个请求会成功。重复的安装直接返回原来的回执，不重新验证。

拒绝所有链接，能让起始目录始终等于绑定所指定的路径。Workspace 内的链接随时可能被该 Workspace 自己的工具改指向别处，因此有的调用会跟随它，有的不会。

验证是异步的，所以两个安装可能同时处于验证中。验证完成后，无论通过与否，worker 都会在答复之前再检查一次第 4、5 步。因此并发请求得到的答复，与它们先后到达时得到的一样：先记录者获胜；重复的请求拿到原来的回执，即使它自己的验证在此期间失败了；冲突的安装被拒绝。唯一的例外是根目录：如果在最初的几次验证进行期间根目录发生变化，最先通过验证的会固定它看到的根目录。看到另一个根目录的验证会被拒绝，即使它更早看到自己的根目录。根目录一旦变化，本来就需要新的 Runtime（第 2 步）。

### 激活 gate

在 boot v2 下，新的 `execute` 调用在被日志记录之前要先通过一道 gate：

- 它的 `sessionId` 必须已经安装了上下文，否则返回 409 `managed_context_unavailable`。
- 该 Session 的实际目录会用第 6 步的检查和已固定的根目录再验证一次。验证失败，返回 409 `managed_context_unavailable`。
- 然后调用在该目录中运行。它的工具使用 gate 之后立即为该调用构造的配置，其工作目录和 workspace 都是实际目录，因此工具看到的目录状态绝不会早于该调用自己的验证。

请求形状和工具名照旧在 gate 之前检查。被拒绝的调用不进入日志，所以 `status` 对它回答 `unknown`，修复之后重试会运行它。已进入日志的调用，由日志合并或直接应答，不经过 gate，所以目录消失之后，已结算的结果仍然可读。同时处于 gate 中的相同调用只记录一次：其中一个先进入日志后，其余的都合并到它，不管它们自己的 gate 结果如何。`status` 和 `cancel` 从不经过 gate，因为它们只读取或取消已记录的调用。

新调用还在 gate 中时到达的 `status` 或 `cancel` 会回答 `unknown`，就像调用尚未到达时一样；除非 gate 拒绝，该调用随后照常运行。同样，关闭 worker 会中止正在运行的调用，但不会中止还在 gate 中的调用。

每次调用都以其 Session 的身份运行。它的 shell 看到的 `QWEN_CODE_SESSION_ID`，是由 Runtime 实例 ID 和 Runtime Session ID 的哈希派生出的键（Runtime Session ID 可能包含在文件名中不安全的字符）；`QWEN_CODE_PROJECT_DIR` 是该 Session 实际目录对应的项目目录。core 由路径推导出这个目录：先把路径转成小写（仅在 Windows 上），再把 ASCII 字母和数字以外的每个 UTF-16 码元都替换成 `-`，所以基本多文种平面以外的字符（如 emoji）会变成 `--`。两个目录的路径经过这样处理后相同，就会共用同一个。在 boot v1 下两者保持原值：Runtime 实例 ID，以及 `workspaceCwd` 对应的项目目录。

目录在调用进入日志时就已固定。Shell 工具会用它的 workspace 检查 `directory` 参数，而现在这个 workspace 就是实际目录，所以 `directory` 位于其外的调用会以错误结算，不会运行。这是工具自己在调用开始时做的检查，与工具输入中的任何路径一样，它不是边界（见[安全](#安全)）：命令仍然可以切换目录。

gate 与工具启动不是原子的。两者之间被替换的目录，要到下一次调用才会被发现。这可以接受，因为实际目录只是起始位置，不是沙箱（见[安全](#安全)）。

在 boot v1 下没有 gate，每次调用照旧在 `workspaceCwd` 中运行。

### 保留规则

与工具日志一样，Runtime 在其整个生命周期内保留自己的安装记录。不做任何淘汰，所以第 5 步始终保护着存活的 Session，以其他值复用的 `operationId` 也总会被拒绝。Broker 回收 Runtime 时就限定了这个生命周期。每条记录只包含有上限的字段，至多几 KB。工具配置不会保留：每次调用各自构造，而且在其 Session 的上下文中构造，所以 core 不会为调试日志保留它；对于能被 JSON 文本完整描述、且首次编译即成功的参数 schema，core 只编译一次，因此重复构造不会增加编译出的校验器。每个 Session 还在其键下保留三条小记录，与其安装记录一样保留到 Runtime 结束：它的项目目录，以及 core 记录的它的模型和模型标识。要更早释放一个 Session 的记录，需要一个表示该 Session 已结束的信号。Broker 的 `release` 会话动词就是这个信号，但它目前还没有 worker 路由。

### 错误

envelope 的错误表没有新增错误码或状态码；其中 `managed_context_unavailable` 一行现在也涵盖 `execute`。在 boot v2 下，`execute` 可能返回 409 `managed_context_unavailable`，响应体照常是 `code` 和 `error`。Tool v2 的形状不变，以 v1 启动的 worker 从不返回这个错误码。W0c-2 的客户端按 envelope 的要求对它分类：保持该 Session 的工具 gate 关闭，把它的上下文标记为 `recovery_blocked`，不回退到任何其他目录。

### 假 worker

假 worker 只接受键集合恰好是 boot v1 或 boot v2 的文档，并且版本号要对应，v2 还要带协议标记。除了 `type`、版本号和 v2 的协议标记，它不检查其他值。其他文档会让它在 ready 行之前退出，且不回显文档。因此写 boot v1 的 provisioner 测试，现在会在 provisioner 多写或少写一个键时失败。在 boot v2 下，假 worker 的应答是：

- ready v2；
- 由其 boot 文档构造的 attestation v3；
- 把安装请求原样回显为回执，不做任何检查；无法读取的请求体返回 400；
- 对 attestation v2 返回 404。

一个 Java 测试把这些应答固定到共享 fixtures 上，并检查假 worker 会拒绝两个键集合之外的文档。

## envelope 的待决问题

envelope 把四个问题留给了 W0c。worker 的回答如下：

1. **拒绝记录。** worker 不写。只实现 v1 的 worker 写不出这样的记录，所以 Broker 永远无法依赖它。取而代之的是 W0c-2 为 boot v2 设置重试上限，并且绝不以 v1 重试。
2. **配置安装。** 仍待决。本切片不安装任何配置，这条路由保持 v3 的形状。由安装请求携带配置，还是交给这条路由的后续版本，尚未决定。
3. **`cwdRelative` 中的控制字符。** worker 原样沿用 W0a 的规则，即拒绝所有 Cc 字符。如果 W0a 放宽规则，worker 随之调整。
4. **保留规则。** 如上所述，为 Runtime 的生命周期。更早释放记录要等会话动词。

## 安全

- bearer token 只出现在标准输入和请求头中，不会出现在任何响应、错误或日志行中。
- 错误从不包含 `mountRoot` 或实际目录。只有 attestation v3 按契约要求回显 `mountRoot`。
- 验证不跟随根目录以下的任何符号链接，因此 Workspace 中的链接无法改变 Session 的实际目录，无论是改到 Workspace 内还是 Workspace 外。
- 实际目录是工具的起始位置，不是沙箱。工具输入中的绝对路径，仍然能到达 worker 所属用户能到达的任何地方。按 Tool v2 契约的要求，由 Harness 在准入调用时决定 Workspace 边界。

## 涉及文件

- `packages/cli/src/serve/managed-context-worker.ts`（新增）：boot v2 路由、挂载验证和激活 gate。它的测试（新增）在真实 HTTP 上重放共享 fixtures，并在真实文件系统上运行。
- `packages/cli/src/serve/managed-context-envelope.ts`：安装接受第 6 步的验证，并提供 Session 已安装的绑定。
- `packages/cli/src/serve/managed-runtime-attestation-worker.ts`：按 boot 版本分派、各版本的路由，以及 ready v2。
- `packages/cli/src/serve/managed-runtime-tool-executor.ts`：工具来自一个在每个新调用进入日志之前询问的解析器。boot v1 在启动时构造一次；boot v2 为每次调用构造。每次调用以其会话的身份运行，该会话的项目目录已为其 shell 注册。
- `packages/cli/src/serve/managed-runtime-tool-routes.ts` 和 `managed-runtime-attestation-contract.ts`：目录不可用时的 409、按 boot 版本参数化的路由 gate，以及所有自有路由共用的一个 JSON 请求体解析器。
- `packages/core/src/utils/schemaValidator.ts`：能被 JSON 文本完整描述、且首次编译即成功的参数 schema，在每个校验器上只编译一次，以该文本为键；因此带 `$id` 的 schema 被重新构造成新对象后，首次使用时就会被校验，而以前 Ajv 会把这次编译当作 `$id` 重复而拒绝，并跳过校验。文本能否完整描述一个 schema，是按它的数据判断的，所以 Proxy 或 getter 以文本记录下的值为准。其他 schema 照 Ajv 一贯的方式编译，得到的结果和日志中记录的编译错误都与以前相同。对任何 schema 而言，通过 Ajv 中其他 schema 的注册表来解析的引用，都可能解析得与以前不同：重新构造的 schema 对象不再被编译，也就不再刷新这个注册表。
- 假 worker 及其 Java 测试、它与 `LocalProcessRuntimeProvisionerTest` 共用的一个辅助方法，以及 attestation worker、tool worker、envelope 和 schema 校验器的测试。
- `packages/cli/src/serve/managed-workspace-binding.ts`：仅修改其头部注释。
- 本文的中英文两版；envelope 文档中的状态、错误、待决问题和后续工作；W0a 文档的状态和关于接线的那句话；以及 Tool v2 契约文档的 worker 一节和错误类别中指向本文的说明。

## 验证

- **在真实 HTTP 上重放共享 fixtures：**
  - 每个 boot 用例都经过 worker 的标准输入读取器。
  - 每个 attestation 用例都发给以 fixtures 的 boot 文档启动的 worker。
  - 每个安装序列都发给一个新的 worker，其挂载根目录是一个临时目录，里面有 fixtures 要安装的那些目录。
- **在真实文件系统上检查目录：**
  - 不存在的目录、文件，以及指向 Workspace 内外的链接；
  - 不存在、是文件、经由链接到达、或采用另一平台写法（且从不被解析）的挂载根目录；
  - 被另一个目录替换的根目录，以及只有大小写不同的名字（以当前文件系统的报告为准）；
  - 访问权限检查失败（通过模拟实现，因此与运行用户无关），以及不可读的目录（非 root 运行时）。
- **并发：** 同时验证的相同安装和冲突安装，包括原安装记录之后、自身验证才失败的重复安装。
- **激活 gate：**
  - 没有上下文的调用，以及位于三个不同目录的 Session；
  - 在 Session 目录中执行 Read、Write 和 Edit，以及取消一个正在运行的调用；
  - 每个 Session 的 shell 看到的会话和项目目录；
  - 先前的调用用过之后，又变成指向 Workspace 外的链接的 Shell `directory`；
  - 安装后被删除或变成链接的目录；
  - 同时处于 gate 中的相同调用，包括另一个已进入日志之后、自身才被 gate 拒绝的调用。
- **Boot v1：** workspace 仍在启动时确定；shell 仍看到 Runtime 的会话和项目目录；字节不是合法 UTF-8 的文档仍会被读取；现有的 tool worker 测试原样通过。
- **Boot v2 编码：** 字节不是合法 UTF-8 的文档会被拒绝。
- **Core：**
  - 能被 JSON 文本完整描述、且首次编译即成功的相同参数 schema 只编译一次，包括含有 `-0` 的 schema：它们的文本把 `-0` 写成 `0`，而 Ajv 对两者的校验相同，所以带 `$id` 的重新构造对象同样会被校验；
  - 同一个 schema 对象从不会被再次序列化，即使 JSON 文本不能完整描述它、它首次编译失败，或者它从不能编译；
  - JSON 文本不能完整描述的 schema（例如含有数组子类、带命名属性的数组或无原型对象的 schema），由对象本身编译，而不是由它的文本编译；
  - 这样的 schema 得到的结果与以前相同；编译失败的 schema 也是如此，即使带有 `$id`，即使该 `$id` 已被另一个 schema 占用；
  - 编译失败的 schema 在日志中记录它自己的编译错误，即使它的副本先占用了它的 `$id`；
  - 编译失败的 schema，无论被重新构造多少次，都只由它的文本编译一次；每个重新构造的对象与以前一样，在第二次使用时编译；
  - 调用方修改自己的 schema 对象，不会改变其他 schema 的校验器；
  - 重新构造的带 `$id` 的 schema 会被校验。
- **进程级：** 隐藏的 CLI 命令能以 boot v2 启动并应答 attestation v3，遇到被拒绝的文档时在 ready 行之前退出。
- **Java：** 假 worker 的 v2 应答；它对在可接受文档上只改一处的文档的拒绝，包括合并的键、`type` 和不是 JSON 的输入，且标准错误中不含 token；以及与它共用一个辅助方法的 provisioner 测试。

## 验收标准

- 对共享 fixtures 中的每个 boot、attestation 和安装用例，worker 都在真实 HTTP 上给出预期的答复，其中 boot 用例经标准输入读取。
- 不存在、不是目录、不可读、是链接或越出 Workspace 的实际目录，以及 `stat` 报告的设备号或 inode 与第一次成功验证时不同的挂载根目录，都以 409 `managed_context_unavailable` 被拒绝，拒绝不记录任何东西。
- Session 没有已安装上下文、或其目录已无法验证时，工具调用绝不运行，也绝不改用其他目录。
- 实际目录不同的 Session，各自在自己的目录中运行工具。每个 Session 的 shell 看到的是自己的会话键，以及 core 由其实际目录推导出的项目目录。
- 字节不是合法 UTF-8 的 boot v2 文档会被拒绝。
- boot v1 及其路由的行为保持不变。

## 后续工作

| 切片     | 范围                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W0c-2    | provisioner 写出 boot v2 并校验 ready v2；v3 attestation 客户端和安装客户端；不降级，并为 boot v2 设置重试上限；把标识符和 Session ID 的检查收紧到 envelope 的规则；测试 Broker 的 JSON 写入器不转义非 ASCII 字符；处理安装和 `execute` 返回的 `managed_context_unavailable`。 |
| W0c-3    | 在 `managed-agent-server` 中以 Session 和存储解析器取代启动时的单一目录，并为共享 Workspace 使用 Workspace 轮次租约。                                                                                                                                                          |
| 会话动词 | 为 `release` 提供 worker 路由，释放被释放 Session 的安装记录。                                                                                                                                                                                                                 |
| 配置     | 根据 `contextConfigRef` 安装配置，由安装请求携带，或交给这条路由的后续版本（待决问题 2）。                                                                                                                                                                                     |
