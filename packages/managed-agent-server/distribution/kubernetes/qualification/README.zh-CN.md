# 共享 Harness 验收

[English](README.md) | [简体中文](README.zh-CN.md)

这些工具用于准备现有[池部署](../README.zh-CN.md)并测试公开行为，不购买云资源、不 apply YAML、不签发证书、不启动本地 Java，也不启用 HPA。使用可丢弃 namespace、专用租户和全新单 V1 MySQL 数据库。自动缩容保持关闭。

## 构建匹配镜像

先提交验收 Dockerfile，再选择该不可变源码版本。从仓库根目录先检查计划：

```sh
node scripts/build-managed-harness-images.mjs --source-sha YOUR_40_HEX_COMMIT --image-prefix YOUR_REGISTRY/qwen-qualification --output image-plan.json
```

在已授权的远端 Docker builder 上，使用同一命令加 `--execute --push` 和新的输出路径。它只归档该 commit，为 `linux/amd64` 构建现有 Harness 和 Java 镜像，再由两者派生 Java 加 worker 镜像，不复制本地工作目录或凭据文件。发布必须显式指定，且仅发布 Harness 与 worker 镜像，不使用 `latest` 或 release tag。报告记录核验后的已发布仓库 digest。只有 build 的报告不能作为部署 digest。

派生 worker 镜像包含 Java 21、Node 22、完整 CLI 包、bash/git/procps/util-linux，以及三个独立、属于 UID 10001 的路径：`/data/runtime`、`/data/default-workspace`、`/data/workspaces`。部署时提供私有持久挂载、`/etc/machine-id` 的真实唯一机器身份及有效 Linux `/proc` 身份。原生 Workspace 身份、生命周期或 cgroup 证据缺失时保持正常拒绝，不关闭 verified recovery，也不添加特权宿主机挂载。镜像本身不代表 Java/Broker/worker 宿主 Pod 重建已经通过验收。

## 配置与生成

在既有 Java 宿主上适配 [server.example.yaml](server.example.yaml)，在同 Pod 的 HTTPS sidecar 中适配 [server-envoy.yaml](server-envoy.yaml)。代理必须与 Java 同位置：Store 流量进入 loopback internal connector 的 4183 端口，Broker 流量进入 4182。提供真实服务端 TLS 证书、CA 信任、token 和私网策略；模板仅暴露Store、Broker 与发布路由前缀，并拒绝 `Origin`。部署前使用选定不可变镜像验证 Envoy 配置。附加 Tomcat connector 本身仍是明文。

