# 常驻 Workspace 配置

[English](README.md) | [简体中文](README.zh-CN.md)

首版配置为每个租户/Workspace 保留一个 Pod/PVC，通过公开 files 配置支持
Read、Write 和 Edit。Session 关闭会结算并撤销原上下文，下一个 Session 保留
同一文件和运行环境。此方案不安装节点 collector，也不自动删除或复用存储。
本目录尚未在 ACK 部署或验收。

运行环境已通过 PR #14340 在主干实现。简化后的 PR #14758 说明本部署边界。
常驻路径独立于已从 #14758 撤出的节点证据候选和已关闭的安装提案 #14761。
可选的显式空闲退役由 #14765 实现，使用方式见下文。本配置不需要 Go 工具链、
定制 containerd/shim、节点 collector 或冷启动安装。

## 可信平台与支持的存储

信任管理员、Kubernetes 控制面、宿主机和已完成资格验证的 CSI 驱动，保留既有
tenant/actor、Workspace generation、原运行环境和 mount 检查。本配置不独立证明
宿主机持续受控。支持的驱动为 `diskplugin.csi.alibabacloud.com`，要求
`ReadWriteOncePod`、`Filesystem` 和 `ext4`，注册磁盘 serial 必须与实际挂载设备
一致。其他驱动或访问模式需要独立设计和验收。RWOP 不授权节点故障后的存储交接。

## 配置与安装

将 `application.example.yaml` 作为额外的 Spring 配置文件，另外提供现有数据库、
Hosted Harness、Session store、Broker token 和凭据加密配置。Kubernetes token
和 CA 配置指向服务端读取的本地文件，凭据不应写入此模板或 worker Workspace。

Session store 的全局 `workspace-id` 必须与 Broker 的全局 `workspace-id` 像示例中
一样保持相等，这是现有 Hosted 启动契约的要求；各公开 Workspace 仍解析自己的注册身份。

启用映射前，使用现有注册 operator 登记精确 CSI registration，并在 Workspace
registry 登记匹配的租户/Workspace、代数和存储。Workspace config/policy 分别
使用 `managed-runtime-tools/1` 和 `preapproved-workspace-tools/1`，再给可信
actor 授予 OPERATOR 或 OWNER。每个物理卷只能出现在一条常驻映射中。单有
注册信息或调用者提供的 Workspace ID 不会启用 CSI 执行。

使用现有 Java 保护 operator 的 `<reviewed-registration-json>
<policy-name> <binding-name>` 命令生成精确存储及命名空间保护对象。命令只打印
Kubernetes JSON List，不访问集群或数据库。在 server 包目录中调用已构建的
operator：

```bash
java -Dloader.main=com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiProtectionMain \
  -cp target/qwen-managed-agent-server-0.1.0-alpha-csi-runtime.jar \
  org.springframework.boot.loader.launch.PropertiesLauncher \
  /absolute/path/registration.json resident-protection resident-binding
```

在另外授权安装后，钉住实际 namespace、policy、binding 的 UID 和代数。使用不可变
镜像摘要，镜像包含 Node.js 22 或更新版本及构建后的 CLI。CSI 文件路径使用 Node
文件系统 API，并读取 Linux `/proc/self/mountinfo`、`/proc/self/fd` 和卷的
`/sys/dev/block/<major>:<minor>/device/serial`；UID 1000 必须能够访问这些位置。
command 只包含执行程序和 CLI 路径；provisioner
会追加 `managed-runtime-worker --container-boot` 和 boot 文件路径。可选产物
ConfigMap 必须不可变并显式钉住身份。

服务端需要访问 Kubernetes API 和原 Pod 的 worker 端点。worker 以 UID/GID
1000 运行，根文件系统只读，不添加 Linux capabilities，不带 service-account
token，固定 PVC 挂在 `/workspace`，临时目录使用 emptyDir。Pod 使用
`restartPolicy: Never`。原 Pod 缺失、重启或被替换均保持准入关闭；本版不会
重建或接管替代 Pod。

使用现有公开 Workspace Session API 创建和关闭 Session，同一 Workspace 只
准入一个未完成 Session。关闭成功后才能启动下一个。释放超时或结果未知会保留
reservation 并阻止切换。每个 Session 的 cwd 固定，可在下一 Session 创建时
选择其他目录。本版不支持 Shell、MCP、Hooks、共享运行环境的子 Session 或
原地 cwd 变更。

## 显式空闲退役

正常 Session 关闭后 Workspace 仍可复用。退役空闲 Workspace 时，使用私有 Java
维护入口，加载相同部署配置、数据库和 Runtime 凭据密钥。先通过正常服务升级
执行当前 schema 迁移，并封锁旧 Server/Broker 二进制。维护命令只验证目录，不迁移。

