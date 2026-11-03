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

- `scripts/verify-pr-model-proxy.mjs` 监听选定的宿主地址（容器客户端用 Docker 网桥），持有 `REVIEW_OPENAI_API_KEY`，只转发精确的 `${basePath}/chat/completions` 路径。客户端出示每轮一个、整轮有效的 bearer token（`QWEN_VERIFY_PROXY_TOKEN`，非单次使用），代理在上游替换为真实 key。回显 nonce 的健康端点用于区分本进程与抢占者，本地配方在使用代理前比较该 nonce。hop-by-hop 请求头（固定集合与 `Connection` 点名的头）与上游 `content-encoding` 被剥离（undici 已解码，转发该头会让客户端二次解压）。空闲看门狗按块续期，与 qwen 客户端自身的 240 秒流容忍一致；下游暂停期间不中止，drain 时续期；上游响应头之前客户端断开时中止 fetch，而不是为无人读取的补全付费。
- 配方使用两个检出。`<trusted-clone>` 提供轮次运行的每个脚本，包括 prepare 预检、凭据扫描、隔离门禁、发布守卫与轮次后的检查器；`<pr-clone>` 是停在 PR head 的独立克隆，供容器挂载，并作为 prepare 的 cwd。轮次结束后该克隆的 `.git` 属 PR 控制，不复用；宿主机侧 git 命令禁用 fsmonitor、hooks、credential helper 与 `core.excludesFile`，并把本地定义的 clean/smudge/process filter 全部置空——枚举跟随 `include.path`，以 NUL 分隔只读键名并逐个重新校验（filter 值里的换行不得伪造额外的 `-c` 条目），`extensions.worktreeConfig` 为真时连 `.git/config.worktree` 一起枚举，固定加固项放在最后使任何枚举项都无法压过它。含 `=` 的 filter 名根本无法用 `-c key=value` 表示（git 在第一个 `=` 处切分参数），因此带自己的补救被拒绝，而不是生成一个失效的 override。`.git/info/exclude` 没有 `-c` 可压制，因此其中的有效模式被直接拒绝——新鲜克隆只有注释默认内容。链接 worktree 因其 gitfile 指向挂载外而在构造上被排除。
- 容器有名字且后台运行（`sleep infinity` 加 `docker exec`），以 `--user "$(id -u):$(id -g)"` 与 `HOME=/tmp/qwen-home` 运行，因此写入挂载树的文件保持维护者所有；CLI 装进新 home 是因为容器没有可写的全局前缀。base 提交的 `.qwen` 只读挂到树上（轮次的 skill 与项目设置不能来自 PR）；根 `AGENTS.md`/`QWEN.md` 不在覆盖范围内，仍来自 PR 克隆。完整快照从树外宿主副本挂载，代理 token 在启动容器的那一步从 JSON 文件重新取得，避免进入 shell history。无凭据宣誓传给启动轮次的 shell，且在可信的 `verify-pr-credential-scan.mjs` 拒绝凭据形状 ignored 文件与带凭据的 git config 之后才设置；config 守卫检查的是值而不是键名列表——任何值都可能藏 token URL（含 `http.proxy`），键名白名单永远不会收敛——外加携带 URL 的键族（`url.*.insteadOf`/`url.*.pushInsteadOf` 改写、`http.<url>.*` 段），并与 prepare 的 filter 枚举一样跟随 `include.path`、覆盖启用的 `.git/config.worktree` 作用域；文件扫描逐文件列出 ignored 条目并放过 `node_modules`/`dist`，因此已构建的树不会被误拒；嵌套 git 仓库在 git 会折叠成目录条目的每个面上都被拒绝——被忽略的克隆、未跟踪的克隆、已填充的子模块。轮次的引擎是发布版 CLI，除非把树内构建装到同一前缀覆盖它。
- 轮次从完整快照读取 `$QWEN_VERIFY_CONTEXT`。轮次结束后，检查器从 `<trusted-clone>` 运行并带 `--context <宿主副本>`，因此可写的产物 `context.json` 无法自证其期望 head。

CI 车道保留内联代理：那份副本运行在 base-pinned workflow 的 root 步骤里，若改为指向 PR 检出，PR 就能读到真实 key。

## 备选方案

- **把真实 key 导出进容器。** 否决：边界的存在就是为了把它挡在外面，而 PR 代码能读取自己的环境。
- **抽取 CI heredoc 并由 workflow 调用。** 对 CI 车道否决：脚本会来自 PR 检出。因此本地脚本是有意的第二份副本。它的差异不止传输接线：精确路径而非后缀、剥离 `Connection` 点名的头与 `content-encoding`、240 秒 pause 感知空闲窗口而非 CI 的固定 120 秒、以及响应头前断连中止。两份同步时必须带上这些行为差异，而不只是参数。
- **打印 `0.0.0.0`，或把监听地址归一化成 loopback。** 否决：打印值必须是客户端实际拨号的地址。
- **仅把树挂成只读。** 否决：轮次必须在树里构建并写产物。信任边界靠「特权宿主步骤从 `<trusted-clone>` 运行」以及「从宿主快照钉住期望 head」来落实。
- **扫描 `credential.helper` 命令里的内联 token。** 否决，超出 URL/头契约：helper 是命令，从中识别内联 token 需要解析 shell。prepare 自身的 git 读取已禁用 `credential.helper`，配方也要求重新克隆而不是复用 PR 可控的 `.git`；这一残余形态在此记录，而不是悄悄丢掉。

