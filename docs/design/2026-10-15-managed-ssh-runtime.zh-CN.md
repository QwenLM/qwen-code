# Managed Agent SSH Tool Runtime

[English](2026-10-15-managed-ssh-runtime.md) | [简体中文](2026-10-15-managed-ssh-runtime.zh-CN.md)

状态：已在工作树实现，默认关闭；平台和部署验收尚未完成，具体范围见下文。本设计扩展现有 Broker 和 HTTP worker 协议，基于 #14254，不依赖 #14211 的空闲回收和 Workspace 共享切片。

## 目标与边界

允许授权用户登记管理员预配置的 Linux/macOS 机器上的已有目录，并在那里执行普通 Managed Agent 工具。远端预装 Node.js 22+ 和匹配版本的 qwen-code，但不必提前启动。SSH 为每个 Session 隔离的 binding generation 启动一个 detached worker。同一 Session 的 Turn 复用该 worker，不同 Session 不共享，同机可以运行多个独立 worker。

Session 正常关闭时排空并停止原 worker；未关闭的 Session 持续保留 worker。不提供空闲定时器、worker 池、generation 轮换、keep-warm、Session 创建预热、系统服务管理器或远端常驻 supervisor。worker 异常退出不触发替换，未知结果的执行不重放。重连只接管原来仍存活的 worker，不做跨机器恢复。

远端工具 profile 允许普通文件工具及受现有公开能力门槛控制的前台 Shell，拒绝后台 Shell、Monitor、MCP、Hook 和 child Workspace。原生执行面向受信运行账户；进程组证据不代表对任意逃逸外部 daemon 的操作系统级隔离。

SSH Session 准入仅接受已验证的 `hosted-workspace-files/1` 和 `hosted-workspace-shell/1` profile，包括空 Session 和已存储的 AgentDefinition；后续 Turn 再次验证该边界。已登记的 SSH 目录可满足 placement，不要求本地 mount，同时仍受文件/Shell 部署开关限制。本地 definition 和 child Workspace 保留原有门槛。

控制面在每次挂接时从受信 SSH storage 元数据推导私有 Harness `foregroundOnly` 标记。Harness 将其保存到 Session definition，冷加载和驻留加载均保留，显式改变时拒绝。这类 Session 不创建后台、Monitor、MCP、Hook 或 child 编排器；模型工具声明隐藏 Monitor 和后台 Shell，直接提交这些操作也会被实际准入拒绝。前台 Shell 保留既有结果发布、capture 和审批路径。普通本地 Harness Session 省略该标记，保留原有能力。

main 的常驻 Workspace 文件路径（#14340）仍是独立、显式配置的 CSI 模式。SSH 保留 Session 隔离、原 capability digest、逐 Session worker 所有权，以及正常关闭时的物理退役。同一个 Broker 配置不能同时包含常驻 CSI 映射和 SSH 节点。普通本地及常驻 CSI 的准入、逻辑释放和能力门槛保留既有行为；两条路径均不能重新解释 SSH storage 或代替其停止证明。

## 组件与通信

Java 服务负责静态节点目录、SSH 连接、Workspace 登记、授权和 placement。节点包含 ID/名称、SSH host 别名、Node/CLI 入口绝对路径、私有状态目录、允许登记的已有目录范围、固定远端结果回传端口及授权 tenant/actor。SSH 凭据和 known_hosts 留在服务端，强制校验 host key，转发监听 loopback，命令通过 stdin 接收结构化 JSON，不插入用户路径或 token。

`SshRuntimeProvisioner` 在启动前持久化 `ssh-process` kind 和带版本的不可变资源 handle。路由从受信 Workspace storage 元数据选择真实 provider，后续操作按已保存身份分派。未知 kind、节点或不匹配的登记不能回退本地执行。kind 归属判断仍然是身份判断；停止和原资源恢复能力按选中的 binding 判断。

