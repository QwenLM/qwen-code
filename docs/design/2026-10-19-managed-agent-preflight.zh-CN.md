# Managed Agent 预检命令

[English](2026-10-19-managed-agent-preflight.md) | [简体中文](2026-10-19-managed-agent-preflight.zh-CN.md)

状态：本次改动已实现。

## 问题

参考分发只用文字列出前置条件，而服务要到启动时或第一条 Turn 执行时才逐项校验。缺少 `performance_schema` 授权、空的凭据密钥环、非 loopback 绑定下的 `auth mode=auto`、不可达的 Harness、长度不足的凭据密钥、不可写的 Runtime 状态目录、被占用的端口，各自以不同错误出现，其中一部分只在 Session 创建后才暴露。运维只能一次踩一个坑。

## 范围

`bin/qwen-managed-agent-server --check`（等价于
`java -jar qwen-managed-agent-server-<version>.jar --check`）运行预检后退出。它复用现有 server 产物，参考分发不新增组件。

命令读取服务端读取的配置，按 `SpringApplication` 在创建 context 之前准备环境的方式准备，因此每项输入都保持 Spring 的优先级：

- 命令行参数（`--server.address=...`、`--qwen.managed-agent.*`）；
- `SPRING_APPLICATION_JSON`，其次是 JVM 系统属性（`-D…`，例如 `JAVA_TOOL_OPTIONS` 中的），再次是其余进程环境变量；
- Spring Boot 读取的配置文件：由 `spring.config.location`、`spring.config.additional-location` 或 `spring.config.import` 指定的文件，以参数或 `SPRING_CONFIG_*` 变量给出（启动脚本在 `config/application.yml` 存在时设置 `SPRING_CONFIG_ADDITIONAL_LOCATION`，systemd unit 的 `server.env` 指定 `/etc/qwen-managed-agent/application.yml`）；默认位置 `./`、`./config/` 和 `./config/*/` 下的文件；`.yml`、`.yaml`、`.properties` 或 `.xml` 格式，文件名取 `spring.config.name`；以及它们的 profile 变体、它们 import 的文件和 config tree；
- classpath 中把 `QWEN_MANAGED_AGENT_*` 变量映射为属性的 `application.yml`。

`spring.config.location` 会替换全部默认位置，classpath 中的也在内。因此设置了它，服务端只读它列出的位置。除非其中列出 `classpath:/`，classpath 中的 `application.yml` 就不会被读：只由该文件映射的变量（如 `QWEN_MANAGED_AGENT_SERVER_ADDRESS`）不再设置任何属性，该文件设置的默认值（如回环的 `server.address` 和 Flyway 的 locations）也随之丢失。没有地址时服务端会监听所有地址，而默认的 `auth.mode=auto` 会因此拒绝启动。只要 Spring 能完成环境准备，检查读到的配置就与服务端相同。

