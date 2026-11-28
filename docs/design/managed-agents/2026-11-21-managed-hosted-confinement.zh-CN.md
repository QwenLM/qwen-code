# Hosted Workspace Runtime 隔离设计

[English](2026-11-21-managed-hosted-confinement.md)

[#15081](https://github.com/QwenLM/qwen-code/issues/15081) · [#12380](https://github.com/QwenLM/qwen-code/issues/12380) · [#14667](https://github.com/QwenLM/qwen-code/issues/14667) · [初始设计 #15163](https://github.com/QwenLM/qwen-code/pull/15163)

## 背景与范围

#15081 要求约束 Workspace 的文件系统访问和进程树，提供可理解的拒绝原因，并由运维显式启用。#12380 将 Workspace 副作用和未知结果交给选定 Runtime 处理，并为面向不可信用户的部署保留独立验收。#15163 为 Linux `local-process` 选择私有文件系统视图及 Broker 可核验的停止证明。#14667 跟踪 Worker 死亡后仍可核验的进程约束。

在基线 `0cfbdac07b`，Core 的通用 bwrap 执行器使用 `--ro-bind / /` 限制写入。除特定遮蔽路径外，宿主权限允许的 Workspace 外读取依然可行。Hosted 文件和前台 Shell 路径使用 Worker 权限，`serve` 拒绝公开的执行沙箱设置。local provisioner 的 Linux cgroup 停止回执仅用于 Managed 扩展档案，且需要从存活的 Runtime 取得证明。stdio MCP supervisor 回收的是进程组，创建新 Session 的后代可以离开该组。持久 local provisioner 检查原 Worker 的 PID 和启动身份，普通停止回执只覆盖原 Worker。

本次交付覆盖三个阶段。Core 提供私有根执行器，Broker 验证持久本地 Runtime 的 cgroup 已停止，选定 Hosted Workspace Runtime 用这两层约束运行前台 Shell。持久 cgroup 阶段覆盖 Worker 和继承原组的后代，包括 stdio MCP 和脱离原进程组的进程。共享 Runtime、由外部服务启动的进程、MCP supervisor 内存治理、默认启用及 Windows 支持属于独立范围。

Broker 可以显式为本地、持久且 Session 独占的 Hosted Workspace Runtime 启用 Linux 私有根。本阶段通过独立的 `hosted-workspace-confined-shell/1` profile 的有界 Tool v2 结果通道，为绑定到已登记 Workspace 根目录的内置 Agent Session 开放前台 Shell。命令可访问授权的 `/workspace`、部署提供的只读镜像和私有临时目录，网络关闭。原生文件工具、进程服务和可执行扩展需要独立的准入设计。

选定的 Worker 继续作为可信的宿主控制进程，使用现有的本地回环认证协议。每条通过准入的命令均由私有根启动器执行。Worker、启动器和命令都在原 Runtime cgroup 内，生命周期清理可在 Worker 不响应时证明整个 Runtime 已停止。

## 部署与信任边界

运维将 `qwen.managed-agent.runtime-broker.provider-options.cgroup-root` 设为 cgroup v2 上专用、规范化且已委派的目录。local provider 只在持久 Linux 模式下接受该设置。新建的 Managed 绑定需有关联 storage，满足 `WorkspaceExecutionProfile.admitsIsolationClass` 与 `admitsCapabilityDigest`，并排除 Managed 扩展执行档案。非 Managed worker 沿用现有路径。对不支持的 Managed 放置在分配或启动 worker 前拒绝。已有版本 2 句柄的绑定使用登记的档案。持有版本 3 句柄的绑定遇到配置变更时，仍使用原单元。

Broker 和 worker 是受信服务进程。部署端控制状态目录、cgroup 层级和挂载 namespace。部署必须阻止工具、同 UID 的不可信宿主进程及其他管理者把 Runtime 进程移出绑定单元、将其他进程移入该单元或修改恢复记录。委派根及其上级路径须保持稳定，只有 Broker 能在资源锁下创建或删除其单元。运维须避免其他挂载覆盖这些路径。从版本 3 worker 的启动环境移除 `QWEN_MANAGED_HOOK_CGROUP_ROOT`。前台工具与 stdio MCP 继承原单元。依赖独立委派 supervisor 的命令型 Hook、后台 Shell 和 Monitor 继续使用已有的隔离不可用拒绝。隔离 Hosted profile 通过私有根将 cgroup 控制面置于 payload 的视图之外。

部署端控制根镜像、bwrap 二进制、解释器、relay、状态目录和 Workspace 挂载源。部署端须保证源路径的完整解析链保持稳定，包含其上级路径，并在运行期间保护预置镜像不被修改。与 worker 共用 UID 的宿主进程属于信任边界，因为它们可访问宿主控制文件及回执。独立构建镜像，排除宿主凭据和其他 Workspace 数据。在整个执行期间，两个挂载源目录树都必须排除子挂载、设备节点、通向外部服务的路径型 socket，以及源目录树之外文件的 inode 别名。导入 Workspace 时须把外部文件复制到独立 inode。部署端必须对所有可修改 Workspace 的宿主写入者维持这些约束。执行器检查启动输入，挂载源的配置及持续约束由调用方负责。

## Bubblewrap 私有根执行契约

在 Core 现有 bwrap 适配器旁提供内部入口 `executePrivateRootBwrap`。接收显式指定的绝对路径，包括 rootfs、Workspace、安装和状态目录，以及 Workspace 访问模式。复用打包的 bwrap relay 以及现有路径、临时目录、回执和清理检查。拒绝非 Linux 环境及 root worker、相对路径或非目录 rootfs，以及缺失、指向符号链接或非空的镜像挂载点。按规范路径检查相等及双向父子关系。在两种访问模式下都拒绝 Workspace 与镜像、安装、状态或启动器目录重叠。对镜像与受保护的宿主目录执行相同检查。使用部署端拥有的、规范化绝对路径对应的非 setuid 和非 setgid bwrap 启动器，启动前验证其存在并可执行。

仅挂载只读镜像到 `/`、按准入模式挂载选定 Workspace 到 `/workspace`、私有 tmpfs 到 `/tmp`，以及 bwrap 的最小 `/dev`。镜像为后三个挂载点提供空目录。视图内没有 procfs，也没有宿主家目录、安装目录或状态目录的挂载。显式启用私有 user namespace 并禁止嵌套 user namespace，使用独立 PID、network、IPC 和 UTS namespace，移除 capabilities，并使用 `--new-session` 和 `--die-with-parent`。

用私有视图内的字面绝对路径启动可执行文件，参数向量跟在 `--` 后，cwd 固定为 `/workspace`。适配器接受通过管道传入的 stdin 字节。描述符 0–2 仅承载受控标准流。bwrap 的专用状态描述符在 payload exec 前关闭，stdout 和 stderr 均不作为状态。适配器没有 PTY、调用方环境或 Shell 后台接管输入。relay 使用适配器配置的环境从宿主控制目录启动。使用 `--clearenv` 清理环境，再设置私有 `PATH`、`LANG`、`HOME`、`PWD` 和临时目录变量，同时清除共享 relay 的宿主临时路径。把所有中止理由转换为普通取消。

无效启动输入在启动 relay 前拒绝。namespace 建立或镜像内 exec 可在启动后失败，并返回未确认结果。任何失败均无宿主回退。已确认的非零退出也是已确认的 payload 结果。保留回执协议的中断和未知结果。缺失、不可读或不匹配的回执不能授权重试。进程单元为空仅证明进程已停止。重放依据选定 Runtime 的持久执行状态和现有对账策略。依赖 payload 从未启动的判断须有明确的执行前证据。

## 持久 cgroup 身份与停止证明

### 资源身份与启动顺序

现有 provision request 锁串行化分配、启动、恢复和停止。为新建且符合要求的 intent 在委派根下创建 leaf，名称由 provision request 摘要导出。同名目录已存在时拒绝。检查 cgroup v2 类型、domain 模式、`cgroup.procs` 和 `cgroup.events` 可读，以及 `cgroup.procs` 和 `cgroup.kill` 可写。

使用版本 3 的本地资源句柄。保留现有宿主、boot、PID/time namespace 和请求身份，关联 provision request、Runtime 实例、lease epoch 及 Workspace 代次。加入规范化的委派根、cgroup namespace 以及根目录和 leaf 的内核文件系统对象身份。先将同一份句柄写入经 fsync 的本地登记，再返回给 Broker 持久化。重试复用已记录的句柄。新版登记编码为版本 2，要求版本 3 句柄。版本 2 句柄继续使用版本 1 登记编码。拒绝混用。登记同步前遗留的目录由运维检查，不按名称接管。状态缺失或冲突时保留原绑定围栏。

provisioner 记录 `LAUNCHING`，检查准确的单元，再按字面 argv 启动固定的本地 shell trampoline。它将自己的 PID 加入单元，并通过 Broker 的 stdin 管道等候启动行。Broker 在同一资源锁下重开原单元并核验身份，观察该存活 PID 已加入，持久化 `REGISTERED`，然后先通过 stdin 发送启动行，再发送现有启动信封。trampoline 收到启动行后才 exec 配置好的 worker。EOF、迁移失败或归属不符均不能授权 exec。若崩溃留下 `LAUNCHING`，继续阻止恢复，因为尚未登记的 trampoline 仍有可能正进入单元。接管就绪 worker 时重新检查单元与存活 worker 的归属。已登记或退休的身份不启动新的 worker。

### 停止与恢复

现有 Broker drain 先封住新执行并保留绑定的操作权限，再调用 provider。版本 3 的整绑定终止 drain（包括资源 drain 和存储退休）对 Broker 开始 drain 时仍持有的 member 使用现有的证明优先分支。要求工作已结算，在释放 Session 或 member 前持久化停止回执。尚无回执的 stopped-only 路径仍要求匹配的 worker 缺失证据。在内核 I/O 前重新验证 drain claim 和相关生命周期权限。过期 claim 无法提交回执或清除 member。迟到的停止可留下以后能复用的本地停止事实。版本 3 由 provider 持有原登记的锁，重新打开记录的准确单元。核验目录描述符绑定的身份，通过相对路径以 no-follow 打开文件。kill 文件以写方式打开，禁止创建或截断，从而防止同名替代单元接收 kill 或提供证据。核对登记身份后，若单元中还有进程，向 `cgroup.kill` 写入 `1`，在时限内等待内核在 `cgroup.events` 中给出递归的 `populated 0`。确认原 worker 已退出。写入成功或 PID 不存在均无法单独证明停止。尚无证明时，单元不可读、被替换、缺失或仍有进程均保留 storage holder，并返回停止未确认。观察可独立证明 journal 丢失。worker 已不在且原单元已经为空时，观察可持久化停止事实并返回两份证据，不发送信号。单元仍 populated 或无法验证时不给出 writer 停止证据。

只有验证单元为空且 worker 已退出，或满足现有可信整机重启证明，才在登记锁下持久化 `RETIRED`。版本 3 的这一状态是原单元停止的持久证据。持久化后尽可能删除已验证为空的 leaf。删除后的重试使用已保存的证明。确认可信重启后，不能打开或操作新 boot 下的同名单元。同一 boot 下缺少已保存的证明时，离线运维需核验同一个原单元，且要求它已经为空。观察、接管及无效 ready 信封的清理都须具备已验证的证据才能写入版本 3 的 `RETIRED`。重开的退休状态可为现有 LOST 对账规则提供停止证据。已经进入 LOST 的绑定继续使用该恢复路径和其执行结算规则。单元仍有进程时，隔离的运维恢复须先停止原单元再做证明。通过已验证 LOST 恢复进入 RELEASED 的版本 3 绑定，可用精确的停止与丢失证据满足后续资源 drain 重试。即使当前配置缺失，维护路径仍使用已保存的句柄。

复用已有 Broker 回执、代次校验、回执持久化与受围栏约束的 Session/member 释放事务。版本 3 的退休 transport 尾部只核实已无 member。可信部署中的 Harness 活进程 detach、普通回合 handback 和停放沿用活 owner 规则，其成功确认独立于 Worker 的退休证明。隔离 Hosted Session 的存活交还使用下文的核验规则。

回执携带原 provision request 的精确持久句柄。如果 SQL 尚无句柄且 Worker 从未获准启动，则使用锁内原 intent。启动和停止复用公开 API 与 TypeScript 启动信封。canonical V1 catalog 将本地版本 3 绑定纳入索引中的恢复候选，并按现有 V1 策略初始化新的开发 catalog。内核确认单元为空只能证明停止。journal 丢失、工具结果未知与重放继续遵循现有门禁。

## Hosted 选择、配置与资格验证

显式配置 `qwen.managed-agent.runtime-broker.provider-options.private-rootfs` 启用此能力。该选项指向部署方管理的规范绝对镜像路径，镜像提供可执行的 `/bin/sh`。它要求规范的 `/usr/bin/bwrap`、现有 `qwen.managed-agent.runtime-broker.provider-options.cgroup-root` 选项、持久的 local-process provider、Linux、非特权服务账号和 Session 独占。同时要求关闭结果发布、可执行扩展、子 Workspace、子 Agent 和网页终端。首个版本支持未配置模型侧扩展、Hook、MCP、客户端文件、Skill 或进程服务的内置 Agent。不符合条件的本地位置收到类型化拒绝。外部和 SSH 位置保持独立能力，不宣称提供本隔离保证。Broker 进程运行期间该设置不可变，本阶段以 Bubblewrap 0.8.0 验证。部署切换前必须暂停准入并清理现有本地 Runtime 租约。镜像、Workspace 挂载源和可执行文件遵循上述部署信任边界。

配置启用后，新建本地内置 Agent Workspace Session 在 Workspace 创建锁内将 `hosted-workspace-confined-shell/1` 写入现有 profile 字段，并拒绝不满足的先决条件、非根 cwd 或可选工具配置。该 profile 由内置准入逻辑决定。控制面只为符合条件的本地 Workspace 与保存的隔离 profile 选择保留的能力摘要。现有普通 Session 保留原 profile。启用期间，匹配本地部署范围的已有普通 Session 仍可恢复及清理原工作。新的预热、获取、预留与分派均要求保存的隔离 profile。关闭启用配置后，隔离 Session 无法预热或获取普通替代 Runtime。持久化作用域和 Worker 启动及证明与普通、外部、SSH、驻留和扩展模式分开。普通能力之间的绑定兼容规则不适用于此能力的双向切换。现有数据库 schema 已支持该 profile 名称。

携带版本 3 句柄的本地登记将私有根配置与原 cgroup 身份一起记录，包括镜像的规范路径、镜像和固定 Bubblewrap 二进制各自的设备及 inode 身份，以及协议版本。首次登记使用当前配置。读取已有登记时按原配置重建句柄，并与 Broker 句柄比较。启动与证明使用相同的配置。服务端与 Worker 在启动、收养和准入时比较当前配置与记录。镜像内容的不可变性由部署方在绑定生命周期内保证，路径身份用于发现对象替换。

启用隔离的绑定要求版本 3 cgroup 句柄才可启动。隔离请求缺失版本 3 句柄时禁止使用旧的 PID 停止路径。位置准入需要验证 Workspace 的存储身份。现有绑定和新绑定的准入均比较解析所得的作用域。清理使用已保存的作用域和原 cgroup 句柄，配置变更后仍可执行。

部署配置通过可信启动协议进入 Worker。Worker 结合能力、配置和 Workspace 根验证身份，并在证明成功前执行有时间上限的隔离空操作来验证 Bubblewrap。ready 记录只发布控制端点。Worker 仅在证明请求通过认证且身份匹配时返回精确的资格错误，Java 传输层保留该错误。资格失败时上下文安装和工具准入均保持关闭。验证失败返回 `managed_runtime_confinement_unavailable`，并保持绑定的所有权约束。后续启动失败也不会改用普通执行器重试同一命令。

## 工具准入与结果

Hosted Connector 在创建、加载与恢复时传递已保存的隔离 profile，包括禁用启动后。活跃附件的 Harness 只启用 v2 前台 Shell 结果通道，并在预热和工具准入前核对 Broker 的确切能力。Harness 与 Java 独立识别该 profile，并纳入生命周期 v2 协商。清理附件不预热，也无需探查当前启动能力。控制面门禁和封闭的 Worker 路由也约束旧 Harness，阻止选定 Runtime 降级。清理和取消沿用保存的作用域，准入不扩大。模型只看到 Shell 声明，其他名称在分配执行预留、解析可扩展工具或执行宿主辅助操作之前被拒绝。Broker 与选定 Worker 在分派前独立执行允许清单，包括直接提交的 Tool v2 请求。保存的 Session 必须位于根目录 "."。Shell 不接受选择目录、后台或监控模式。Harness 为隔离路径关闭文件历史的绑定和恢复，也不读取项目指令文件。前台 Shell 继续使用保存的审批模式（default 或 auto-edit）、审批提示和仅 owner 可答复审批的规则。该模式不提供 Plan 或动态审批切换。准入时不支持的操作返回 `managed_runtime_confinement_denied`。请求未声明的 Worker 端点时沿用原有的路由未找到响应。

隔离 Worker 只开放证明、安装、激活、Tool v2 执行、结果、取消及确认路由。激活路由的 release 操作关闭逻辑 Session，无需发起 Provider 请求。Provider 分派、Tool v3/v4、文件及撤销、MCP、Hook、后台及发布、扩展、Monitor 和终端等路由不能在隔离 Worker 执行，也不能为该 Session 切换到其他 Worker 执行。Worker 通过 Bubblewrap 让固定的 `/bin/sh -c` 作为新 PID namespace 的 PID 1 执行。Bubblewrap 等待该 namespace 的 init 退出才报告关联状态，Linux 在退出过程中收割该空间的剩余进程。Worker 保留有界的 v2 输出，仅在结果确认后回传。普通非零退出码属于 Shell 结果。若在交给启动器前已确定拒绝，可用已有的 v2 settled 响应承载类型化的未启动结果。中断、缺失或不可读且无法排除已执行的结果进入已有的未知状态，不得重放。启动器的原始诊断不会回传。

后续开放文件等其他操作时，从冻结的准入结果取得读写模式，将获准的 Workspace 相对路径映射到私有视图，并从不可变镜像选择受信文件 Worker 和解释器。准入与路由审查需覆盖 `Config.includeDirectories`、文件历史和撤销、工具准备、checkpoint、恢复及可执行扩展初始化。继续拒绝尚未支持的 Hook、MCP、扩展和 LSP，并为每种支持的部署验证实际镜像与工具链。类型化拒绝应帮助运维修复配置或将输入移入 Workspace，同时避免泄露宿主路径。

## Session 交还与回收

正常回合可以通过存活路径释放挂载。Runtime Session 进入 RELEASING，原 Worker 通过认证关闭该 Session 的工具和激活准入，并确认没有待启动、执行中、结果未知或未能确认 PID namespace 已收割的命令。Broker 还要核对原注册身份，并读原描述符对应的 cgroup，原 Worker 不是唯一直接成员或存在子组均拒绝释放。另一个回合仍在运行时也可能因此拒绝。该核验补充 Session 封门和各命令的 PID namespace 证据。所有权事务锁定绑定和 Runtime Session，比较带版本的确切句柄、代际和处于 `RELEASING` 的 owner 后，再清除该成员。执行仍活跃或未知、身份缺失或变化、发现额外成员，或者 Worker 未应答，都保留所有权。对恢复阻塞后的仅挂载交还返回 `workspace_writer_unproven`，Runtime Session 保持 active 或 RELEASING，直到取得原身份的证明。

终态清理刷新匹配的 claim，停止原文件描述符绑定的 cgroup，验证 `populated 0` 和记录的 Worker 已消失，持久化回收后生成已有回执。事务校验绑定、代际、申请和句柄后释放所有权。UNKNOWN 执行可阻塞正常清理，已 LOST 且仍有进程的 cgroup 则遵循现有的受围栏停止及恢复流程。其匹配的 JOURNAL_LOST 与 WRITERS_STOPPED 是证明原组已停止的现有替代证据。停止无法确认时保留所有权，并返回 `workspace_close_stop_unconfirmed` 或已有的类型化身份及恢复错误。同名替换组不能作为旧组已清空的证明，也不能使用旧 claim 杀掉替换组。

## 验收

### Core 私有根

在 Linux 上以非 root Worker 身份，使用非 setuid 的 Bubblewrap 和静态 BusyBox，对编译后的 Core 适配器和 relay 运行定向单测及 `node --test scripts/tests/managed-private-root-bwrap-linux.test.mjs`。记录发行版、内核、架构及 Bubblewrap 版本。前提缺失或测试跳过时不能通过验收。

- 用双向 Workspace 读写正向对照核对同级和宿主哨兵不可见，覆盖绝对和相对符号链接。检查镜像和 Workspace 的只读模式、每次启动的新 tmpfs、固定 cwd 和环境、管道输入和已确认的非零退出。在两种 Workspace 访问模式下拒绝直接及符号链接别名重叠。
- 使用测试自行启动且在沙箱检查前后都存活的外部进程。先验证信号 0 探测和同一客户端可以连接外部监听端口，随后要求私有根内的隔离断言已确认成功，且外部监听端没有收到该连接。检查父环境哨兵不可见、payload 无法写入状态描述符，并用可创建 user namespace 的外部正向对照验证内部禁止嵌套。
- 观察 payload 的启动标记后再发送带后台接管理由的中止信号。启动和结算等待均设时限。要求结果为取消、回执为中断，无后台接管，且 relay 控制目录已清理。该结果验证执行器本地取消与清理。
- 缺少启动器时拒绝启动。用合格环境中的正常 payload 和可写入标记的宿主可执行文件作正向对照，验证镜像内缺少可执行文件或 namespace 不可用时没有已确认的退出或 payload 标记。单独运行 namespace 拒绝场景并核对内核或 bwrap 的启动诊断。以相同隔离设置核对前后的公开 `serve` 沙箱拒绝。

该项验收覆盖受测的执行器配置。Hosted 接线、Broker 的停止与恢复及其他部署工具链各自需要对应的验收。

### Broker 停止与恢复

使用专用测试 cgroup、真实 Linux provisioner、Broker 和 Workspace transport，并在隔离 MySQL catalog 中检查原 Session 的 execution storage key 和物理 member 数。

- 验证 Worker 与创建独立 Session 的测试后代在执行前入组。强制杀死 Worker 后，确认后代仍存活、原组仍 populated，并由新 provisioner 重开原登记。单独观察 PID 消失时保留 holder。
- 将另一个活动 cgroup 覆盖挂载到原单元路径，验证两个单元都不被终止，且无回执、无 holder 释放。恢复原路径后，原组经停止、证空后才记录回执并释放原 holder。同级对照进程应继续存活。
- 验证存活 Worker 的终态 drain 在交还前经过同一证明门禁、删除原组后的幂等重试、实际加入失败或 gate EOF 时 Worker 没有副作用，以及旧持久登记兼容性和迟到停止结果的 claim 围栏。记录环境限制。

### Hosted 端到端

- 配置未启用时沿用当前 Hosted 选择和结果契约。不符合条件的位置或不满足的先决条件无法使用隔离绑定执行，也不能回退到普通 Worker。
- 在真实 Linux 私有镜像和 cgroup v2 环境中，符合条件的选定 Hosted Runtime 执行前台 Shell，可读写自己的 Workspace。宿主、其他 Workspace 哨兵文件、宿主环境和网络均不可见。证明脱离的后代进程已经启动并关闭继承的标准流，同时证实它在命令确认返回时已退出。另验证资格失败时拒绝执行。普通非零退出、准入拒绝与执行不确定可区分。
- Harness、Broker 与 Worker 均拒绝不支持的工具、cwd、后台执行和替代执行路由。复用或过期身份无法跨能力、代际或配置变化获得准入。
- Worker 死亡并且 cgroup 还有成员时，提前交还无法清除 holder。终态前提满足时 Broker 独立证明停止。另验证 UNKNOWN 记录保持所有权，缺失或已替换的 cgroup 不能为原句柄生成回执。
- 单独验证启用期间既有普通 Session 可以恢复原工作，但无法取得新的执行资格。冷重启禁用配置后，隔离 Session 的新执行应被拒绝，清理仍使用原 cgroup 身份。