`SshConnectionManager` 复用节点连接，创建逐 worker 的本地转发（`-L`）和节点共用的反向结果回传转发（`-R`）。已有认证 HTTP v2/v3 请求经过本地转发，已有 Tool Publication HTTP 经过反向转发，并按执行所绑定的节点选择受信 service URL。持久化 lease 保留远端原 endpoint，`HttpRuntimeTransport` 发送时解析当前本地转发地址；重建隧道不改变 lease 身份。稳定私有控制状态和操作系统文件锁使同一控制面主机、同一结果发布 origin 上的新 Broker 进程能在崩溃后接管原 SSH master。接管前核对已保存的节点和转发配置；未知监听或配置变化均拒绝。正常退出先等待在途命令结束再交出控制权。Session 存续期间保留这些本地控制状态；本期不增加跨主机控制面接管。

私有入口 `qwen managed-runtime-bootstrap` 每次执行一项操作后退出，版本化 JSON 协议提供环境/目录探测、幂等 storage 登记、generation ensure、只读 observe 和严格 stop。响应包含结果或带类型错误，凭据不写日志。远端 generation 状态和日志仅对配置账户开放。

bootstrap 子进程在节点的独占转发锁之外运行，避免一个慢操作阻塞同节点已有 worker 的 HTTP 请求。共享的在途屏障仍保证关闭时先等待命令完成，再释放控制器文件锁。Provisioner 控制操作限制为 4 个线程和 64 个排队任务，超载返回可重试的 `ssh_runtime_busy`。遗忘某节点/endpoint 的最后一个 lease 时取消对应本地转发并删除缓存地址；取消失败时保留路由，直至确认监听器已消失。其他 worker 的转发及共用 publication 连接继续保留。direct provider 的登记也在匹配的退役完成后，或 release 明确使 delegate 的 lease 不可用后删除。仍可用的持久化 lease 在 release 后保留路由，因为被 fence 的观察者可能与获胜观察者使用同一 lease。

每个节点还保存私有转发清单，以原子替换方式写入，并在 SSH 创建监听之前同步落盘。已确认的记录跨 Broker 崩溃保留，接管仍存活的 master 时复用原本地地址。未确认记录必须先取消才能分配新地址，包括转发已成功但回包丢失的情况。最后一个 lease 退役时，即使此前未解析该 lease，也读取并取消原记录；只有取消成功或确认监听不存在后才删除记录。仍存活的 master 缺少清单或清单无效时拒绝接管。这些控制状态不增加 worker 替换或远端恢复权限。

## Workspace 登记与 storage

在 `/api/agent/web-shell/v1` 下新增 POST 接口：

| 接口                          | 行为                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `/runtime-nodes/query`        | 列出已启用且当前用户有权使用的节点 ID/名称。           |
| `/workspaces/check-directory` | 探测 `nodeId/path`，返回已有目录规范路径和兼容性结果。 |
| `/workspaces/register`        | 为名称、节点和路径创建幂等登记 operation。             |
| `/workspaces/operations/get`  | 返回该 actor 的登记状态和成功后的 Workspace ID。       |

公开 OpenAPI contract 版本为 `1.52.0`；四个新增接口和七个 schema 用于生成 WebShell 客户端类型。SSH 登记使用 `/workspaces/register` 和 `WebShellWorkspaceRegisterRequest`，返回持久化 operation（202）。已独立发布的 `/workspaces/create` 继续创建本地空 Workspace 并返回摘要（200）；两条流程分别保留授权、幂等和浏览器草稿身份。本地创建严格拒绝未知字段，包括值为 null 的远端位置字段，避免旧 SSH 请求分配本地目录。既有 API 路径和 schema 保留原有契约。节点查询和创建默认关闭，operation 查询继续限定 tenant 和 actor。

WebShell 在现有 Workspace 选择器中增加可选登记对话框。检查目录后发起登记，重试保留幂等键和 operation，成功后选中新 Workspace，继续普通 Session 创建流程。预览不授予创建权限；创建时重新授权并验证远端身份。

登记文案包含在交互式 WebShell 入口中，从只读 transcript 入口排除，保持其原有 bundle 体积预算。

