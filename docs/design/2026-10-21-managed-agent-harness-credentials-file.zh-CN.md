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
- 改变 Runtime Broker token；它在 CLI 中仍没有环境变量来源。
- 删除现有的直接配置项；它们单独使用时仍然有效。

## 设计

### 配置项

`qwen.managed-agent.harness.credentials-file`（`QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`）指定 Harness 的环境文件。设置后，启动校验读取该文件并赋值：

- `QWEN_SERVER_TOKEN` 赋给 `harness.token`；
- `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` 赋给 `harness.capability-digest`。

其他键（如 `QWEN_HOSTED_HARNESS_BROKER_ARGS`）被忽略。这些值只保存在绑定后的配置中，从不写入日志。

文件采用随包文件所用的 systemd `EnvironmentFile` 语法子集。每行先去掉首尾空白，再在第一个 `=` 处拆分；没有 `=` 的行被忽略，注释行也不可能命名这两个键。键和值都去掉首尾空白，用一对相同的单引号或双引号包围的值去掉引号。不做变量展开；与 systemd 一样，后出现的赋值覆盖先出现的。

### 失败语义

- 同时设置了该文件和非空的 `harness.token` 或 `harness.capability-digest`：启动失败，要求只保留一个来源。
- 文件无法读取：启动失败，并给出路径。
- 必需的键缺失或为空：启动失败，并给出键名和路径。

解析发生在 preflight 也会调用的同一个启动校验中，因此 `--check` 会在任何监听启动之前，于 `validation` 行报告这些失败。随后已有的 `harness` 行照旧检查解析出的 token 和 digest。新增的 `credentials` 行在未设置文件时为 `SKIP`；文件对 group 或 others 可读时为 `WARN`，并给出 `chmod 600` 修复；其余情况为 `PASS`。

### 模板、bootstrap 与 systemd

- `server.env.example` 和 bootstrap 生成的 `server.env` 把 `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE` 设为同目录下的 `harness.env`，不再包含 token 或 digest。
- `harness.env.example` 说明控制面会读取该文件。
- systemd README 把 `harness.env` 装成服务账号所有、权限 `0600`。控制面以该账号读取它；systemd 以 root 读取环境文件，不受其权限影响。
- 参考部署文档（中英文）和 server README 说明该配置项。

## 兼容性与风险

- 直接设置 token 和 digest 的部署不受影响。
- 新增该文件但仍保留直接配置值的部署会在启动时失败，直到删掉其中一个来源。这是有意的：两个可能漂移的来源正是要解决的问题。
- 该文件必须对服务账号可读。开启 Shell 的 Runtime worker 以同一账号运行，可以读取它，正如它已经能读取 `config/application.yml`；文件隔离仍依赖操作系统。

## 验证计划

- `ManagedAgentProperties` 单元测试：从随包格式的文件（含注释、引号、被忽略的额外键和重复键）中解析出两个键；文件缺失、键缺失、键为空分别以路径和键名失败；直接配置的 token 或 digest 与文件同时存在时失败；不设文件时直接配置的值不变；`application.yml` 绑定 `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE`。
- preflight 测试：`credentials` 行分别报告 `SKIP`、权限 `0600` 时的 `PASS`，以及 group 可读时的 `WARN`。
- 模板测试：bootstrap 生成的 `server.env` 和 `server.env.example` 引用 `harness.env`，且不包含任何一项凭据。
- 端到端：用 bootstrap 生成文件，从 `harness.env` 启动真实 Harness，从 `server.env` 启动打包后的服务端，运行 `--check` 并完成一个 Turn。再分别以冲突的直接 token 和缺失的键重复，观察拒绝行为。

## 验收标准

- 使用 bootstrap 生成的文件时，token 和 digest 只出现在一个文件中，控制面与 Harness 能连通并完成一个 Turn。
- 上述每种失败都会阻止启动，并给出文件或键名。
- 直接配置的行为与之前一致。

## 后续工作

- 为 CLI 的 Runtime Broker URL 和 token 提供环境变量或文件来源，并让 Hosted Harness profile 在端口被占用时直接失败而不是顺延。
