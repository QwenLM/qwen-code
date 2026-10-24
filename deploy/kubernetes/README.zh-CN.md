# 在 Kubernetes 部署 Managed Agent

[English](README.md) | [简体中文](README.zh-CN.md)

这个实验性 Helm chart 安装签名认证的 Managed Agent API、同 Pod 的私有 Hosted
Harness，以及使用持久卷的 MySQL 8.4。提供镜像和模型配置后，一条 Helm 命令即可安装
整套服务。默认支持文本 Session。Workspace files、Shell、Runtime Broker、WebShell
和 K2 provisioning 不在此 chart 的范围内。

## 前置条件

- Kubernetes 1.28 或更新版本、Helm 3.18 或更新版本、kubectl，以及可创建 workload、
  Service、ConfigMap、Secret 和 PVC 的 namespace。
- 支持 ReadWriteOnce 的默认 StorageClass，或显式指定
  `mysql.storage.className`。数据库卷默认申请 10 GiB。
- 容器构建工具和集群可访问的镜像仓库。两个应用镜像必须来自同一经过评审的源码
  revision，并匹配节点 CPU 架构。不假设已有公开发布的 Managed Agent 镜像。
- OpenAI 兼容模型 endpoint、模型 ID 和 API key。

应用 Pod 总计申请 500m CPU 和 1 GiB 内存；MySQL 额外申请 250m CPU 和 512 MiB
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
卸载时保留对应 Secret，后续安装和升级复用它。升级时缺少受管 Secret 会失败；请恢复
原 Secret；保留数据库 PVC 却缺少 Secret 时，重新安装也会拒绝。不要重新生成数据库
密码或 journal 密钥。已有部署忽略 `model.apiKey`：
更新模型凭据需显式轮换 Secret 的 `model-api-key`，然后重启应用 Pod。

Helm 会将受管 Secret 内容保存到 release 元数据。若要独立管理凭据，设置
`credentials.existingSecret` 并省略 `model.apiKey`。该 Secret 必须已存在于 release
namespace，包含以下全部键：

| 键                          | 值                                      |
| --------------------------- | --------------------------------------- |
| `auth-signing-key`          | 至少 32 个 UTF-8 字节                   |
| `session-store-binding-key` | 独立密钥，至少 32 个 UTF-8 字节         |
| `harness-token`             | Java 与 Harness 共享的私有 bearer token |
| `capability-digest`         | `sha256:` 后跟 64 位小写十六进制字符    |
| `mysql-password`            | 应用数据库密码                          |
| `mysql-root-password`       | MySQL 初始化 root 密码                  |
| `model-api-key`             | Provider API key                        |

仅更改数据库 Secret 不会更改已有卷中的 MySQL 账号，数据库密码轮换需单独协调。
MySQL 初始化时授予应用用户数据库权限，以及 Flyway 启动探针所需的
`performance_schema.user_variables_by_thread` SELECT 权限。

ClusterIP Service 仅在 8080 暴露签名认证的公开 API。Harness 4170 和 Session Store
8081 都绑定 loopback。不启用无认证公开监听、LoadBalancer 或 Ingress。远程客户端
使用独立配置的 TLS ingress 或可信网关，并保留 API 签名；tenant 和 actor header
本身不能认证调用者。

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

升级前停止新准入、结算活动工作，并备份 MySQL 和完整凭据 Secret。保持 namespace、
release 名、MySQL PVC 和凭据不变。使用匹配的两个新镜像重复安装命令，恢复流量前执行
Session smoke。应用固定单副本并使用 Recreate，升级存在停机时间，请勿扩为多副本。

不要使用 `--atomic`，也不要自动回滚改变 schema 的升级。Flyway 在 readiness 前执行
migration，旧 binary 不保证接受新 schema。请向前修复，或在接受写入前恢复匹配的
数据库和应用备份。当前预发布开发版本可能原地更新 canonical V1 baseline；不兼容的
catalog 需要新数据库，不能直接 Helm 升级。需要历史数据时，保留与其匹配的应用版本。

```bash
helm uninstall managed-agent --namespace qwen-managed-agent
```

卸载保留受管 Secret 和 StatefulSet PVC。需要历史时不能删除；永久清理数据是独立的
显式操作。修改 namespace 或 release 名会创建另一个部署。

## 验证边界

在仓库根目录使用部署输入执行 `helm lint`，并执行
`node --test deploy/kubernetes/*.test.mjs`。可通过
`HELM_BIN=/absolute/path/to/helm` 指定 PATH 外的 Helm。测试渲染 chart，并通过受控
Kubernetes API peer 验证凭据复用，通过受控 HTTP peer 验证签名 smoke 协议。
这些测试不等于真实集群验收。

每个目标集群应独立记录镜像构建、安装、真实 MySQL、provider 调用和重启结果。
ACK、节点故障、CSI、物理退役与生产验收仍是独立门槛。已注册 Workspace 执行继续遵循
[K2 常驻部署](../k2-resident/README.zh-CN.md)；此 chart 不自动注册卷或开启相应能力。
设计：[English](../../docs/design/2026-10-24-managed-agent-kubernetes.md) |
[简体中文](../../docs/design/2026-10-24-managed-agent-kubernetes.zh-CN.md)。