现有 storage/物理 owner 记录增加 `SSH_LOCAL`，现有 operation journal 增加 `WORKSPACE_CREATE`。Workspace 和创建者 OWNER 权限原子提交，不增加节点数据库或 worker 池表。网络操作在 SQL 事务外完成，事务内重新核对登记版本及物理所有权。共用的主机 guard 串行化本地与 SSH 登记，跨节点、跨 tenant 拒绝父子重叠根目录和物理别名。登记 claim 过期后不能写入成功或失败；后续查询可重新认领原 operation。已有 actor 范围的幂等键在新准入检查之前回放。追加下一个 schema migration 并更新 initializer/catalog 检查，不改历史迁移。

身份包含规范目录、稳定主机身份、设备号、inode、可信创建时间及登记 marker。Linux 与现有本地 physical-key 算法一致，macOS 提供原生平台身份；缺少可信身份时拒绝。SSH 别名不能绕过同一物理目录的所有权。worker 固定 storage/root 登记，在 context 安装和后续调用中验证；Session 的 `cwdRelative` 限定在登记根目录内，同 storage 的 Turn 继续由既有 holder 串行化。

取得 holder 前，SSH 在 SQL 事务外通过已有 bootstrap 目录探测检查候选 `cwdRelative`，并核对登记身份和 marker。确定无效的目录或失败的探测不会改动 holder。worker 安装 context 时仍再次校验；成功 claim 后安装结果不明确则继续保留占用，因为 HTTP 响应不能证明是否已安装。

登记 journal 使用共享 schema 的 `gmt_create`/`gmt_modified` 列，claim 截止时间和完成时间采用数据库派生的毫秒时钟。物理 key 复用本地 storage 所有权算法；服务端登记 marker 字段优先于探测得到的身份字段。

## 生命周期

启动时先持久化 seed 和确定性 handle，再调用 bootstrap ensure。bootstrap 原子取得该 generation 的唯一启动资格，使用独立进程生命周期、私有文件日志且无 IPC 启动 worker，保存 PID/ready。Broker 在原资源启动时最多观察 60 秒，建立转发并 attest 原 incarnation 后提交 READY；等待不会再次启动进程。私有 JSON 记录写完并同步后才以原子、不覆盖的方式发布；启动 claim 及父目录条目同步后才 spawn。重复 ensure 返回原资源，启动结果不明确的 claim 不再 spawn，退役标记永久拒绝迟到启动。

启动 claim 与从未启动的退役 claim 共用原子、不覆盖的 JSON 发布原语。若 launcher 确定日志打开或 spawn 在创建任何子进程前失败，则保存匹配的启动失败证据并报告 `FAILED`；该 generation 只能退役，永不再次启动。证据无法持久化时，claim 继续阻塞。子进程一旦创建，launcher 元数据失败不能产生“从未启动”证明：原 worker 也会在开放 HTTP 准入和发布 ready 前写入相同的不可变 PID。关闭与启动竞态时返回可重试 pending，不提前写启动屏障。未启动的关闭必须先赢得 launch claim；否则重新观察获胜方，等待原 worker 就绪后请求认证退役。中断的从未启动退役可凭匹配 claim 继续完成。

释放工具 Turn 的 Runtime Session 不停止 worker。SSH 故障可以重建转发并重新 attest 原 worker；Broker 退出只关闭本地连接，不停止远端 worker。Broker 启动观察已保存登记，记录缺失、worker 消失、主机重启或身份不符均保持阻塞，不换机器、不重建原 generation、不重放未知执行。

即使 Broker 重启前所有 Runtime Session 均已释放，关闭流程仍先 reconcile 并 attest 原 handle 和 lease，恢复转发后仅重试 ACK。如果原 worker 已退出且远端保存完整匹配的 clean proof，严格停止会核实该证明并补建缺失的 SQL 停止回执，不访问已退出的 HTTP endpoint。身份冲突不允许通过停止操作回退。