## 验收

- 代理：bearer 拒绝、精确路径白名单、base path 前缀、真实 key 注入、chunked 请求体下 hop-by-hop 剥离（固定集合与 `Connection` 点名的头，并以未被点名的自定义头作透传正对照）、gzip 上游响应（头被剥离）、响应头前断连中止、下游暂停存活、慢但健康的流、慢请求上传由按块续期保活、上游重置存活、真实被拒的拨号（先绑定后关闭的端口，断言 `ECONNREFUSED`——被屏蔽的端口根本不会拨号）、空值或形似 flag 的 `--listen` 被拒、IPv6 监听格式化、空闲默认值从 core 常量源码读取而非复述，以及 CLI 的 JSON 坐标。
- 凭据扫描：嵌套 ignored 的 `.env`、`.env~`、`backup.env~`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa*`、`id_ed25519*`、`id_ecdsa*`、`id_dsa*`、`credentials*`、`.git-credentials`、`.npmrc`（含深层目录）、`.netrc`、`gha-creds-*.json` 被拒绝（`.pub` 公钥不算凭据）。config 守卫检查每个本地值：http(s) 的任意 userinfo 都被拒绝（含把 token 当用户名；裸 `git@` 账号名不含秘密，任意大小写拼写都与 `ssh://git@` 一样保持良性），带 `Authorization`/`Proxy-Authorization` 头的值也被拒绝（其他头名保持干净）；携带 URL 的键族（`insteadOf`/`pushInsteadOf` 改写、`http.<url>.*` 段）按键中内嵌的 URL 判定。任何历史列表之外的新键（`custom.mirror`、`http.proxy`）是"契约是值检查而非键名白名单"的见证；拒绝消息只点名键、不打印值。经 `include.path` 引入或位于启用的 `.git/config.worktree` 作用域的凭据被拒绝；不含凭据的 include 与良性 worktree 配置保持干净，扩展禁用时 worktree 文件与 git 一样被忽略。`node_modules`/`dist` 在任意深度（含 workspace 包内）被忽略，其下的 vendored git 仓库被排除而非拒绝；文件枚举由 pathspec 限制，不会先缓冲整棵依赖树（缓冲夹具的文件本身就匹配凭据 pathspec，去掉限制真的会溢出）。嵌套 git 仓库在每个面上都被拒绝——被忽略的克隆、未跟踪且未被忽略的克隆、已填充的子模块——未填充的 gitlink 保持干净（其 URL 由值扫描覆盖）；去掉 `--ignored` 模式或删掉某条模式会让测试变红。
- 宿主机 git 硬化：prepare 禁用 fsmonitor、hooks、credential helper 与 `core.excludesFile`，并在读取 PR 可控树之前把本地定义的 clean/smudge/process filter 全部置空——枚举跟随 `include.path`、NUL 分隔的键名逐个重新校验防伪造、`extensions.worktreeConfig` 为真时覆盖 `.git/config.worktree`、固定加固项放在最后。植入夹具证明四种 filter 形态的覆盖：直接定义、经被 include 的工作树文件、worktree config、以及值含换行不得伪造压过加固的 `-c`，各带一个不覆盖就会触发的正对照。含 `=` 的 filter 名在模块与 CLI 两路都带自己的补救被拒绝——没有 override 能表示它，且拒绝先于任何加固 status。恶意 `core.excludesFile` 无法对加固后的 status 隐藏未跟踪文件；`.git/info/exclude` 的有效模式以重新克隆为补救被拒绝，注释默认内容放行。非 git 目录以 worktree 消息干净拒绝（exit 3），而不是未捕获的枚举错误。
- 检查器：`--context` 覆盖可写产物副本、不可用快照时拒绝而不是回退（产物副本先种一个合法 head），并保持既有退出码。
- 配方：每个脚本都点名可信 checkout（含 prepare、扫描、门禁、守卫与检查器）、base 提交的 `.qwen` 只读挂载且解压到先清空的目录、两个凭据都来自文件而非命令行（stdin 非 TTY 时 key 从 `REVIEW_OPENAI_KEY_FILE` 读取，按变量而非 `read` 的 EOF 返回码判断，因此无结尾换行的 key 文件可用，代理拿到副本后立即 unset）、启动容器前等待代理坐标与 nonce 且 stderr 写入独立文件以保持 JSON 可解析、token 在 `docker run` 那一步重新取得、宣誓在轮次 shell 但不在 `docker run` 行。`previous-report.md` 只在确实找到报告时写入——它的存在就是跟进轮触发器——并按首段标记从 bot 或维护者本人的评论中选取，而不是任何回复都能引用的子串。发布 footer 哈希轮次实际加载的 base-pin skill 副本，绝不哈希 PR head 的；任一被还原都会让配方 pin 变红。
- 变异证据：移除上述任一守卫，对应 pin 必须变红。
- 真实 Docker 冒烟：`QWEN_VERIFY_PROXY_TOKEN` 时门禁通过、`OPENAI_API_KEY` 时门禁拒绝、容器请求到达 mock 上游且真实 key 已注入。
