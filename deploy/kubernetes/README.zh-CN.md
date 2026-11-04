# 在 Kubernetes 部署 Managed Agent

[English](README.md) | [简体中文](README.zh-CN.md)

这个实验性 Helm chart 安装签名认证的 Managed Agent API、同 Pod 的私有 Hosted
Harness，以及使用持久卷的 MySQL 8.4。提供镜像和模型配置后，一条 Helm 命令即可安装
整套服务。默认支持文本 Session；可选配置增加可信单节点 Workspace 文件、前台
Shell 和 Managed WebShell 网关。K2 CSI provisioning 仍是独立部署。

## 前置条件

- Kubernetes 1.28 或更新版本、Helm 3.18 或更新版本、kubectl，以及可创建 workload、
  Service、ConfigMap、Secret 和 PVC 的 namespace。
- 支持 ReadWriteOnce 的默认 StorageClass，或显式指定
  `mysql.storage.className`。数据库卷默认申请 10 GiB。
- 容器构建工具和集群可访问的镜像仓库。两个应用镜像必须来自同一经过评审的源码
  revision，并匹配节点 CPU 架构。不假设已有公开发布的 Managed Agent 镜像。
- OpenAI 兼容模型 endpoint、模型 ID 和 API key。

默认应用 Pod 总计申请 500m CPU 和 1 GiB 内存；MySQL 额外申请 250m CPU 和 512 MiB
内存。资源 requests 和 limits 可在 [values.yaml](chart/values.yaml) 配置。
应用无需 Kubernetes API 权限，不挂载 service-account token。

## 构建镜像

在仓库根目录执行。替换镜像仓库并选择集群平台；示例构建 Linux amd64 镜像：

```bash
QWEN_K8S_REV=$(git rev-parse HEAD)
QWEN_K8S_REGISTRY=registry.example.com/team
docker buildx build --platform linux/amd64 --push \
  -f packages/managed-agent-server/Dockerfile \
  -t "$QWEN_K8S_REGISTRY/managed-agent:$QWEN_K8S_REV" .
docker buildx build --platform linux/amd64 --push \
  -f Dockerfile \
  -t "$QWEN_K8S_REGISTRY/qwen-cli:$QWEN_K8S_REV" .
```

在 checkout 外准备部署 values 文件。使用上面的真实镜像地址，优先采用不可变镜像
摘要：

```yaml
server:
  image: registry.example.com/team/managed-agent@sha256:<server-digest>
harness:
  image: registry.example.com/team/qwen-cli@sha256:<cli-digest>
model:
  id: <provider-model-id>
  baseUrl: https://provider.example/v1
```

私有仓库增加 `imagePullSecrets: [{name: registry-credentials}]`，并在安装前在部署
namespace 创建对应仓库 Secret。每次升级的两个镜像都应来自同一源码 revision。

启用 LOCAL Workspace 工具时，从上述精确的两个镜像构建第三个镜像。它将 Java
JAR/JRE 与 CLI 镜像中的 Node.js、bundled worker 和 Linux 文件系统工具组合。
三个镜像的 CPU 架构必须相同：

```bash
docker buildx build --platform linux/amd64 --push \
  -f deploy/kubernetes/runtime.Dockerfile \
  --build-arg SERVER_IMAGE="$QWEN_K8S_REGISTRY/managed-agent:$QWEN_K8S_REV" \
  --build-arg HARNESS_IMAGE="$QWEN_K8S_REGISTRY/qwen-cli:$QWEN_K8S_REV" \
  -t "$QWEN_K8S_REGISTRY/managed-agent-runtime:$QWEN_K8S_REV" .
```

Runtime 镜像在构建时检查 `java`、`node`、bundled CLI 入口和原生 `stat`。
启用工具时，将 `server.image` 指向此组合镜像。默认文本模式继续使用较小的 Java
镜像。WebShell 使用匹配的 CLI 镜像，其中需包含构建后的静态资源和
`qwen serve --managed-web-config` 命令。

## 安装

将模型 API key 写入私有文件，不包含 shell 引号，权限限制为 0600。然后在仓库根目录
执行：

