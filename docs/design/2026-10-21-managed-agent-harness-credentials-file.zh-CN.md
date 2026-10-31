# Managed Agent Harness 凭据文件

[English](2026-10-21-managed-agent-harness-credentials-file.md) | [简体中文](2026-10-21-managed-agent-harness-credentials-file.zh-CN.md)

状态：已提出，并在同一变更中实现。

## 问题

Hosted Harness 和 Java 控制面必须共享同一个 bearer token 和同一个 capability digest。Harness 以 `QWEN_SERVER_TOKEN` 和 `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` 读取它们，控制面则以 `QWEN_MANAGED_AGENT_HARNESS_TOKEN` 和 `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST` 读取。因此参考发行包把每个值存了两份，分别在 `harness.env` 和 `server.env` 里，每次轮换或手工修改都必须同样地改两个文件。不一致只会在 Harness 返回 `401`、或第一个 Session 时 digest 被拒绝时才暴露。

如果让控制面从自身环境读取 Harness 的变量名（例如把 `harness.env` 也加载进控制面的 unit），确实能消除重复，但会把 `QWEN_SERVER_TOKEN` 放进 Java 进程环境。这个环境所到之处的每个进程，都会收到一个被 `qwen serve` 当作自身 bearer token 的变量。

## 目标

- 用一个文件为两个进程保存 Harness token 和 capability digest。
- 这些值进入控制面的配置，但不进入其进程环境。
- 不一致或不完整的配置在接收流量前失败，并给出文件和缺失的键。
- 随包模板、bootstrap 和 systemd 说明都使用这一个文件。

## 非目标

- 改变 Harness 读取凭据的方式，或为 CLI 增加文件选项。
- 共享 Runtime Broker token。[Hosted Harness Broker 环境变量设计](2026-10-21-hosted-harness-broker-environment.zh-CN.md) 在本文件的基础上实现了这一点。
- 删除现有的直接配置项；它们单独使用时仍然有效。

## 设计

### 配置项

`qwen.managed-agent.harness.credentials-file`（`QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`）指定 Harness 的环境文件。设置后且 Harness 已开启时，启动校验读取该文件一次并赋值：

- `QWEN_SERVER_TOKEN` 赋给 `harness.token`；
- `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` 赋给 `harness.capability-digest`。

可选的 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` 提供 `runtime-broker.token`，预检还会把可选的 `QWEN_MANAGED_RUNTIME_BROKER_URL` 与 Broker 的地址比对，详见 [Hosted Harness Broker 环境变量设计](2026-10-21-hosted-harness-broker-environment.zh-CN.md)。其他键（例如旧的 `QWEN_HOSTED_HARNESS_BROKER_ARGS`）被忽略。这些值只保存在绑定后的配置中，从不写入日志。

systemd 和 shell 的 `source` 都会为 Harness 读取这个文件，因此控制面只接受两种读取方式都按字面理解的行，其余一律拒绝，而不是读出不同的值。含回车符的行会被拒绝（注释行也一样），因为 shell 会把它保留在值里；因此以 CRLF 换行保存的文件会在第 1 行失败。随后每行去掉首尾空白。以 `\` 结尾的行会被拒绝（注释行也一样），因为两种读取方式都会把它续接到下一行。以 `;` 开头的行无论出现在哪里都会被拒绝：systemd 把它当作注释跳过，但 shell 会报错并在这一行停止读取文件。其余以 `#` 开头的行、以及没有 `=` 的行被跳过。每行在第一个 `=` 处拆分。拆分后键名中仍含空白的行，无论是哪个键都会被拒绝：systemd 会忽略 shell 能够赋值的 `export KEY=value`，而 shell 会把 `NAME KEY=value` 当作命令执行。对 Harness 读取的键（token、digest，以及可选的 Broker URL 和 token），`=` 任一侧有空白都会被拒绝，因为 shell 会把这样的行当作命令而不是赋值来执行；其他键则去掉首尾空白。值可以用一对相同的单引号或双引号包围。只有开引号没有闭引号、闭引号之后还有文字、双引号内出现反斜杠，都会被拒绝。这些键的值只能包含字母、数字和 `._:/+=-`，这些字符两种读取方式都按字面理解；Broker URL 还可以用 `[` 和 `]` 括住 IPv6 字面量。这排除了转义、变量展开、命令替换，以及 `;`、`&`、`~` 等 shell 的其他运算符。与 systemd 一样，后出现的赋值覆盖先出现的。拒绝信息给出文件、行号和写法，从不包含该行内容。控制面不会像 shell 那样解析其他键的行，因此 shell 仍可能丢掉其中一行。shell 会把 `KEY = value` 当作命令执行，丢掉这个键；遇到无法解析的行（例如值里未加引号的 `(`）则会停下：bash 保留该行之上的赋值，丢掉该行之后的每一行，dash 则在启动 Harness 之前直接退出。`harness` 行的探测会发送 token，随后用配置的 `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` 进行协商，因此 digest 丢失或被改动时 `--check` 同样会失败；丢失的其他键只能从 Harness 自身的行为看出。其他键也请写成 `KEY=value`，并给 shell 会解析的值加引号。