正常关闭先封闭准入，结清执行/结果/ACK，释放 Runtime Session，再退役原 binding。私有认证 SSH 退役接口封闭 worker 准入，确认没有未结清调用、pending start 或 publication，清理登记的 Shell 进程组，写出该 generation 的 clean proof 后退出。bootstrap 核对原 generation、seed、handle、retirement ID，并确认原进程消失后，Java 才生成 `RuntimeDrainReceipt`。holder 为空、超时、缺少 PID 或直接 kill 都不能独立充当回执；证明提交前保留 binding/storage 退役屏障。

对于已持久化为 `not_started` 且显式 `capture:null` 的 SSH Shell v3 调用，Broker 只能向原执行发送 `committed`、`manifest:null`、`historyRevision:null` 的 ACK。direct 和 deferred 引用分别保留原 wire 身份；Runtime Session 释放后仍可重试丢失的 ACK。已预留的 SQL publication 必须先通过 `close_not_started` 关闭：其 state 变为 `NOT_STARTED`，producer phase 保持 `OPEN`，生命周期检查仍拒绝隔离标记、终结输出或原执行身份变化。普通 capture 结果继续要求原有 publication 回执。

为此，共享生命周期结算需要识别已预留但明确未启动即关闭的 publication，此行为也适用于已有的本地和 CSI Session。回执 wire parser 接受显式无 capture 的结构，但它本身不构成提交授权。Broker 验证已保存的 SSH binding 和精确原 execution 后才能发出该 ACK；capture 结果发布和 worker ACK 验证保留原有 manifest/history 要求，CSI 退役仍要求原有停止证据。

每个 SSH managed-context worker 必须启用 POSIX ledger；本地 managed-context worker 也会使用 launcher 提供的 ledger。前台 Shell v3 同样登记进程组，取消时检查组退出证据。每次 SSH 前台 Shell 结果结算前，worker 清理该调用登记进程组中的残留成员并证明组已退出，包括 leader 正常退出的情况；其他并发组不受影响。退出证据失败时执行保持 UNKNOWN 并保留 holder；此保证不覆盖通过 `setsid` 逃逸的后代。ledger 登记、写入或清理失败，会永久取消该 incarnation 产生 clean proof 的资格。尽力清理的 `close()` 和 CSI 专用的严格 drain gate 均不能直接作为 SSH 证明，CSI 退役条件保持原样。

## 管理员配置与灰度

在已启用 Session Store、Hosted Harness、按 Session 隔离的 `local-process` Broker 及 Workspace 文件工具的 Managed Agent 部署中增加节点目录。下面的 Spring 配置片段保持 SSH 新准入关闭。请按管理员管理的真实配置替换路径、别名、版本和权限；`qwen-entry` 指向可执行 JavaScript CLI 入口，版本必须与远端安装一致。SSH 从服务端 OpenSSH 配置读取账户、密钥和 known_hosts。

```json
{
  "qwen": {
    "managed-agent": {
      "runtime-broker": {
        "ssh": {
          "enabled": false,
          "nodes": [
            {
              "node-id": "build-mac",
              "display-name": "Build Mac",
              "ssh-host": "qwen-build-mac",
              "node-executable": "/opt/qwen/node",
              "qwen-entry": "/opt/qwen/cli.js",
              "qwen-version": "0.25.1",
              "state-directory": "/var/tmp/qwen-managed-runtime",
              "allowed-roots": ["/workspaces"],
              "publication-port": 41270,
              "access": [{ "tenant-id": "tenant-a", "actor-id": "actor-a" }]
            }
          ]
        }
      }
    }
  }
}
```

现有 `qwen.managed-agent.tool-publication.service-base-url` 必须是 Broker 可访问的 HTTP origin，例如 `http://127.0.0.1:8080`。节点的 `publication-port` 专用于 loopback 反向转发；若不同节点条目连接同一 SSH 主机，需要配置不同回传端口。节点权限为精确的 tenant/actor 白名单。仅面向指定灰度用户设置 `qwen.managed-agent.runtime-broker.ssh.enabled=true`。前台 Shell 还需通过现有 Shell profile 和审批门槛；SSH 开关不授予额外工具能力。