创建有界请求文件，只指定原 scope 和当前具有 Workspace `OWNER` grant 的授权
审计 actor：

```json
{
  "tenantId": "tenant-a",
  "workspaceId": "workspace-a",
  "workspaceGeneration": 1,
  "actorId": "owner-a",
  "retirementId": "retire-workspace-a-1"
}
```

操作者须已控制可信维护主机及部署凭据；actor 字段本身不认证身份。在 server 包
目录中使用既有 fat jar 和配置：

```bash
java -Dloader.main=com.alibaba.qwen.code.managedagent.persistence.ResidentWorkspaceRetirementMain \
  -cp target/qwen-managed-agent-server-0.1.0-alpha.jar \
  org.springframework.boot.loader.launch.PropertiesLauncher \
  inspect /absolute/path/retirement.json \
  --spring.config.additional-location=file:/absolute/path/application.yaml
```

将 `inspect` 替换为 `begin`，原子拒绝新 Session、获取、激活、派发和恢复。它要求
Session 终结、journal head 封存或永久删除且 writer 已清除、Runtime Session 已释放、
执行已结算。保留原 binding/
active slot，存储保持 `RESERVED`。回复丢失后复用同一请求。查询只读，不访问 Kubernetes。

删除是独立显式命令，将动作和参数替换为
`delete-pod /absolute/path/retirement.json <observed-resourceVersion>`。它通过配置的
Kubernetes API 核验原资源，再记录带原 UID/resourceVersion 前置条件、30 秒宽限期
及 Background propagation 的正常 Pod DELETE。凭据留在已有 API/token/CA 配置中。
不删除 PVC/PV、Secret 或保护对象。同版本重试只读原结果，不重发；新版本需要
显式再次调用，总计最多八次。HTTP 回复和 Pod 缺失不会释放存储或重新开放 Workspace。
物理释放和复用延后。

即使 Kubernetes 已接受删除，回复丢失仍可能留下 `UNKNOWN`。原 Pod 一旦具有
`deletionTimestamp` 或已缺失，不同 `resourceVersion` 也不能授权再次 DELETE。
同版本重放仍只返回保留尝试，不访问 Kubernetes；使用 `inspect` 读取该回执。
最多八次的上限只允许在原 Pod 仍通过全部核验时显式发起尝试。

完整退役设计见[English](../../docs/design/2026-10-20-k2-physical-retirement-progress.md)
与[简体中文](../../docs/design/2026-10-20-k2-physical-retirement-progress.zh-CN.md)。
原生 ACK 退役资格验证继续待完成。

## 故障处理与验收

执行或释放结果未知时，保留其 Session 和 reservation，并拒绝下一个 Session。
原 Pod、容器或 mount 缺失或变化时，Workspace 保持不可用。lease 到期、运维检查
或 Kubernetes 对象缺失都不能清除物理 owner 或授权创建替代 Pod。正常空闲边界的
应用/Broker 重启可使用保留数据库和原 worker；这不代表被中断的 Turn、过期 writer
或丢失 Pod 的恢复已经合格。

声明部署验收前，完成以下验证：

1. 在 A 中执行 Write/Edit/Read，关闭 A，再由 B 读取。核对精确文件字节，以及
   不变的 Pod/container、binding generation、PVC/PV 和 reservation。确认 A 的
   旧上下文拒绝激活和派发，binding 保持 READY，存储保持 RESERVED。
2. 在真实 MySQL 上验证不同键并发创建及同键重放，只能准入一个未完成 Session。
   使用受控 peer 验证释放响应丢失和 UNKNOWN 执行：占用必须保留，结果不确定的
   副作用不能重复。
3. 在空闲边界重启实际应用/Broker 进程，保留数据库和 worker。确认接管原运行环境，
   不新建 Pod。另行验证缺失或变化身份被拒绝。
4. 在独立的空闲退役边界开始维护，确认拒绝新 Session 和 Runtime 工作。仅以
   观察到的原 UID/version 删除原 Pod，测试回复丢失和同版本重试，并核验封锁、
   active slot 及原存储 reservation 均保留。

每次记录源码提交、环境、原身份及观察结果。组件/H2、MySQL、独立进程与 ACK
证据分别记录。这些部署检查继续标为待完成。既有历史夹具不作为新部署的验收证据。

Session 关闭后常驻资源继续产生正常的 Pod、节点和存储费用。此模板不授权云上
安装、付费资源创建或手工物理销毁；这些动作使用另外批准的部署或维护方案。
失败和验收边界见[设计](../../docs/design/2026-10-14-k2-resident-workspace.zh-CN.md)。
