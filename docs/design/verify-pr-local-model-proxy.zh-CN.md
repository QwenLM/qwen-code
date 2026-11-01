# 容器化 /verify-pr 轮次的宿主机模型代理

[English](verify-pr-local-model-proxy.md) | [简体中文](verify-pr-local-model-proxy.zh-CN.md)

状态：已实现。

## 问题

本地 `/verify-pr` 路径必须在无凭据边界内执行不可信的 PR 代码，skill 的隔离门禁也这样要求。但配方只停在要求上：它没有让轮次访问模型的途径而不把真实 key 放进容器，没有容器启动方式，也没有为「不能从 PR 树运行的宿主步骤」定义形态。

由此产生三个具体失败：

- **key 没有安全通道。** 在容器里导出 `OPENAI_API_KEY`，要么把真实凭据交给 PR 代码，要么触发隔离门禁——门禁拒绝任何非空的 `OPENAI_API_KEY`，因为它无法区分代理 token 与真实 key。
- **代理与检查器是持宿主权限的宿主步骤。** 从轮次树执行仓库相对路径的 `node scripts/...` 会运行 PR 自己的副本，而代理持有真实 key、检查器读取用于认证本轮产物的文件；产物目录恰恰可被轮次刚执行的代码写入。
- **显而易见的容器调用方式支撑不了轮次。** 没有名字的交互式 `docker run -it` 无法由 agent 驱动；只挂载树会让链接 worktree 的绝对 gitfile 不可达，并在维护者检出里留下 root 属主文件；四键的产物 `context.json` 也不是轮次读取的完整元数据快照。

## 方案

一个宿主机侧转发器，加一套点明信任边界的配方。

- `scripts/verify-pr-model-proxy.mjs` 监听选定的宿主地址（容器客户端用 Docker 网桥），持有 `REVIEW_OPENAI_API_KEY`，只转发 `POST /chat/completions`。客户端出示一次性 bearer token（`QWEN_VERIFY_PROXY_TOKEN`），代理在上游替换为真实 key。回显 nonce 的健康端点用于区分本进程与抢占者。hop-by-hop 请求头被剥离。空闲看门狗按块续期，与 qwen 客户端自身的 240 秒流容忍一致；下游暂停期间不中止，drain 时续期；上游响应头之前客户端断开时中止 fetch，而不是为无人读取的补全付费。
- 配方使用两个检出。`<trusted-clone>` 运行代理与轮次后的检查器；`<pr-clone>` 是停在 PR head 的独立克隆，供容器挂载。链接 worktree 因其 gitfile 指向挂载外而在构造上被排除。
- 容器有名字且后台运行（`sleep infinity` 加 `docker exec`），以宿主 uid 运行、`HOME=/tmp/qwen-home`，从树外的宿主副本挂载完整快照，并在拒绝凭据形状的 ignored 文件之后才在容器内设置无凭据宣誓。CLI 安装进这个新 home，因此树里不会出现 root 属主文件。
- 轮次从完整快照读取 `$QWEN_VERIFY_CONTEXT`。轮次结束后，检查器从 `<trusted-clone>` 运行并带 `--context <宿主副本>`，因此可写的产物 `context.json` 无法自证其期望 head。

CI 车道保留内联代理：那份副本运行在 base-pinned workflow 的 root 步骤里，若改为指向 PR 检出，PR 就能读到真实 key。

## 备选方案

- **把真实 key 导出进容器。** 否决：边界的存在就是为了把它挡在外面，而 PR 代码能读取自己的环境。
- **抽取 CI heredoc 并由 workflow 调用。** 对 CI 车道否决：脚本会来自 PR 检出。因此本地脚本是有意的第二份副本，差异仅限监听参数、JSON 坐标与请求头剥离。
- **打印 `0.0.0.0`，或把监听地址归一化成 loopback。** 否决：打印值必须是客户端实际拨号的地址。
- **仅把树挂成只读。** 否决：轮次必须在树里构建并写产物。信任边界靠「特权宿主步骤从 `<trusted-clone>` 运行」以及「从宿主快照钉住期望 head」来落实。

## 验收

- 代理：bearer 拒绝、路径白名单、base path 前缀、真实 key 注入、chunked 请求体下 hop-by-hop 剥离、响应头前断连中止、下游暂停存活、慢但健康的流、上游重置存活、IPv6 监听格式化，以及 CLI 的 JSON 坐标。
- 检查器：`--context` 覆盖可写产物副本、不可用快照时拒绝而不是回退，并保持既有退出码。
- 变异证据：移除上述任一守卫，对应 pin 必须变红。
- 真实 Docker 冒烟：`QWEN_VERIFY_PROXY_TOKEN` 时门禁通过、`OPENAI_API_KEY` 时门禁拒绝、容器请求到达 mock 上游且真实 key 已注入。