Session 存续期间保留节点 ID、安装路径、Workspace marker 和远端状态记录。设置 `ssh.enabled=false` 关闭目录登记和新 SSH Session 准入，原 operation 查询、丢响应重试、结算及关闭仍可用。删除节点定义不能替代 worker 排空。WebShell 允许放下已确认永久阻塞的登记，开始另一项登记；该动作只删除浏览器草稿，不能释放原物理目录的占用。

bootstrap stdin 协议为 `protocolVersion=1`。`ensure` 的 `launch=false` 持久化不可变 generation intent，Java 将其引用写入 SQL handle 后才提交 `launch=true`。`expectedQwenVersion` 锁定新进程的安装版本；安装更新后，`observe` 和 `stop` 仍可观察或退役原 generation，不会启动替代进程。认证接口 `/internal/managed-runtime/v3/retire` 仅供 SSH bootstrap 使用，不是用户可调用的强制解锁接口。

## 交付与验证

按可独立验证的切片交付 bootstrap/严格退役、storage 登记、Broker/HTTP 接入和 WebShell。功能默认关闭，禁用新准入后仍能结算和关闭已有 SSH Session；节点配置保留至这些 Session 退役。

实现前记录全局 CLI 的基线。执行聚焦 Node/Java/UI 测试、完整 build/typecheck/bundle、相关 Java Maven 检查和两遍干净 diff 自审。在 Linux 和原生 macOS 验证真实进程，区分本地 bootstrap 验证与完整真实 SSH/控制面/MySQL 验收。

验收覆盖重复/丢失启动响应下每 generation 一个 PID、跨 Turn 复用、同机 worker 独立、同 storage 串行、文件及前台 Shell 结果/取消/ACK、正常关闭的 clean proof 与无登记残留、隧道/Broker 故障后的原 worker 重连，以及 kill、重启、目录替换、ledger 故障、未知执行时的保守失败。本地、static、CSI 均需回归。未测试的远端平台明确标为未验证。

### 初始实现验证，2026-10-15 至 2026-10-16

初始实现在原生 macOS arm64、Node.js v24.12.0、JDK 21.0.8 环境下通过 CLI 进程测试、完整 Harness/tool-turn 741 例回归及 WebShell 聚焦 126 例。扩展 Java unit/H2 运行覆盖 SDK 249 例（跳过 9 例）、Broker 984 例（跳过 2 例）及服务端 2,911 例（跳过 7 例）。修正测试中的 schema 预期、恢复 fixture 和审计记录后，通过 132 例 source-reactor 复验确认受影响类。Maven 验证、Checkstyle 和 SpotBugs 均通过。MySQL 8.4.11 的 72 例集成测试全部通过，覆盖 V3 到 V4 迁移、登记、同 storage holder、恢复及生命周期结果发布/停止证明；此前在报告版本为 26.7.0 的本地 Homebrew 服务上也通过了聚焦验证。该初始实现经过两遍干净自审和独立审查。上述计数早于随后合并 main 及审查修复。

最后一轮完整 `npm run build`、`npm run typecheck` 和 `npm run bundle` 均通过。使用刚生成的 `dist/cli.js` 冒烟验证了目录探测/登记、不可变 intent、首次启动、重复 ensure 复用同一 PID，以及带匹配证明的正常停止。

原生 macOS 上的七项真实 loopback SSH 测试使用本任务自有 sshd、临时凭据/known_hosts 和高位 loopback 端口，覆盖存活 worker 复用、双向转发、Broker JVM halt 后原 master 接管、原 worker 消失、Runtime Session 释放后 direct/deferred no-start 原 ACK 重试，以及根据已有 clean proof 补建 SQL 停止回执。结果发布对端使用有界 HTTP 测试 stub；WebShell 桌面/移动端冒烟使用 mock HTTP 响应。

### 审查修复验证，2026-10-16