### 失败语义

- 同时设置了该文件和非空的 `harness.token` 或 `harness.capability-digest`：启动失败，要求只保留一个来源。
- 文件设置了 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`，同时也设置了 `runtime-broker.token`：启动失败，要求只保留一个来源。
- 文件只设置了 `QWEN_MANAGED_RUNTIME_BROKER_URL` 和 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` 中的一个：启动失败，因为 Harness 要求两者同时提供或同时缺省。
- 文件把任一 Broker 键设为空值：启动失败，并给出键名，因为 Harness 把空值视为已设置，随后因缺少另一半而拒绝启动。
- 文件无法读取：启动失败，并给出路径和异常类型。
- 某行使用了被拒绝的写法：启动失败，并给出路径和行号。
- 必需的键缺失或为空：启动失败，并给出键名和路径。
- 以上任一情况下，文件中的值都不会被绑定。
- Harness 关闭：不读取该文件。

解析发生在 preflight 也会调用的同一个启动校验中，因此 `--check` 会在任何监听启动之前，于 `validation` 行报告这些失败。随后已有的 `harness` 行照旧检查解析出的 token 和 digest。若启动校验拒绝了该文件、凭据从未绑定，`harness` 行报告 `SKIP` 并指向 `validation` 行，而不是用残留的绑定值去探测。此外，当 token 仍是随包模板中以 `replace-` 开头的占位符（Harness 会接受它）时报告失败。新增的 `credentials` 行在 Harness 关闭或未设置文件时为 `SKIP`；服务账号无法读取该文件时为 `FAIL` 并给出 `chown` 修复；文件对 group 或 others 可读时为 `WARN` 并给出 `chmod 600` 修复，与 `config` 行对 `application.yml` 采用的策略和措辞相同；其余情况为 `PASS`。

### 模板、bootstrap 与 systemd

- `server.env.example` 和 bootstrap 生成的 `server.env` 把 `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE` 设为同目录下的 `harness.env`，不再包含 token 或 digest。
- `harness.env.example` 说明控制面会读取该文件。
- systemd README 把 `harness.env` 装成服务账号所有、权限 `0600`。控制面以该账号读取它；systemd 以 root 读取环境文件，不受其权限影响。
- 参考部署文档（中英文）和 server README 说明该配置项。

## 兼容性与风险

- 直接设置 token 和 digest 的部署照常启动。只有一处 preflight 变化同样作用于它们：token 仍是随包模板中以 `replace-` 开头的占位符时，`harness` 行现在会报告失败，而此前 `--check` 会通过。
- 新增该文件但仍保留直接配置值的部署会在启动时失败，直到删掉其中一个来源。这是有意的：两个可能漂移的来源正是要解决的问题。
- 该文件必须对服务账号可读。开启 Shell 的 Runtime worker 以同一账号运行，可以读取它，正如它已经能读取 `config/application.yml`；文件隔离仍依赖操作系统。

## 验证计划

- `ManagedAgentProperties` 单元测试：从随包格式的文件（含注释、引号、被忽略的额外键、重复键和含 `=` 的值）中解析出两个键；每种被拒绝的写法（包括回车符、任一键 `=` 两侧的空白、允许范围之外的字符）都以行号失败，且不包含值；所有允许的字符都被接受；被拒绝的文件不绑定任何一项凭据；文件缺失、键缺失、键为空分别以路径和键名失败；直接配置的 token 或 digest 与文件同时存在时失败；Harness 关闭时忽略文件；第二次校验不产生任何影响；不设文件时直接配置的值不变；`application.yml` 绑定 `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`。
- preflight 测试：`credentials` 行分别报告 `SKIP`、权限 `0600` 时的 `PASS`、group 或 others 可读以及路径不可用时的 `WARN`，以及文件不可读时的 `FAIL`；`harness` 行发送校验从文件读到的 token，在启动校验拒绝该文件时跳过探测，并对模板占位符报告失败；`run()` 把 `credentials` 行列在 `harness` 行之后；指向文件的修复提示覆盖 401 分支。
- 模板测试：bootstrap 生成的 `server.env` 和 `server.env.example` 引用 `harness.env`，且不包含任何一项凭据，并且 `harness.env.example` 的两个键都从行首开始。
- 端到端：用 bootstrap 生成文件，从 `harness.env` 启动真实 Harness，从 `server.env` 启动打包后的服务端，运行 `--check` 并完成一个 Turn。再分别以冲突的直接 token、缺失的键、token 中的 `$`、digest 的 `=` 两侧空白和 CRLF 换行重复，观察拒绝行为。

## 验收标准

- 使用 bootstrap 生成的文件时，token 和 digest 只出现在一个文件中，控制面与 Harness 能连通并完成一个 Turn。
- 上述每种失败都会阻止启动，并给出文件或键名。
- 直接配置的行为与之前一致。

## 后续工作

- 已由 [Hosted Harness Broker 环境变量设计](2026-10-21-hosted-harness-broker-environment.zh-CN.md) 实现：Broker token 与本文件共用，Hosted Harness profile 在端口被占用时直接失败而不是顺延。
