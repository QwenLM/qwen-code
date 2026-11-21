# Managed Agent 的私有根 Bubblewrap 执行

[English](2026-11-21-managed-private-root-bwrap.md) | [简体中文](2026-11-21-managed-private-root-bwrap.zh-CN.md)

## 问题与现状

[#15081](https://github.com/QwenLM/qwen-code/issues/15081) 要求约束 Workspace 的文件系统和进程访问，能够解释拒绝原因，并由运维主动启用。[#12380](https://github.com/QwenLM/qwen-code/issues/12380) 将 Workspace 副作用和未知结果的处理交给选定 Runtime，并为不可信部署保留独立验收。[#15163](https://github.com/QwenLM/qwen-code/pull/15163) 选定显式启用的 Linux local-process 档案，要求有私有文件系统视图和 Broker 可观察的停止证据。

在 `0cfbdac07b`，Core 现有 bwrap 执行器使用 `--ro-bind / /`。它限制写入，但除特定遮蔽路径外，仍可在宿主权限允许的情况下广泛读取 Workspace 以外的路径。当前 Hosted 文件和前台 Shell 路径使用 worker 权限，serve 拒绝公开的执行沙箱设置。local provisioner 已有的 Linux cgroup 停止回执仅用于 Managed 扩展档案，且需要从存活的 Runtime 取得证明。尚未关闭的 [#14667](https://github.com/QwenLM/qwen-code/issues/14667) 跟踪持久进程约束及 worker 死亡后的 Broker 核验。

## 本次交付及前提

本次交付内部私有根执行器，以及通过编译后的 Core relay 驱动它的真实 Linux 检查。本次由验收用例调用该执行器。设置与协议保持原状，CLI、ACP 和 Hosted 沿用现有路径。这份内部契约允许项目独立验证文件系统与启动边界，同时继续推进 Runtime 与 Broker 工作。

部署端控制根镜像、bwrap 二进制、解释器、relay、状态目录和 Workspace 挂载源。部署端须保证源路径的完整解析链保持稳定，包含其上级路径，并在运行期间保护预置镜像不被修改。与 worker 共用 UID 的宿主进程属于信任边界，因为它们可访问宿主控制文件及回执。独立构建镜像，排除宿主凭据和其他 Workspace 数据。在整个执行期间，两个挂载源目录树都必须排除子挂载、设备节点、通向外部服务的路径型 socket，以及源目录树之外文件的 inode 别名。导入 Workspace 时须把外部文件复制到独立 inode。部署端必须对所有可修改 Workspace 的宿主写入者维持这些约束。执行器检查启动输入，挂载源的配置及持续约束由调用方负责。

## 执行契约

在 Core 现有 bwrap 适配器旁新增内部入口 `executePrivateRootBwrap`。接收显式指定的绝对路径，包括 rootfs、Workspace、安装和状态目录，以及 Workspace 访问模式。复用打包的 bwrap relay 以及现有路径、临时目录、回执和清理检查。拒绝非 Linux 环境及 root worker、相对路径或非目录 rootfs，以及缺失、指向符号链接或非空的镜像挂载点。按规范路径检查相等及双向父子关系。在两种访问模式下都拒绝 Workspace 与镜像、安装、状态或启动器目录重叠。对镜像与受保护的宿主目录执行相同检查。使用部署端拥有的、规范化绝对路径对应的非 setuid 和非 setgid bwrap 启动器。

仅挂载只读镜像到 `/`、按准入模式挂载选定 Workspace 到 `/workspace`、私有 tmpfs 到 `/tmp`，以及 bwrap 的最小 `/dev`。镜像为后三个挂载点提供空目录。视图内没有 procfs，也没有宿主家目录、安装目录或状态目录的挂载。显式启用私有 user namespace 并禁止嵌套 user namespace，使用独立 PID、network、IPC 和 UTS namespace，移除 capabilities，并使用 `--new-session` 和 `--die-with-parent`。

用私有视图内的字面绝对路径启动可执行文件，参数向量跟在 `--` 后，cwd 固定为 `/workspace`。适配器接受通过管道传入的 stdin 字节。描述符 0–2 仅承载受控标准流。bwrap 的专用状态描述符在 payload exec 前关闭，stdout 和 stderr 均不作为状态。适配器没有 PTY、调用方环境或 Shell 后台接管输入。relay 使用适配器配置的环境从宿主控制目录启动。使用 `--clearenv` 清理环境，再设置私有 `PATH`、`LANG`、`HOME`、`PWD` 和临时目录变量，同时清除共享 relay 的宿主临时路径。把所有中止理由转换为普通取消。

无效启动输入在启动 relay 前拒绝。namespace 建立或镜像内 exec 可在启动后失败，并返回未确认结果。任何失败均无宿主回退。已确认的非零退出也是已确认的 payload 结果。保留回执协议的中断和未知结果。缺失、不可读或不匹配的回执不能授权重试。进程单元为空仅证明进程已停止。重放依据选定 Runtime 的持久执行状态和现有对账策略。依赖 payload 从未启动的判断须有明确的执行前证据。

## 后续 Hosted 交付

1. 在准入首个 payload 前要求具备 #14667 的持久 cgroup 身份及 Broker 可观察的空证明契约。将单元绑定到选定 Runtime 实例、epoch 和绑定代次。关闭时先阻止该 Runtime 接受新执行，再由 Broker 检查原单元。单元缺失、被替换、无法读取或仍有进程时保留 holder。
2. 为 Linux local-process 准入由部署端配置且默认禁用的档案。在执行 payload 前，将资格与不可变策略绑定到选定 Runtime 和 Workspace 代次。让所有准入操作使用等效约束，并从冻结的准入结果取得各操作的读写模式。梳理准入和路由时覆盖 `Config.includeDirectories`、文件历史及撤销，以及接触磁盘的工具准备、checkpoint 和恢复路径。对不支持的 Hooks、MCP、扩展、LSP 等可执行路径在准入时拒绝，覆盖相关初始化路径。运行文件 worker 和 Shell 前，将准入的 Workspace 相对路径映射到私有视图。受信文件 worker 及其解释器从不可变镜像选择。按支持的部署验证实际运行镜像及其工具链。
3. 通过 Broker 和工具结果投影有类型的 `confinement_unavailable`、`confinement_denied` 和 `confinement_stop_unconfirmed`。给运维足够的信息修复部署或将声明的输入移到 Workspace，同时避免泄露宿主路径或把任意命令退出码误判为策略拒绝。禁用档案时沿用可信部署行为。

## 验收

运行定向 Core 测试，并在安装非 setuid bwrap 和静态 BusyBox 的 Linux 上以非 root worker 身份，对编译后的适配器和 relay 运行严格验收用例。用可读取的正向对照验证两个 Workspace 方向，确认看不到对方和宿主标记，覆盖符号链接。检查镜像和 Workspace 的只读行为、私有临时文件、固定 cwd 和环境、管道输入与已确认的非零退出。在两种 Workspace 访问模式下均拒绝直接重叠及经符号链接形成的重叠。用测试自行启动且在沙箱检查前后都存活的外部进程作对照，仅用信号 0 探测。先用同一个客户端连接外部监听端口。要求 payload 的内部断言以已确认的成功退出结束，且外部监听端未收到内部连接。确认父环境测试变量不可见、payload 无法写入状态描述符，并用可成功创建 user namespace 的外部正向对照验证内部禁止嵌套。先观察 payload 写入的启动标记，再发送带后台接管理由的中止信号。启动与结算等待均有时限。要求回执为中断、结果为取消且未发生后台接管。这是取消路径的本地回归证据。验证缺少启动器时拒绝启动，缺少镜像内可执行文件或 namespace 不可用时均不会产生已确认的退出或 payload 标记。使用能在合格环境中执行的 payload 和能写入标记的宿主可执行文件作正向对照。单独运行 namespace 拒绝场景，并要求出现内核或 bwrap 的启动诊断。使用相同的隔离设置核对变更前后的公开 serve 沙箱拒绝。记录发行版、内核、架构和 bwrap 版本。缺少前提的运行不会通过验收。结果仅验证受测的执行器配置，Hosted 部署、动态工具链及 Broker 停止与恢复仍待验收。