```bash
helm upgrade --install managed-agent deploy/kubernetes/chart \
  --namespace qwen-managed-agent --create-namespace \
  --values /private/managed-agent-values.yaml \
  --set-file model.apiKey=/private/model-api-key \
  --wait --timeout 15m
```

首次安装时，chart 生成相互独立的签名、Session Store、Harness 和数据库随机凭据。
卸载时保留对应 Secret，后续安装和升级复用它。开启可选组件时仅补齐其缺失的键，
关闭组件仍保留已有全部键。升级时缺少受管 Secret 会失败；请恢复
原 Secret；保留数据库 PVC 却缺少 Secret 时，重新安装也会拒绝。不要重新生成数据库
密码或 journal 密钥。已有部署忽略 `model.apiKey`：
更新模型凭据需显式轮换 Secret 的 `model-api-key`，然后重启应用 Pod。

Helm 会将受管 Secret 内容保存到 release 元数据。若要独立管理凭据，设置
`credentials.existingSecret` 并省略 `model.apiKey`。该 Secret 必须已存在于 release
namespace，包含以下全部键：

| 键                          | 值                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `auth-signing-key`          | 至少 32 个 UTF-8 字节                                                                    |
| `session-store-binding-key` | 独立密钥，至少 32 个 UTF-8 字节                                                          |
| `harness-token`             | Java 与 Harness 共享的私有 bearer token                                                  |
| `capability-digest`         | `sha256:` 后跟 64 位小写十六进制字符                                                     |
| `mysql-password`            | 应用数据库密码                                                                           |
| `mysql-root-password`       | MySQL 初始化 root 密码                                                                   |
| `model-api-key`             | Provider API key                                                                         |
| `runtime-broker-token`      | `runtime.enabled` 时必需；私有 Broker bearer token                                       |
| `runtime-credential-key`    | `runtime.enabled` 时必需；32 个随机字节的 base64 编码                                    |
| `web-token`                 | `web.enabled` 时必需；至少 32 字节的独立浏览器 bearer token，不能等于 `auth-signing-key` |

Runtime credential key ID 固定为 `kubernetes-v1`；存在保留的 binding 时必须保留此
密钥。连接集群时，Helm 会检查已有自管 Secret 的必需键；离线 `helm template` 无法
读取它，Kubernetes 仍会在容器启动前要求所有引用的键存在。已有部署缺少凭据时，
不能用新随机值替换。
保留 Runtime PVC 却缺少 Runtime 密钥时，开启受管 Runtime 也会拒绝生成新值，要求
恢复原 Secret。

仅更改数据库 Secret 不会更改已有卷中的 MySQL 账号，数据库密码轮换需单独协调。
MySQL 初始化时授予应用用户数据库权限，以及 Flyway 启动探针所需的
`performance_schema.user_variables_by_thread` SELECT 权限。

ClusterIP Service 仅在 8080 暴露签名认证的公开 API。Harness 4170 和 Session Store
8081 都绑定 loopback。不启用无认证公开监听、LoadBalancer 或 Ingress。远程客户端
使用独立配置的 TLS ingress 或可信网关，并保留 API 签名；tenant 和 actor header
本身不能认证调用者。

## 启用可信单节点 Workspace 工具

此选项在一个显式信任的节点上运行现有 LOCAL 进程 Runtime。节点必须提供真实且非空
的 `/etc/machine-id`、Linux 进程和 namespace 身份，以及支持可靠目录 birth time
的持久存储。chart 将节点 machine ID 只读挂入服务端，不伪造主机身份，不申请
privileged 容器，也不委派 cgroup。集群策略拒绝此 hostPath 时，请保持关闭。

增加以下 values，使用上述组合镜像，并填写已批准执行主机的精确 Kubernetes Node
名称：

```yaml
server:
  image: registry.example.com/team/managed-agent-runtime@sha256:<runtime-digest>
runtime:
  enabled: true
  nodeName: <trusted-node-name>
  storage:
    workspaceSize: 10Gi
    stateSize: 1Gi
    className: <qualified-storage-class>
```