合并 main 后，独立原生 OpenSSH 红绿验证通过六项通信/生命周期场景：bootstrap 期间同节点请求继续完成、反复清理转发、临时 direct 路由清理、共用转发存续、取消响应丢失，以及关闭时的控制权屏障。测试使用隔离的 SSH 环境和 HTTP stub，未覆盖完整 Qwen worker/SQL 链路。独立控制队列复现发现 `shutdownNow` 会遗留八个未完成的 future；改为有序关闭后，八个 future 均以异常完成。已提交的回归也覆盖排队请求完成。

环境访问清单三例全部通过，完整 WebShell 构建产物测试 34 例全部通过。transcript JavaScript 测量为 1,331,210 个 UTF-16 单元，低于未修改的 1,331,500 上限。完整 build、typecheck、bundle 及受影响 TypeScript lint 均通过。

source reactor 完成 SDK 249 例 unit（跳过 9 例）、Broker 1,005 例（跳过 9 例）及服务端 2,937 例 unit/H2（跳过 7 例），零失败。MySQL 8.4.11 的 72 例集成测试全部通过。最终门槛发现 main 带入的 CSI 集成 fixture 存在 import/switch 缩进错误；仅修正导入顺序和缩进，导入集合及非 import 行内容不变后，以 `-DskipTests verify checkstyle:check` 续跑，通过三个模块的 Checkstyle 和 SpotBugs。未为这一纯格式改动重复已完成的测试套件。

随后合并 main，保留其子 Turn 取消行为，为 SSH 专用生命周期 fixture 补齐新增依赖。八处继承的 SQL fixture 插入改用规范时间列，其中 journal 使用数据库毫秒时钟。合并后的树通过 247 例聚焦 Java unit/H2、全部 72 例 MySQL 8.4 集成测试、Checkstyle 和 SpotBugs；完整 build、typecheck、bundle，以及 54 例模型/prompt/环境测试、21 例原生 bootstrap/目录 storage 测试和 34 例 WebShell 产物测试均通过。

随后完整 SDK Java CI 发现了从 main 继承的旧故障门槛预期：已移除的 SQL 时间列、SSE 证据仍读取旧时间字段、租约探针将毫秒值与 SQL 日期比较，以及团队关闭 fixture 仍要求子 Turn 自然完成。提交 `8f98bac` 的续修仅调整这些测试 fixture，保留 SSE 投影的精确比较，使用共享数据库毫秒时钟，并要求模型响应仍被阻塞时，子 Turn 已取消且子 Session 已关闭。原生 macOS 检查与完整 Linux 生命周期及多节点 CI 分别记录；原有 local-process 能力检查保持有效。

在 `8f98bac` 上，Linux SDK Java CI 通过全部 46 例 Hosted 进程集成测试（无跳过）、准入和 Runtime Broker 故障门槛，以及 EventTransport 多节点门槛。服务端 MySQL/MariaDB 任务和 Linux、原生 macOS、Windows 上的 Java 21 任务也均通过。随后 O4 步骤在普通 unit/H2 套件中失败，尚未执行 O4 集成场景；这不是 O4 集成结果。

对实际最新环境查询在绑定参数后重编译，已稳定复现 H2 错误。H2 未推导出 Session/Turn 行参数的二进制类型，导致绑定的字符串无法与 schema 的二进制 ID 比较。查询现在使用已有规范 UTF-8 编码器绑定这两个身份，不改变 SQL 或 tenant 条件。已有准入顺序回归强制重编译，保留原有行为断言。

修复后的树通过八例聚焦重编译回归及完整 2,944 例服务端 unit/H2，其中七例为原有跳过。真实 MySQL 8.4.11 上的九项独立实际 store 检查通过，覆盖批量读取、准入顺序、缺失事件、较旧 Turn 迟到事件、tenant 隔离，以及 Unicode 和大小写敏感身份。完整 MySQL profile 通过全部 76 例 Broker 测试；服务端共执行 611 例，在使用两秒 claim 的既有 publication fixture 中出现一项错误，因此整轮验证失败。该未修改方法的聚焦验证续跑通过，包括 Checkstyle 和 SpotBugs。这不构成完整 611 例通过；原失败与较小范围的成功复验分别保留记录。