Harness 与 worker 分处不同 Pod 时，前台 Shell 需要现有 Tool v3 发布路径。示例以明确的验收容量和截止时间启用它，并使用真实、私有、从未启用版本控制的 OSS bucket；提供地域 HTTPS endpoint、region、bucket 变量，以及仅交给 Java 的临时 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_SESSION_TOKEN`。local-process provisioner 会从 worker 环境移除 `OSS_` 凭据。为 worker 配置私有发布 gateway 的常规 Node CA 信任，并允许实际 Java 到 OSS/DNS、worker 到 gateway 的网络目标。代理将发布前缀转发到 internal connector。这些限制是测试输入，不是生产容量结论。旧捕获路径公布 Harness 的 loopback 回调，另一 Pod 的 worker 无法访问；不要在禁用发布时宣称共享 Shell 已验收，也不要暴露旧 loopback publisher。后台 Shell、Monitor、Hook 资源仍不属于本轮前台验收范围。

为现有 Java 配置发现 service account、mTLS 客户端 keystore、真实 Harness Service UID、公开签名鉴权及全新数据库。Harness 证书签发必须覆盖每个实际 Pod IP SAN，包括替换后的 IP，Service DNS 证书不够。保留应用层 Store/Broker 凭据，不将 internal 路由暴露到公网。通过秘密管理系统准备父 README 规定的两个 Secret。

复制 [render.example.json](render.example.json)，替换所有占位值，并将新读取的 `kubectl --context YOUR_CONTEXT get nodes -o json` 结果保存到其 `nodeInventoryFile`。明确选择两个既有 Ready 业务节点。生成器拒绝系统、保留和带阻止调度 taint 的节点，将调度限制为精确 node name，避免新扩出的节点满足此负载。核对滚动更新时三个 Harness 加代理 Pod 的实际容量，quota 只是上限。该 namespace 必须专用于池：quota 允许三个 Pod，并禁止 PVC、外部负载均衡和 NodePort。Java、MySQL、gateway 如需额外资源，应位于池 namespace 之外，并据此填写 `javaNamespace`。

```sh
node scripts/render-managed-harness-kubernetes.mjs --config render.json --output NEW_REVIEW_DIRECTORY
```

结合真实集群身份、可信镜像构建报告、端点与容量审核 `pool.yaml`、`result.json`。生成过程不写集群。全部前提满足后，再通过已授权的部署流程 apply。不要通过添加 `CriticalAddonsOnly` toleration 或删除系统 taint 让测试通过。

生成包包含一个以 `runId` 命名的集群级 PriorityClass，优先级为 -1000，设置 `globalDefault: false` 和 `preemptionPolicy: Never`。应用它需要相应的集群权限。Pod 引用此专用 class，使准入保留禁止抢占策略。应用前核对归属；清理时先删除本轮 Pod，再移除此 class。

rollout 后使用纳入版本控制的只读预检，传入已核验的 `kube-system` UID 和两个所选节点：

```sh
python3 scripts/harness-kubernetes-preflight.py --context YOUR_CONTEXT --namespace YOUR_NAMESPACE --run-id YOUR_RUN_ID --source-sha YOUR_COMMIT --cluster-uid YOUR_KUBE_SYSTEM_UID --node EXISTING_NODE_1 --node EXISTING_NODE_2 --output preflight.json
```

它读取实时节点资格、rollout/controller 身份、实际不可变镜像、探针命令和属于该 Service 的 EndpointSlice 目标，不读取 Secret 或进入 Pod 执行命令。通过只代表部署就绪，`executionAcceptance` 仍为 `NOT_RUN`。

## 执行公开契约

安装仓库固定版本依赖。复制 [public.example.json](public.example.json)，指定两个专用租户、每租户两个 actor，并填写各租户已启用的 files/shell Agent ID。使用真正调用所需工具的受控模型端点；files Agent 必须允许在自己的 Workspace 中免审批 write/read/edit，Shell Agent 必须为前台命令请求审批。不能使用 `yolo`。驱动创建四个自有 Workspace、恰好八个 Session，每 actor 各一个 files 和 Shell 通道，不创建 Agent 定义或额外角色 grant。

签名密钥放入没有 group/other 权限的私有文件，不放在参数或 JSON 中。内部 CA 通过 Node 正常的 `NODE_EXTRA_CA_CERTS` 配置信任，不关闭 TLS 验证。仅允许 HTTPS 或明确的 loopback HTTP 端口转发 origin。使用 Node 22+ 运行：

```sh
node --import tsx scripts/run-managed-harness-qualification.mjs --config private-public.json --output NEW_RESULT.json
```

驱动核对签名与篡改拒绝、Workspace/Session 归属、幂等准入、四个 actor 的实际 write/read/edit 文件内容和下一 Turn 历史、原 revision 的精确命令 Shell Allow/Deny 与重放回执、实际 SSE 断线恢复、前台取消和 close operation 完成。只审批完整 input preview 中与本次验收精确一致的命令。公开文件读取独立于模型文本核验物理效果。请求、响应体、流和等待均有限制。报告保留资源 ID 和阶段结果，不输出密钥、签名或原始响应体。输出文件使用独占创建，避免覆盖先前报告。

失败时保留原 run 配置、ID 和报告，使用原 operation/幂等键处理未完成工作，只关闭本次自有 Session；不要自动新建一次 run 重试未知效果。成功时关闭全部已准入 Session，但保留四个 Workspace 与测试文件供运维取证和按归属清理。驱动不删除 namespace 或持久存储。

`PUBLIC_SCENARIOS_PASSED` 仅证明目标服务上的这些公开场景。两台真实 Harness Pod/boot placement、SQL writer fencing、资源空闲 release 回执及忙碌/崩溃/丢 ACK/未知效果矩阵仍需独立取证。容量和 HPA 验收仍独立。合成 HTTP 和 kubectl fixture 仅验证这些工具，不代表真实集群。