Node affinity 将调度固定到该节点，同时保留 scheduler 绑定 WaitForFirstConsumer
卷的流程。chart 保留两个 PVC：`/workspaces` 保存创建的 Workspace，
`/runtime-data` 保存私有 state 和 Runtime home；旧式 cwd 仍为 `/workspace`。
启动器创建 owner 私有的 state/home 子目录，将目录和文件分别恢复为 0700/0600，
拒绝符号链接、非普通条目和不同 owner。Kubelet 使用
`fsGroupChangePolicy: OnRootMismatch`，避免每次挂载都扩宽已有记录权限。SQL、
两个 PVC、凭据 Secret、节点身份和原文件身份共同构成一个部署；复制 PVC 内容到
其他主机不能授权接管。

安装后，以签名请求调用 `POST /api/agent/web-shell/v1/workspaces/create`，body 为
`{"displayName":"Project","idempotencyKey":"<unique-key>"}`。现有 API 创建目录、
验证并注册物理存储，再授予已认证 tenant/actor OWNER 权限。将返回的 `workspaceId`
用于 Session 创建请求的 `workspace.workspace_id`，不要手工写入注册或权限数据行。
下方 WebShell 选项提供同一流程。

该模式启用文件、前台 Shell、持久 Session 隔离和 verified Workspace recovery，
使用 `default` 询问式审批。在该策略下，Shell 命令需要审批响应；child agents 和 tool publication
保持关闭。后台 Shell、Monitor、command Hooks 和任意逃逸进程不在该模式的验收范围。
工具使用服务端账号的文件系统权限，可访问 Workspace 之外的路径，请用于可信工作负载。
前台 Shell receipt 路径不需要对象存储账号。

计划替换 Pod 或 Helm 升级前，必须关闭所有工具 Session，确认物理 close、journal
sealed，以及 storage/Runtime holder 已清空。请保留这一显式运维门槛；chart 不自动
drain Session。新 Pod 的 PID/time namespace 已改变，不能因节点和 PVC 不变就接管旧
LOCAL worker。干净升级后，应对保留的 Workspace 创建新 Session。意外 worker/Pod
丢失必须保留原来的不确定 effect 和准入 fence；重试或删除 SQL 行都不能授权重放或
伪造清理结果。

## 启用 Managed WebShell

可选网关只提供 Managed UI，并以一个固定可信 tenant/actor 对 Java 请求签名，不构成
多用户认证系统。可以独立开启，也可以与 LOCAL 工具一起开启：

```yaml
web:
  enabled: true
  tenantId: <trusted-tenant-id>
  actorId: <trusted-actor-id>
```

`web.image` 留空时复用 `harness.image`。网关使用独立 home 和临时目录，仅接收浏览器
token 和只读签名密钥文件，不读取模型 API key 或 Runtime/Workspace 卷。其配置只包含
loopback Java URL、固定 tenant/actor 和签名密钥文件路径；浏览器身份 header 不决定
调用者。普通 daemon Session、文件系统、Shell、设置、MCP、ACP 和 WebSocket 路由
均关闭。

转发浏览器端口：

```bash
kubectl -n qwen-managed-agent port-forward service/managed-agent 4171:4171
```