### 合并后的服务端模块验证，2026-10-16

合入 #14277 后，Broker、Server 及 SSH 新增实现统一位于 `packages/managed-agent-server`，Java SDK 仍位于 `packages/sdk-java/qwencode`。main 现已包含 #14316 的 V4 Workspace 创建 receipt namespace、V5 模型选择 schema 和 V6 审批选择；SSH 追加 V7，不改写任何已发布迁移资源。初始化器与 catalog 在应用 V7 前识别所有已发布的 V1–V6 catalog。公开 API 从 main 的 1.51.0 升为 1.52.0，保留本地 Workspace 创建及模型、审批控件。重建旧预览的临时 catalog 前，先用原构建排空预览 Session；不改写、不 repair Flyway history。动态创建的本地根目录与登记的 SSH storage 分别保留身份校验，SSH lifecycle-v2 的严格退役证明要求与 main 的旧版 held-Runtime 清单机制分别保留。浏览器使用独立 SSH 登记草稿 key，避免刷新后由本地创建消费远端登记 receipt，并在 Managed 模式不活动时隐藏远端登记对话框。

前一 head `7521696` 的 Linux CI 通过全部 56 例 O4 集成测试，无跳过，包含容量探针。其 Hosted 进程 profile 仍有 46 例中的一项错误：`resident-expiry` fixture 的首个 Turn 在 Harness 记录阻塞恢复的 HTTP 非法参数响应后保持 RUNNING，尚未进入删除故障点。现有 artifact 无法识别被拒绝的路由或字段。没有将其归类为基础设施偶发问题，加长等待或自动重试也不能证明修复。仅此合成 Linux fixture 启用两个窄范围 Spring DEBUG logger，并保持请求详情遮蔽，以便后续失败产物记录请求路径、状态和异常。独立真实 DispatcherServlet 探针已验证配置有效，且未暴露其 header/body/parameter 哨兵值；原始 query 和异常 message 仍可见，因此这不是生产日志配置。

合并后的 source reactor 通过全部 77 例所选 SDK 测试、3,956 例合并模块 unit/H2（16 例原有或按需启用的跳过），以及 148 例所选 MySQL 8.4.11 测试（无跳过，其中 Broker 76 例、SSH/Workspace 72 例）。Checkstyle 和 SpotBugs 通过，九项独立实际 store 的 MySQL 检查也通过。

较宽范围的工作流/脚本测试完成 1,284 例通过、27 例跳过，并有一例 autofix 超时交接失败；随后原有 600ms 测试在不改代码的单例聚焦运行中通过。原整套失败记录仍保留，不将其描述为整套全绿。

按需启用的 SSH 进程 fixture 需要修正两处相对路径以适应新模块位置。独立运行先复现了启动 SSH 前的 setup 失败；修正仓库根目录后六例通过，第七例暴露 publication fixture 路径。修正第二处路径后，全部七例真实原生 macOS loopback SSH 测试通过，无跳过，包含 deferred no-start ACK 退役，后续 Checkstyle 和 SpotBugs 也通过。最终聚焦验证重新编译了全部测试源码；此前失败的一轮分别保留。

合并后的树还通过完整根目录 build、typecheck 和 bundle，所选 Harness、tool-turn、Broker、原生 bootstrap 及 Workspace binding 五组 CLI 测试共 1,024 例，以及全部 34 例 WebShell 构建产物测试。从新的服务端目录重新生成公开 API 类型，产物逐字节一致。这些组件检查不能替代尚未完成的 Linux/实际部署验收。

原有 durable local-process 主机身份门槛拒绝原生 macOS。该阻塞 fixture 不计为本地已验证，没有伪装 OS 或关闭能力门槛。Hosted HTTP 失败仍等待 Linux 上进一步诊断。

尚未执行 Linux 上的 SSH Runtime 验收和跨物理机器验收，也未运行完整部署的 WebShell → Java → MySQL → 远端 Shell publication 链路；各组件已分别验证。没有配置或修改生产节点。这些缺口意味着当前不能宣称已通过生产验收。