相对位置（包括默认位置）与服务端一样在工作目录中解析，因此命令要在服务端的工作目录中运行：分发包根目录，或 unit 的 `WorkingDirectory`。在 [#16057](https://github.com/QwenLM/qwen-code/issues/16057) 之前，它只读取启动脚本或 `server.env` 指定的那个文件，漏掉了服务端从工作目录 `config/application.yml` 读到的 `server.port`。

## 检查项

| 检查         | 通过条件                                                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `java`       | Runtime feature version 不低于 21。                                                                                                                                                                                                            |
| `config`     | 服务端读取的每个文件一行：service account 可读；一个文件都不读，或含 secret 的文件对 group 或 others 可读时为 WARN。Spring 会拒绝启动、YAML 错误（给出行号，通常也给出文件），或本进程读不了文件、进不去或列不出目录时为 FAIL。                |
| `key-ring`   | 至少配置了 active key ID；同时输出 previous key ID。                                                                                                                                                                                           |
| `validation` | 绑定后的配置通过启动期属性校验。                                                                                                                                                                                                               |
| `auth`       | 非 loopback 绑定不使用 `auto`；signed 模式配置了签名密钥；insecure bind 会给出告警。                                                                                                                                                           |
| `harness`    | 启用的 Harness 具备 token 和格式正确的 digest，`GET /capabilities` 返回 200，且协商过程与第一个 Session 相同，包括 capability digest 和每个 Workspace profile 的 lifecycle；Qwen Code 版本与 manifest 不同时给出警告。不与 Harness pool 协商。 |
| `tool-path`  | Workspace files 与 Shell 的启用组合、isolation class，以及 mount、creation root 或 SSH 节点的要求满足启动期规则。                                                                                                                              |
| `broker`     | token、active 与 previous 凭据密钥均可解码为 32 字节；状态目录可写；provisioner 所需的 Node/worker 或 static endpoint 齐备。                                                                                                                   |
| `workspace`  | 配置的 Workspace `cwd` 存在且可写。                                                                                                                                                                                                            |
| `*-port`     | server 端口与已启用的 broker 端口可绑定；使用 `--online` 时改为可以建立连接。                                                                                                                                                                  |
| `workers`    | local-process 状态目录中没有上次运行遗留、仍在运行的 Runtime worker。                                                                                                                                                                          |
| `database`   | MySQL 能执行 `SELECT 1`，`performance_schema` 授权可用，且 Flyway 版本与发布 manifest 一致（manifest 存在时）。                                                                                                                                |

`WARN` 与 `SKIP` 不导致失败；任一 `FAIL` 使退出码为 1。端口检查会实际绑定配置地址，因此应在服务停止时运行；针对运行中的服务，请加上 `--online`。Harness 协商、`workers` 行和 `--online` 见 [2026-10-23-managed-agent-preflight-harness-workers-online.zh-CN.md](2026-10-23-managed-agent-preflight-harness-workers-online.zh-CN.md)。

## 非目标

- 不与 Harness pool 的每个端点协商。开启 `harness.pool.enabled` 时，只有在 Session Store 已启用且配置了 binding key 后，`harness` 行才对 pool 的端点 SKIP，否则为 FAIL，与启动期守卫一致。
- 不校验 Workspace mount 注册与 storage identity；这些仍由 “Verified physical Workspace recovery” 流程负责。
- 不执行修复、migration 或任何写入，只做只读探测。

## 实现

`ManagedAgentServerApplication` 在 `SpringApplication.run` 之前拦截 `--check`，因此不会启动监听、调度器、数据源连接池或 worker。`ServerEnvironment` 按 `SpringApplication` 的方式准备 servlet 环境：参数、进程环境，然后经 `EnvironmentPostProcessorApplicationListener` 运行 classpath 上的所有 environment post-processor，并启用宽松绑定。它不创建 context；升级命令读取设置所用的 `ResolvedConfiguration` 也准备同一个环境。`config` 行先列出准备好的属性源来自的文件，再列出 Spring 在某个位置读到但其中没有任何设置的文件。检查不自行解读 location 的写法，而是记录 Spring 自己的解析器去查找配置文件的每个路径（无论文件是否存在）。因此，大小写不同的 scheme、`resource:` 前缀、扩展名提示、带冒号的裸文件名、为空的 `spring.config.location` 或 `spring.config.name`，以及 Spring 激活的每个 profile 的变体，结果都与 Spring 的读取一致。对每个文件，它同时记录打开该文件的属性源 loader：YAML 的，或 .properties 的（后者把名字以 `.xml` 结尾的文件按 XML 读）。判断文件是否含 secret 时就按这个格式读，因此 `file:app.yml[.properties]` 按 .properties 读。Spring 打开 config tree、列出通配符目录时不经过这种查找，这两种情况从 location 的取值得出，并按 Spring 的 location 规则读取：通配符下的各个目录（名称以 `..` 开头的除外，Spring 会跳过它们），以及每个目录中目录 location 对应的各个文件，或文件通配符给出的那一个文件名，各按 Spring 为该文件名选的 loader 的格式读；但 Spring 若是经查找读到该文件的，就以那时的格式为准。Spring 经通配符读到的文件中的相对 import 也是一个通配符：Spring 以通配符为基准读取它，因此会在通配符下的每个目录里读，例如 `config/*/application.yml` 中的 `extra.yml` 对应 `config/*/extra.yml`。文件通配符的文件名若只是一个扩展名（如 `*/properties`），Spring 得到的 location 会被它拒绝，该行如实报出。其中本进程无法列出或进入的目录，会作为它看不进去的目录报出。准备过程抛出异常时，该行写明 Spring 拒绝的原因：被当作不存在或不可读的文件，或 YAML 错误所在的文件和行号。由于 Spring 的错误信息不包含这两者，需要在 Spring 拒绝之前查找过的文件中定位：列出 Spring 按 YAML 读取、且自身错误与 Spring 一致（问题相同、位置相同）的每个文件（按 Spring loader 的方式读，但保留 Spring 取消的别名与递归键限制）；若参数或环境变量激活的 profile 能确定 Spring 读的是哪一个，则只列那一个。本进程读不了的文件，若 service account 也读不了，就写 service account；否则提示以该账号运行检查。此时其余各行读取参数、进程环境和打包默认值。环境准备成功、但某一行读取的设置无法解析时（例如没有取值也没有默认值的占位符），该行报 FAIL 并给出 Spring 的原因，其余各行照常输出。环境准备成功、但检查无法确定 Spring 读了哪些文件时（例如某个 import 的占位符相互引用），属性源指明的文件和已知被 loader 读过的文件仍各有一行（通配符找到的文件按其提示可能指定的两种格式判断），另加一条 `config` 行报 WARN 并给出原因，其余各行照常输出。

Spring 会跳过它看不到的 optional 文件。因此，本进程进不去服务端查找配置文件或 config tree 的某个目录，或列不出服务端要列出的目录（例如为 `config/*/` 列出 `config/`）时，会有一条 `config` 行写明该目录，并提示以 service account 或 root 运行检查；service account 的 uid 为 0 时，只提示以该账号运行。若 service account 也进不去，Spring 在那里什么都不读，该目录就不出行。未配置 service account，或检查本身就以该账号运行时，也不出行：此时与每个文件行一样，由本进程代表服务端的账号。service account 为 root（即 uid 为 0 的账号，不论叫什么名字）时，与内核的处理一致，不论权限位如何都可以读取和进入。本进程无法沿文件路径查看而 service account 可能可以，或者本进程读不了 service account 能读、而检查要读取的文件时，该文件行与目录行一样为 FAIL：说明运行检查的账号读不了该文件，并提示应以哪个账号运行检查。在本进程进不去的目录之后，缺失的文件看起来与 root 能读的文件一样，拒绝 root 访问的文件系统也是如此，所以检查不会把它判定为存在。

文件是否含 secret 只按一条规则判断，即配置参考的规则：键名表示 password、token、key 或 secret，或是一组 key 的映射（Spring 宽松绑定认可的任何写法都算），且不是 ID，也不是保存 secret 的文件的路径；或者取值中含有 secret，例如 JDBC URL 的 `?password=` 参数，或 URL 用户信息中的密码。配置文件按 Spring 读它的方式读，即按读取它的 loader 的格式。这条规则判断三类内容：该格式读出的内容（每个文档都算，包括没有任何 profile 激活的文档），按 Spring 的绑定方式判断：键按其字符串判断，若键是集合则按 Spring 写进属性名的其中各项判断；无论键出现在哪个 map 里都判断，包括 merge 的来源、set 的成员和 pairs 的键（后两者 Spring 可能当作值绑定，也可能根本不绑定），因此判断的键名是 Spring 实际键名的超集；并且只在其值可能绑定出属性时才算，因此 `previous-credential-keys: {}` 不算声明了任何键；文件文本中任何位置（包括注释）含 secret 的取值；以及每条注释在取消注释后会构成的设置。注释按文件本身的格式读，其中含空白的 YAML 键是说明文字而不是设置，例如 `# Database password: set it in the environment`；XML 注释还要逐个 entry 读，因为注释不一定是合法文档；YAML 和 .properties 的注释还要按两者共同的 `key: value` 或 `key=value` 写法读（键可带引号，也可在列表标记之后），例如 YAML 中的 `# spring.datasource.password=x`。.properties 把空白当作分隔符，所以 `# spring.datasource.password hunter2` 在其中也算；但以空白结束的键只有带点（像属性名那样）且取值只有一个词时才算，因此 `# Password rotation happens yearly` 或 `# spring.datasource.password is supplied by the unit environment` 这样的说明文字不算。注释由格式决定：YAML 中，从行首或空白之后的 `#` 开始，到下一个这样的 `#` 为止，不论连续几个注释符，它也可能落在带引号的标量或块标量里，这只会多判断一些文本；.properties 中，是空白之后以 `#` 或 `!` 开头的行，或以转义后的注释符开头的行（如 `\#` 或 `\u0023`，Spring 也把它们当注释读），但不包括取值经上一行末尾奇数个反斜杠续接过来的行，不过在键的开头单独一个反斜杠不续接任何内容；以反斜杠结尾的注释，Spring 可能把下一行也读进去，因此下一行也当作注释判断；XML 中，是 `<!--` 与 `-->` 之间的内容。YAML（包括注释中的 YAML）用与 Spring loader 相同配置的 SnakeYAML 读，但只组装节点、不构造对象，并用栈遍历，每个节点只处理一次。哪些节点能到达 secret 名称，每个文档只算一次；判定为绑定不出属性的节点也会记住。别名在节点间共享，从不展开，因此无论是很长的别名链、引用自身的别名，还是共享同一节点的许多键或值，开销都不超过遍历几遍节点。位置提示为文件指定了另一种 loader 时，还要按文件名对应的格式再判断一次（注释也算），因为 Spring 没有绑定的内容仍留在文件里。YAML 按 Spring 的方式解码：UTF-8，或按字节序标记指明的编码，因此字节序标记不会让第一行被注释掉的键漏判。.properties 也按 Spring 的方式解码为 ISO-8859-1，但查找注释时按编辑器写入的样子读：跳过 UTF-8 字节序标记（Spring 会把它读进第一个键），有 UTF-16 字节序标记时按 UTF-16 读（Spring 会把整个文件当 ISO-8859-1 读）。值文件有 UTF-16 字节序标记时也按 UTF-16 解码。config tree 值文件对应的属性也要判断。同一路径可以既是配置文件又是 config tree 值文件（例如 config tree 导入在 `config/` 之上时的 `config/application.yml`），此时两种身份都要判断。Spring 不把它当配置文件读取的值文件，无论叫什么名字，都只按取值判断。`Binder` 生成 `ManagedAgentProperties`，Harness 探测使用 JDK HTTP client，数据库探测使用 JDBC，连接与 socket 超时均为 5 秒。

## 验收

- 单元测试覆盖 digest 与密钥校验、配置位置优先级、auth 判定、基于本地 HTTP server 的 Harness 探测，以及 broker 与 tool-path 检查。
- `mvn verify` 通过两个 Checkstyle execution 与 SpotBugs。
- 无数据库时运行打包 jar，会打印检查表、报告连接失败并退出 1。依赖齐备的部署预期退出 0；本次改动未在本地验证该路径，因为本机没有可用 MySQL 实例。