打开[本地 WebShell](http://127.0.0.1:4171/)，使用 Secret 中独立的 `web-token` 完成
认证。签名密钥留在服务端。启用 LOCAL 工具后，可通过 Managed UI 创建/选择
Workspace 和完成审批。使用外部 TLS ingress 时，在 `web.allowOrigins` 配置精确的
浏览器 origin，例如 `[https://agent.example.com]`；chart 本身不创建 ingress。

## 验证 Session

在一个终端转发 API：

```bash
kubectl -n qwen-managed-agent port-forward service/managed-agent 8080:8080
```

在另一个终端将签名密钥导出到私有临时文件，然后运行签名 smoke 客户端。
使用自管 Secret 时替换下方 Secret 名：

```bash
umask 077
QWEN_K8S_KEY_FILE=$(mktemp)
kubectl -n qwen-managed-agent get secret managed-agent-keys \
  -o jsonpath='{.data.auth-signing-key}' | openssl base64 -d -A > "$QWEN_K8S_KEY_FILE"
node deploy/kubernetes/smoke.mjs --key-file "$QWEN_K8S_KEY_FILE"
```

smoke 需要 Node.js 22 或更新版本。它验证无签名请求被拒绝、创建 Session、提交唯一
文本标记、等待模型 Turn 完成、核对 assistant 历史并关闭 Session。成功时以 JSON
输出 Session 和 Turn ID。它会使用已配置账号真实调用 provider。失败时报告 Session
ID，保留 Session 供检查，不重放结果不确定的输入。可使用
`kubectl -n qwen-managed-agent logs deployment/managed-agent -c server` 或
`-c harness` 查看日志。默认超时 120 秒，可用 `--timeout-ms` 调整。

验证空闲持久化时，第一次为 smoke 增加 `--keep-session`。记录输出的 Session ID，
重启应用，再使用该 ID 继续 smoke：

```bash
kubectl -n qwen-managed-agent rollout restart deployment/managed-agent
kubectl -n qwen-managed-agent rollout status deployment/managed-agent --timeout=10m
node deploy/kubernetes/smoke.mjs --key-file "$QWEN_K8S_KEY_FILE" --session-id <session-id>
```

重启后的新 Turn 可能需要等待旧的 60 秒 writer lease 和自动重试后才能执行；模型
响应也较慢时，请增加 `--timeout-ms`。此流程验证空闲重启后保留历史并完成新 Turn，
不代表任意在途 Turn 恢复、多副本 HA 或 CSI ownership 恢复已验收。
最后一次 smoke 结束后，使用 `rm "$QWEN_K8S_KEY_FILE"` 删除临时密钥。

## 升级与卸载

升级前停止新准入、结算活动工作，并备份 MySQL 和完整凭据 Secret。启用 LOCAL 工具
时，先按上述流程关闭全部工具 Session，确认所有物理 holder 已清空。保持 namespace、
release 名、MySQL 和可选 Runtime/Workspace PVC，以及凭据不变。使用匹配的新镜像
重复安装命令，恢复流量前执行
Session smoke。应用固定单副本并使用 Recreate，升级存在停机时间，请勿扩为多副本。

不要使用 `--atomic`，也不要自动回滚改变 schema 的升级。Flyway 在 readiness 前执行
migration，旧 binary 不保证接受新 schema。请向前修复，或在接受写入前恢复匹配的
数据库和应用备份。当前预发布开发版本可能原地更新 canonical V1 baseline；不兼容的
catalog 需要新数据库，不能直接 Helm 升级。需要历史数据时，保留与其匹配的应用版本。

```bash
helm uninstall managed-agent --namespace qwen-managed-agent
```

卸载保留受管 Secret、StatefulSet PVC 和可选 Runtime/Workspace PVC。需要历史时
不能删除；永久清理数据是独立的
显式操作。修改 namespace 或 release 名会创建另一个部署。

## 验证边界

在仓库根目录使用部署输入执行 `helm lint`，并执行
`node --test deploy/kubernetes/*.test.mjs`。可通过
`HELM_BIN=/absolute/path/to/helm` 指定 PATH 外的 Helm。测试渲染 chart，并通过受控
Kubernetes API peer 验证凭据复用，通过受控 HTTP peer 验证签名 smoke 协议。
这些测试不等于真实集群验收。

每个目标集群应独立记录镜像构建、安装、真实 MySQL、provider 调用和重启结果。
ACK、节点故障、CSI、物理退役与生产验收仍是独立门槛。可选可信 LOCAL 模式与
[K2 常驻部署](../k2-resident/README.zh-CN.md) 独立；后者需要经过资格验证的 CSI
身份，且不支持 Shell。chart 不开启 K2。
设计：[English](../../docs/design/2026-10-24-managed-agent-kubernetes.md) |
[简体中文](../../docs/design/2026-10-24-managed-agent-kubernetes.zh-CN.md)；工具与 WebShell：
[English](../../docs/design/2026-10-25-managed-agent-kubernetes-tools.md) |
[简体中文](../../docs/design/2026-10-25-managed-agent-kubernetes-tools.zh-CN.md)。
