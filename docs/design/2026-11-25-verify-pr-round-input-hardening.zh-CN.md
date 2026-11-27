# `/verify-pr` 轮次输入交接加固

[English](2026-11-25-verify-pr-round-input-hardening.md) | [简体中文](2026-11-25-verify-pr-round-input-hardening.zh-CN.md)

**状态：已实现；独立复核及远端发布检查仍未结束。当前评审跟进修改在 macOS arm64、Node 24.18.1 上的三个相关文件有 67 项聚焦检查通过。§8.6 保留先前 Linux、capability 探测与 KVM 测量，这些仅是历史证据，不证明当前 guest；旧 head 的计数与能力探测范围、确切源码、KVM 及不支持环境的边界也见该节。其有界重试、字节预算、前置校验和 bridge 修复及对应的源码级重放状态见 §§8.7–8.10。不宣称远端提交 CI 或合并已获批准。日期：2026-11-25；后续证据：2026-11-27。**

## 1. 背景与问题

无网卡 microVM 通道在 `scripts/verify-pr-vm-runner.mjs`、`scripts/verify-pr-vm-channel.mjs` 和 `scripts/verify-pr-vm-guest-vsock.py` 中实现了 `verify-pr-input-v1`。宿主预检探针证实了两处具体接线缺口：

- JavaScript API 接受调用者提供的 `roundInput.entropyHex`，但 JSON `run --config` 适配器丢弃了这个字段。因此，即便调用者提供与之匹配的固定 `trustedInputDigest`，也总会收到 `trustedInputDigest does not match generated roundInput manifest digest`，无法完成可复现的输入交接。
- manifest 生成逻辑声明 guest model-proxy 端口，默认 54，却与实际代理监听位置相互独立。宿主 TCP、另一个 UDS，或不含 `modelVsockPath` 的启动计划，都可能生成 guest 无法使用的 manifest。

探针还确认，Python guest 客户端通过真实 UDS 对端已经能拒绝截断载荷、超额声明、非法响应头、尾随字节和错误的 bundle 摘要。这些保护需要仓库内的执行见证，而不是再叠加重复检查。本切片同时包含两个小范围卫生修复：输出父目录创建失败时清理临时 bare 仓，并删除对固定 health fixture 无效、无法观察其实际故障的 `socket.gaierror` 断言。

## 2. 目标与非目标

- 让公开 runner CLI 与直接 JavaScript API 都支持确定性的输入 pinning。
- 当 guest 输入 manifest 将承诺不可用的模型端点时，在创建监听器凭据或启动 worker 之前 fail closed。
- 使用真实 UDS socket 与实际 Python 获取客户端，固定既有 guest 拒绝行为。
- 在不改变双 OID 导出契约的前提下消除临时仓库泄漏。

本次不新增 provider、不创建云资源、不扩大 CLI 配置面、不抽取共享 socket helper，也不修改 `packages/`、`.github/`、`.qwen/skills/` 或 `/review`。legacy `container`、手动 `vm`、`waived` 验证流程均不改变。本设计不暗含任何提交、推送或发布 PR 的授权。

## 3. 设计决定

### 3.1 透传既有 entropy 字段

在现有 `resolvedRoundInput` 白名单中增加 `entropyHex: rawRoundInput.entropyHex`。不新增另一个摘要输入，也不绕过 canonical manifest 构造。`buildInputManifest` 继续负责校验“恰好 64 个小写十六进制字符”，并在未提供 entropy 时保留其默认随机 32 字节。runner 在读取、生成或复制 prebuilt 输入之前也执行相同校验，非法 caller entropy 不会先产生私有 artifact；后续 canonical-manifest 守卫保持不变。

调用者提供的 `trustedInputDigest` 继续与生成的 canonical manifest 摘要比较；canonicalization 与比较规则不被削弱。过期摘要仍然是错误。临时代理 token/nonce 继续独立随机生成，且仍是 canonical manifest 的组成部分，因此可复现的 CLI pinning 夹具使用 `modelProxy: null`。本改动不开放凭据字段、不从调用者选择的 entropy 派生凭据，也不让调用者预测含新生成凭据的 manifest。对于可复现输入，匹配的固定摘要无论通过 `run --config` 还是 JavaScript API 构造都必须通过这项比较。

### 3.2 使端点承诺与实际绑定一致

只要存在 `roundInput` 且启用了 `modelProxy`，预检就要求 `plan.modelVsockPath` 非空，并与其有效代理绑定路径严格相等。有效绑定保持现有优先级：显式 `socketPath`；其次在未设置 `listenHost` 时使用计划的 VSOCK UDS；否则使用宿主 TCP。

因此会拒绝三类配置：显式宿主 TCP listener、另一个 UDS、缺少计划的 model VSOCK path。有效 Firecracker/vfkit VSOCK 计划保持现有行为。不含 `roundInput` 的宿主 TCP 和显式备用 UDS 仍然受支持，因为它们不产生这个 guest 端点承诺；本改动不声称这些路线可用于无网卡 guest。

此门是普通输入校验，位于临时代理 token/nonce 生成、token 文件写入、listener 创建和 `launchBackend` 之前。它不会隐性添加 TCP-to-guest 映射，不修改 provider planner，也不抑制不匹配错误。manifest 的 base path、临时 token、nonce，以及上游 API key 仅保留在宿主的规则都不变。

### 3.3 固定 guest 获取的 fail-closed 行为

一个仅测试使用的 UDS server 先返回合法 manifest，再返回一个恶意 bundle 响应。驱动真实的 `python3 scripts/verify-pr-vm-guest-vsock.py fetch-inputs --unix ... --out ...` 客户端覆盖以下情形：

1. 在达到声明长度前被截断的载荷。
2. 超过 `MAX_BUNDLE_BYTES`（128 MiB）的声明长度。
3. 非法 `OK` 响应头。
4. 声明载荷之后的额外字节。
5. SHA-256 或长度与合法 manifest 不符的载荷字节。

每种情形都必须非零退出、输出具体的协议/完整性错误，并且输出目录中既没有 `round.bundle`，也没有其他被提升的输入文件。不需要测试 hook、mock fetcher、真实模型服务或真实上游 key。删除任意一个保护时，相应测试必须失败。

### 3.4 让清理覆盖 scratch 的完整生命周期

把 `qc-round-bundle-*` 临时 bare 仓的创建移入受保护的清理生命周期。输出父目录创建与 bundle 构造共享 `try`/`catch`/`finally` 所有权：bundle 输出失败仍移除部分文件，只要临时目录已经创建就必须删除。若临时目录创建本身失败，则没有该目录可清理。

测试在隔离临时根目录下建立一个已存在、可搜索但不可写的输出父目录（mode 0500）。嵌套 `outPath` 在前置 `lstat` 中返回 `ENOENT`，随后 scratch 创建成功，真实 `mkdirSync(..., {recursive: true})` 才以 `EACCES`/`EPERM` 失败。普通文件阻挡路径作为对照：前置 `ENOTDIR` 拒绝发生在 scratch 创建之前，不能误当成泄漏证据。权限夹具使用既有 `arePermissionBitsEnforced()` 内核探测，而不是假设 uid 为 0 就无法测试。仅在 chmod 确实拒绝读取和写入时执行：普通 root 绕过则跳过；去掉 DAC capabilities 后，真实的 `EACCES` 用例必须执行。无法测量的探测不算通过。测试在删除夹具前恢复目录权限，不 mock Git 或文件系统。显式 base/head OID、只读 alternates、不复制 `.git/config`、不导出私有分支或秘密文件、原子替换输出的现有校验保持不变。

只删除“固定 HTTP health 响应不包含 `socket.gaierror`”这条无效测试断言。真实响应检查和独立的 IPv6 运行时能力探测均保留。

## 4. 安全与兼容边界

| 情形                                             | 要求的结果                                               |
| ------------------------------------------------ | -------------------------------------------------------- |
| 通过 `run --config` 提供合法固定 entropy         | 不出现 digest mismatch，进入正常 manifest 之后的生命周期 |
| 过期 `trustedInputDigest`                        | 在 token、listener、worker 创建之前失败                  |
| `roundInput` 搭配非 VSOCK 或缺失的 model 绑定    | 在 token、listener、worker 创建之前失败                  |
| 无 `roundInput`；legacy 宿主 TCP 或备用 UDS 代理 | 保持现有行为                                             |
| guest 收到非法或不一致的字节                     | 非零退出，未被提升的临时 bundle 不保留                   |
| bundle 导出时输出父目录创建失败                  | 原始错误传播；已拥有的 scratch 和输出临时文件被删除      |

这是传输/配置一致性控制，不是新的 hypervisor，也不声称已经在另行启动的内核里完成端到端验证。既有 socket 身份、单链普通文件、认证、额度、吊销与销毁机制继续承担各自职责。上游 key 永不进入 manifest。

## 5. 风险与限制

- 端点相等的断言不证明真实 VM 能与 guest 通信。它只阻断已知的错误配置；真实传输证据仍属于单独的集成测试。
- Python UDS 测试不证明 Linux AF_VSOCK 或 Apple Virtualization.framework 行为。
- CLI 接线测试所用有意早退的 launcher 不代表成功完成 VM 轮次，更不是合并批准。必须把之后的失败与 manifest-digest 拒绝区分开。
- 旧 PR 验证、无关代码上的成功 CI，以及另一个 head 的绿色测试，都不能证明本改动的结果。

本切片没有未决的产品方向问题。provider-VM 与 Agent Sandbox 数据面仍是独立后续工作，继续遵守已有显式授权与云资源边界。

## 6. 验证计划

- 运行聚焦的官方 scripts 测试：

  ```bash
  npm run test:scripts:unit -- scripts/tests/verify-pr-vm-channel.test.js scripts/tests/verify-pr-vm-runner.test.js
  ```

- 对同一份 `run --config` 夹具做修改前后验证：固定 entropy 与其精确摘要不再导致 digest 比较失败，过期摘要仍应被拒绝。
- 验证宿主 TCP、备用 UDS、缺失 model path 的拒绝，以及现有三端口 UDS/loopback launcher 流程；不改变无 `roundInput` 的 legacy 代理用例。
- 重放五个 UDS 恶意输入情形，不得留下被提升的输入文件。
- 运行 `npm run build`、`npm run typecheck`、`npm run bundle`；随后在相关场景使用构建后的 CLI 做有界运行时检查。报告每条实际执行的命令及未覆盖的环境。
- 审阅完整 diff，确认双语文档一致，结束后台进程并删除一次性夹具后再收尾。

## 7. 验收标准

四种行为均有可执行证据，聚焦测试与负向测试通过官方运行器，验证边界准确说明实际测到的环境。兼容路径不静默降低隔离，也不编造 guest 路线。不把不可用的环境记为通过，不声称创建云资源或产生 GitHub 侧效果。

## 8. 后续审计：环境、语义校验和资源预算（2026-11-26）

CI 与独立审计补充了具体的安全边界，不增加协议选项或 provider。§8.1–8.4 记录相关约束，§8.5 单独记录随后的 Linux、真实 KVM 证据及环境边界；不声称扩大了云验证范围。

### 8.1 不把宿主凭据交给 VMM/helper

Firecracker 默认 `spawn` 现在只传递 `PATH`，未提供时使用与平台无关的默认值。这可保留自定义可执行文件目录，同时不继承 `REVIEW_OPENAI_API_KEY`、`GH_TOKEN` 等宿主凭据。上游 key 仅留在宿主 model-proxy 进程，不进入 manifest，也不进入 VMM/helper 环境。vfkit 原有 `env -i` 包装及硬件/信任类别选择不变。launcher canary 捕获实际子进程环境，不打印真实上游 key；它不是 VM 启动证明，已知 helper 的身份错误或预期早退仍单独呈现。

### 8.2 下载 bundle 之前校验 manifest 语义

Python guest 和 Node 获取客户端均在请求 bundle 前校验既有 canonical manifest 形状：schema、允许的顶层/model 字段、run ID/repository/PR 类型、40 位 OID、64 位 SHA/entropy、正整数 bundle 大小，以及非空代理 token/nonce 和正安全端口。`modelProxy: null`、可空 PR 与既有 path/token 默认值仍合法。未知字段和对象/数组误用 fail closed，而不是被忽略。canonical manifest 生成时保留正的安全整数 PR，并继续把不支持的值（包括 unsafe integer）归一为 `null`，避免生成两个客户端随后都拒绝的 PR 字段。不暴露上游 key，不增加另一套代理认证，也不把缺失 entropy 变成字符串 `undefined`。

字段检查先于 bundle 下载；缺 entropy 时仅请求一次 manifest，而不是继续第二次 bundle 请求、`KeyError` 后留下三个已接收文件。在字节完整性阶段，manifest、bundle、entropy 分别使用带 PID 的 mode 0600 临时文件，再逐一提升。只有 `rename` 成功才记录该文件已经提升。字段错误、帧错误、大小/摘要不符或暂存失败时，仅清理本轮临时文件和本轮已成功提升的文件，不盲目删除未涉及的历史输出。已验证的是每轮新的输出目录；该暂存过程不是可供混合轮次复用或并发读取的目录级 ACID 事务。

Node 还要求实际字符串的完整值符合语法，而不是把数组强制转换成字符串，或因 JavaScript `$` 的行为而接受末尾换行。两个客户端均拒绝非法 UTF-8/JSON，不接受与保留的 manifest 原始字节不一致的替换字符。Node 的 bundle writer 在成功和失败时都等待 `close`：文件系统错误可能迟于 `end()` 回调，清理也不能在异步创建文件的 `open` 完成之前 unlink。正常成功传输仍保留完整字节/SHA 检查及三文件提升。

生成端与两个获取客户端对“整串都是空白的凭据”采用一致定义：JavaScript 处理自身 trim 的空白，并额外计入 Python `str.isspace()` 的字符；Python 将 `str.isspace()` 字符和 `U+FEFF` 视为空白。这包括 `U+001C`–`U+001F`、`U+0085`、`U+FEFF` 以及它们的混合。含有有意义非空白字符的 Unicode 凭据仍逐字节保留；此规则只消除两端对纯空白值的接受/拒绝分歧，不把凭据限制为 ASCII。

正安全整数采用 Node 客户端的数值语义，而不是只依据 Python 的字面形式或运行时类型。JSON 中的 `4.0`、`4e0` 可以表示允许的整数值；有限且整值的浮点数会在 PR 编号、bundle 字节数和代理端口内正规化为 `int`。布尔值、零、负数、小数、非有限值和 unsafe 值仍被拒绝。原始 manifest 字节及其摘要保持不变，下载载荷大小和 socket 使用的整数仍精确对应。这保留了 Python 客户端对整值浮点数的兼容行为，避免 Node 接受一个只因 JSON 解码为 float 对象就被 guest 拒绝的 manifest。

在初始化任一 Git worktree 之前，先按需创建并 canonicalize 两个 materialize 目标，要求其身份不同且互不嵌套。除 canonical 字符串前缀比较外，还比较目录 dev/ino 身份并检查双方的祖先链，防止大小写不敏感文件系统中的 case-only 别名隐藏同一目录或父目录；不会将路径统一转为小写，因为大小写敏感文件系统上的两个不同目录可能有此名称差异。相同路径、symlink 别名和父子目的地均被拒绝，避免 head 静默覆盖 base 取出的代码。仅名字前缀相同的兄弟目录仍有效。不全面禁止使用既有目录，也不禁止不同且不嵌套的 symlink 目标；此处只关闭别名/嵌套导致的隔离缺口。

### 8.3 在保持兼容路径的前提下约束字节流和 bridge 资源

bundle 生成使用 `git bundle create -`，已验证 stdout 能形成有效 Git bundle。prebuilt 与 repoDir 输入均使用 `min(caller maxBundleBytes, DEFAULT_MAX_BUNDLE_BYTES)` 作为有效载荷预算，较大的 caller 预算不透传给 Git 生成器。Git 的总 `maxBuffer` 是该载荷预算加上有界的 64 KiB stderr 诊断余量。此余量不扩大 guest 载荷上限：原生 `ENOBUFS` 和后续精确字节数/哈希校验均 fail closed，后续发现超预算仍清理本轮临时输出。错误文案标记真正的载荷上限，而不是包含 stderr 余量的总缓冲区。错误保留 `allowed range` 文案和原始 `ENOBUFS` cause。stdout 仍以 256 KiB 分块计算 SHA，随后按既有 mode 检查和 rename 完成。这是此创建器所缓冲、写出的载荷字节预算，不是 Node 总 RSS、内核 page cache 或全部仓库/object-store 资源的绝对上限。实际尝试导出 qwen-code 的两个 OID 及完整 base 历史时，输出超过 128 MiB，保留原始 `ENOBUFS` cause 后终止，没有生成输出 bundle。传输夹具必须单独构造真实的小型双 OID Git 仓库；它不证明本仓库完整输入的交接。本切片不扩大预算、不发送截断 bundle、不静默切到宿主/共享内核路径，也不声称完整仓库 VM 轮次成功。

Node fetch 客户端在创建输出目录或连接 socket 之前，先要求 `maxBundleBytes` 与 `maxManifestBytes` 是正的安全整数。非有限上限不能在缓冲输入时使比较失效；非法上限不产生请求或输出目录。

prebuilt bundle 会分别按路径元数据和已打开 fd 执行 `maxBundleBytes` 检查。哈希循环还会在实际累计读取量超过有效预算时拒绝，并返回该读取量及 fd 的 dev/ino/nlink。拒绝发生在分片累计越过预算之后，并不承诺底层 read 调用绝不会返回超过 `maxBytes` 的数据。随后再次检查的路径元数据必须与 fd 的 dev/ino 和已哈希字节数一致，避免把某一文件状态的摘要和另一状态的大小或身份拼接起来。实际 `bundleBytes` 仍受 guest 既有 128 MiB 传输上限约束，即使调用者为余量配置更大的宿主预算。较大的预算本身不改变 guest 限制：实际小 bundle 仍可使用，超过 128 MiB 的 bundle 会在写 token 文件、创建 listener 或分配 backend 之前被拒绝。空文件或超预算文件在 token 创建、模型 listener 和 launcher 之前失败。读取使用 `O_NOFOLLOW|O_NONBLOCK`、`fstat` 和分块哈希；不把多链普通文件误改判为非普通文件，既有单链和共享 inode 拒绝仍然有效。

随后以 no-follow 方式重新打开 prebuilt 源 fd，并把其身份及大小与首次核验比对。私有暂存文件通过独占方式创建，并经 fd 设为 mode 0600。复制按 256 KiB 分片推进：累计读取量必须保持在调用方预算和固定 guest 上限内，才允许写入该分片；读完 EOF 后必须同时满足原始字节数与 SHA-256 一致。与哈希读取器相同，单次 read 可能先越过预算才被拒绝；检测到越界后不会写入该分片。经检查的单链接普通私有 bundle 可通过私有 staging 文件的 `rename` 替换，支持复用 launcher 及其自己的私有输入。既有目录、symlink 或多链接目标会被拒绝且不被 unlink。staging 仍为排他创建，清理只针对本轮实际创建的 inode。取得所有权前发生 `EEXIST` 时保留调用方输入，随后身份不符时阻止 unlink 而不是删除替代对象。清理错误在清理块之后报告，不会遮蔽原始预算或复制错误。注入 backend 与 input server 都收到已验证的私有副本，而非调用方可能继续修改的来源路径。整个 bundle 不会被缓冲进内存；这些保证不宣称受信宿主操作者无法改写自己拥有的私有文件。

Node writer 无法继续接收分片时，fetch 客户端会暂停该 socket，并在 writer 的 `drain` 事件后恢复，除非操作已经失败或完成。这样可限制 writer 排队字节，而不是允许几乎整个 bundle 在队列中堆积；完整字节/SHA 校验及 writer close 后提升不变。不承诺每个 socket 分片、Node 总 RSS、内核 page cache 或整个操作的墙钟时间上界。

guest bridge 最多允许 64 条同时活动的客户端连接。满载时先关闭新 socket，不创建其上游连接或 relay 线程。每个 bridge 进程首次溢出时向 stderr 输出一条固定诊断，包含上限但不记录 token 或载荷；裸 TCP 拒绝协议不变。双向连接关闭之后才释放名额，避免错误保留已完成客户端的名额。共享 `threading.Lock` 保护 accept 侧检查并占用名额及完成侧归还；连接 upstream 或等待 relay 线程时不持锁，因此正确计数不会把活跃数据流串行化。此上限是裸 TCP 背压，不是 HTTP 429，也不是新的授权策略；不新增用户回调，不改变上游认证，不主动终止健康的慢速流。`maxRequests` 仍是已接受请求次数，不是总时长、单请求字节额度或总计费上限；idle 语义不变，空闲客户端仍占用有界名额直至完成或失败。

### 8.4 证据、审计与剩余边界

便携式生产路径验证现已覆盖：通过真实 CLI 的固定/过期 entropy；非法 manifest 和 bundle 不产生提升输入；生成 bundle 的字节和 SHA 与 `git bundle verify` 一致；`ENOBUFS`/prebuilt 超预算在 token、worker 之前拒绝；实际子进程环境不含宿主凭据；bridge 同时上游峰值最多 64，之后健康客户端仍可完成 echo。在一次性副本中移除上限可产生 65 个并发上游；连接释放后及 echo 后的活动上游为零。这些来自真实命令、Git、UDS 和 TCP，不是另写一套 schema 校验器、只检查文件名，或将 macOS 结果延伸到所有 OS。

Linux 调查使用 aarch64 宿主、真实 Node 22、Git/Python/UDS 夹具和去掉 DAC capabilities 的 root。独立分支部署、更新后的 main 集成、最新 head 的最终 Linux 门禁，以及真实 KVM/vfkit 轮次仍是单独的完成条件；不得由 macOS 测试数或会提前退出的假 launcher 推断。之后每次改动需独立审计并标明实际覆盖的环境。不会仅为这些验证新增 provider、云资源或特权 API 凭据，不修改基线 ref，也不借机修改 `packages/`、`.github/`、`.qwen/skills/` 或 `/review`。

### 8.5 最新输入增量之前的历史 Linux 与真实 KVM 证据

本节记录私有副本及空白凭据修复之前的旧 guest 证据，不证明当前 guest；后续重放见 §§8.6–8.10。

完整相关 Linux 聚焦运行使用真实 Node 22.23.5：11 个文件通过，532 项通过，8 项因环境跳过，原先未处理的 `ECONNRESET` 没有复现。扩展后的 bridge burst 连续六次重放通过，保持原有 96 客户端、64 并发上限、5 秒 poll、排空与健康断言；还验证了真实 upstream 失败恢复、下批前 accept/handler/reject 完成账目，以及恰好一条有界饱和诊断。独立 root 子进程仅清除了 `CAP_DAC_OVERRIDE|CAP_DAC_READ_SEARCH`（mask 6），并核对 effective、permitted、bounding 与 securebit 变化。mode-000 目录的读、写都实际返回 `EACCES`；随后 scratch 清理与 unreadable-worktree-config 两项测试得到 **2 passed，另有 37 项仅因测试名过滤器跳过**，目标未因权限门跳过，没有用普通 root 的结果替代这项证据。

较早的 27 项 build/typecheck/bundle 成就保留为历史里程碑。当前 dirty patch 另行完成了 `npm run build && npm run typecheck && npm run bundle`，有 30 条既有 VSCode warning、0 个错误，并通过聚焦 Prettier、Python AST 与 ESLint。这些是本地构建结果，不替代新远端 head 的 CI；集成新 main 后仍需重新评估，不能按旧日期继承。

| 实际 KVM 场景                      | 证据与边界                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生产默认 spawn 与真实 round input  | 15 项 guest 检查，包括小型真实双 OID bundle 与 manifest/SHA/entropy 一致、真实 model-vsock 绑定、HTTP 200/401/429，以及匹配的 health nonce；仅向本地测试上游产生一次真实请求。除日志捕获版本外，另行重放生产默认 spawn。                          |
| 故障 peer 提供非法 UTF-8           | 3 项 guest 检查：生产 Python 客户端以状态 1 拒绝原始非法字节，没有剩余暂存或提升输入文件。                                                                                                                                                        |
| Unicode header、受控 bridge 与恢复 | 先前的生产 guest SHA256（已由本增量取代） 为 `878f85657e02bbfdd7c2c0a91a501c65a4d17f62dd59f97a5b4ebcb352f53c36`。73 项检查全部通过，释放前实际有 64 条活动上游，overflow 不建立新上游，随后一次恢复尝试即完成健康 echo，teardown 后活动上游为 0。 |

先前重放固定的是先前的生产 guest SHA256 `878f85657e02bbfdd7c2c0a91a501c65a4d17f62dd59f97a5b4ebcb352f53c36` 与派生镜像 SHA256 `a5ca43f3f92a091a29af9170358d9d8ed2c042f7363987b81ac69c64ad5cfbc9`，并断言恰好一条有界饱和诊断。这些场景使用依据固定 kernel/rootfs 资产创建的独立可写派生镜像，并未修改 golden rootfs。报告均完整；实际 backend 为 Linux aarch64 Firecracker/KVM，无 NIC、无目录共享；核对了 token 吊销、工作盘删除及 ownership 清理。所选源码部署逐份核对 SHA，但它是 HEAD 加 dirty patch 的验证夹具，不等同于远端 PR 提交，也不声称完整 qwen-code bundle 能满足 guest 固定的 128 MiB 上限。

两个非法输入场景绑定独立 fault peer，并使用无 `roundInput` 的路径。它们在真实 VM 中执行真实 guest 帧解析器，不声称生产 input server 会发出这些恶意载荷，也不声称因隔离降级而改变其它 guest 路线，或使 legacy 代理配置可用于无网卡 guest。受控 bridge 压测的 upstream 在完成 echo 后结束响应方向，不是只等 guest 关闭而始终保留未完成响应。先前客户端先关闭却未产生 upstream EOF 的尝试，不记为成功 teardown，也不据此声称发现了通用 Firecracker 缺陷。这里验证的是明确的请求/响应完成后再释放名额，而不是针对任意 idle-stream 的 N 秒后终止规则。

本图没有 Apple Virtualization.framework/vfkit、Windows、provider-vm、fcsandbox、完整仓库 VM 轮、外部模型请求、真实 API 凭据或新云资源的证据。最终 main 集成、实际推送 head、其 CI 和评审回复仍是独立检查。本图不构成 PR 合并批准。

### 8.6 先前私有副本与 Unicode 重放证据（2026-11-27）

其后两轮独立审计又识别出 prebuilt 首次校验后的来源替换窗口，以及 Unicode 空白凭据的双端语义差异。有界修复见 §8.2–§8.3。新的真实子进程驱动会在合法 manifest 已生成后，以另一个同尺寸、单链普通文件替换来源，随后实际读取 backend handoff 和真实 input-server UDS。修复前，两个消费者收到替换后的字节，而 manifest 仍保留原摘要；修复后，它们都通过私有 mode-0600 副本收到原始已验证字节及匹配摘要。provider 回调仅作为这条数据流的哨兵，不是云资源分配或真实 VM 报告；该哨兵故意失败所留下的云生命周期错误，不会被记为成功 teardown。

随后的对抗夹具在复制循环已读取一个源分片之后再扩展源文件。预算为 1024 字节时，仅先写入 64 字节，下一分片即被拒绝；调用方且已扩展的源文件保持不变，不会创建分配或 token 文件。另一碰撞用例把调用方的合法输入放在精确的 staging 路径：`EEXIST` 保留该文件及其原始 SHA，而不是无条件清理。两种用例分别能击杀旧的全量复制与非拥有者 unlink 行为，现已纳入正式回归。JSON 字节夹具同样实测可接受的 `4.0`、`4e0`、`18400.0`，拒绝 fractional bundle 大小、PR 编号和代理端口，并逐字节比对保留的 manifest 内容。

彼时三个本地聚焦文件在 macOS arm64/Node 24.18.1 上有 **61 项检查通过**。完整 Linux 相关命令使用当前部署源码，结果为 **11 文件通过、535 项通过、8 项因环境跳过**，并保留原有 5 秒 bridge 轮询和载荷/容量断言。这些是当前应用的实际集成运行，不是远端 CI 统计。权限目标另外在 root 子进程中实际执行 **2 项通过，37 项仅由测试名过滤器跳过**；该子进程清除了 `CAP_DAC_OVERRIDE|CAP_DAC_READ_SEARCH`，并阻止 uid-0 exec 自动恢复 capability。真实 mode-000 目录上的读、写都返回 `EACCES`。

另有普通 Linux TCP/UDS 场景，在没有任何 guest socket/thread monkeypatch 的情况下完成三轮六批重放。每批仍启动 96 个 TCP 客户端，达到 64-client 上限后销毁这些客户端，不隐藏连接错误，且同时要求活动上游归零和 Python 实际线程数回落到启动基线，才允许下一批。三轮的峰值均为 64，每批结束时都回落到 1 个 Python 线程，恰有一条有界饱和诊断，并完成最后八个健康 echo。这比瞬时 `upstreamActive=0` 更严格地闭合生命周期检查；不证明硬件 AF_VSOCK，也不把此前仪器化运行中的偶发倒计时失败上升为对任意调度器的确定性结论。下面的真实 KVM 重放另行覆盖生产硬件传输。

| 先前 KVM 场景                                   | 实测结果                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| healthy 默认生产 spawn 与真实 prebuilt Git 输入 | guest SHA256 `b2540d889c85761f44a7df4b46adb7bb12579fdb687921bb66e56d0366374baf`；派生镜像 SHA256 `8873e973d1af40294ada515d2f80c0cce33e5d79d76ee183844f7ff313aa7180`。**15 项检查全部通过**。小型真实双 OID bundle 被复制进私有 launcher，经 VSOCK 交付，并与 manifest/SHA/entropy 一致。HTTP 200/401/429、health nonce 及一次本机合成上游请求均符合既有的 token 与请求预算。 |
| 故障 peer 提供非法 UTF-8                        | 派生镜像 SHA256 `be91ff6a039d210c3cba277684ca08d3fccb62c1118a53a123f33d10ade809fb`。**3 项检查全部通过**：真实 guest 拒绝原始非法 UTF-8、非零退出，且不遗留提升输入文件。                                                                                                                                                                                                    |
| Unicode header、受控 bridge 与恢复              | 使用相同当前 guest；派生镜像 SHA256 `5d5c2087d58fffe0309f11d967f48fc5e8f2cf19d479e25feffaf64c5a019fb9`。**73 项检查全部通过**。释放前实际有 64 条活动上游，overflow 不建立新上游，一次即恢复 healthy echo，最终无残留活动上游。                                                                                                                                              |

三个 KVM 报告均为完整输出、已销毁 teardown、token 已吊销、worker 已不存在，ownership 清理错误为零，且无 NIC、无目录共享。healthy 使用默认生产 spawn；非法输入场景使用明确的故障 peer/launcher helper，不冒充默认生产 input source。所有镜像均由固定 golden rootfs SHA256 `1ba7902e9c4d5daa6ec1cc4ee03c1e32350b73b3ea0c370e641dc77561c446ac` 与 kernel SHA256 `aee80c3ab9bc2d32f4c00de8ddf919c200359a400aae7c4710e8bc8ad438e1c4` 重新派生，其哈希保持不变。保存报告与元数据后，仅删除本轮新建的私有派生运行目录；一次构建配置失败的半成品也单独识别并删除，没有计成 VM 结果。

输入夹具使用小型真实 Git 仓库，而非完整 qwen-code 历史，因此 guest 固定的 128 MiB 上限仍然成立。本节证据保存在私有 `.qwen/tmp/pr18400-final-v2-kvm-*.json` 与 `.qwen/tmp/pr18400-final-v2-cap-witness.json`，记录的是本机/授权宿主测量，不是已推送 PR 提交、完整云数据面、Apple vfkit、外部模型调用或完整仓库 bundle 的成功证明。私有副本及 Unicode 修复均包含在当前 dirty patch 中。后续无方向与对抗复核在最终的复制与数值改动上未发现进一步可确认的缺陷；但没有证明特殊文件系统的全部行为，包括零进展写入与异常 close，也不替代远端评审。与最新 main 集成、实际推送及 head 身份、CI 和评审回复仍是独立的完成条件。

### 8.7 评审跟进：重试、有界诊断与线程启动失败（2026-11-27）

其后评审核出了 launcher 重试回归、repoDir 生成预算未收紧、Node `spawnSync` 的 stdout/stderr 总缓冲区共享、entropy 校验过晚，以及 bridge 线程启动缺乏保护。有界修复保留既有传输协议与 backend 选择：

- 经完整验证的私有 staging 文件以 `rename` 替换经检查的单链接普通私有 bundle，允许合法复用同一 launcher，包括该 launcher 自身私有 bundle 作为 prebuilt 输入；不再每次都在第二次 `link` 上以 `EEXIST` 失败。既有目录、symlink 或多链接目标仍被拒绝且不会被 unlink。`EEXIST` 仍保留为与本轮排他 staging 文件碰撞的独立语义，不授权删除 caller 输入。复制前的 fd 身份、字节上限、最终完整 SHA 比较及 staging inode 清理仍是承重守卫，不以事后 stat 或相同错误文案代替。
- prebuilt 与 repoDir 都在生成/复制前用 `min(caller 上限, 128 MiB)` 收紧有效载荷预算。故意放大的 caller 值不透传给仓库生成器。64 KiB stderr 诊断余量仅附加于 `spawnSync` 总 cap，不增加 manifest 大小、文件哈希、复制长度或 guest 传输上限。原生与流后预算拒绝保持 `ENOBUFS` 语义；诊断文案中的预算标签是独立的真实载荷上限，而非合并后的缓冲区。
- caller entropy 在 prebuilt 读取/复制或 repoDir 生成之前校验。`run --config` 白名单和 canonical-manifest 校验均保留。Python `Thread.start()` 的 `RuntimeError` 路径归还对应 accepted connection 的名额，在既有 socket 错误处理下关闭该客户端并继续 accept。普通 socket/relay 错误、上游失败恢复、64 客户端上限及完成后释放名额的语义仍由原策略承担；未通过屏蔽未处理异常来掩盖问题。
- manifest 用例新增声明过大 bundle、错误/缺失 schema。成功用例用独立 Python 与 Node 输出目录，逐客户端比较 manifest 原始字节、bundle 字节及 entropy 文件。`Thread.start` 故障注入使用真实 Python/TCP/UDS 执行；原 96 客户端、64 上限、5 秒 burst、半关闭及健康 echo 断言仍由其独立套件承担。

以下证据针对初始 R2 阶段的 dirty 源部署 `qa-r2`，不是已发布的新 head。后续 relay 修改的独立测量见 §8.8。九个实现/测试改动文件被复制到独立 Linux 源树，两侧 SHA-256 完整一致；旧镜像或旧源快照不被当作当前构建。结果：

- macOS arm64、Node 24.18.1：三份相关文件 **65 项通过**。Linux aarch64、Node 22.23.5：全部十一份 `verify-pr*.test.js` **539 项通过、8 项因环境跳过**。capability 子进程记录 `CapEff=0`、`CapBnd=…f9`、`NoNewPrivs=1`，且在 mode-000 存储上的读、写均实际为 `EACCES`。两个选定权限目标真实执行并通过；**38 个跳过仅由测试名过滤造成**，适用于当前增加用例后的套件。没有用普通 root 的成功替代这项见证。
- 初始 R2 的真实 Firecracker/KVM 重放使用当时的 guest SHA256 `24cb22600cba199516be82216da5bb6b7446a09779f59e68c574c238469475d5`。healthy 生产 spawn 与输入传输：镜像 `04c1e60ce2a6d85fcdaf1bf11a2785d094913e7344f6e5621d7e11681a989917`，**15 项检查通过**。显式故障 peer 提供非法 UTF-8：镜像 `c4bfceca92bdc884778625d037b17961b6d22323528fe6f565f585b7d1bbc9b2`，**3 项通过**。Unicode header 拒绝、受控 bridge 与恢复：镜像 `02265b22eba806828b824714e85ffa66baee1d1ebbc7f026f5daa411082c4f11`，**73 项通过**。三项均记录完整输出、destroyed teardown、token 吊销、worker 消失、ownership 清理无错误、无 NIC 和无目录共享。§8.6 所列 golden kernel/rootfs 哈希保持不变。
- guard-removal 对照实际观察到：同长度 rewrite 后到达分配器；bare hard-link 使两轮都报 `EEXIST`；删除 hash-read 预算后读取全部 2,621,440 字节而非在 1,310,720 停止；schema 绕过令非法 manifest 成功；manifest 容量校验缺失后落入 bundle integrity；Python 提升错误字节；48 KiB 诊断使旧总 cap 溢出；repoDir 总 cap 多透传 1 字节；entropy 校验缺失后落到 source ENOENT；未保护的线程启动阻断后续恢复。所有故意失败在恢复修复后才产生上述成功套件。

根目录 build、typecheck、bundle 均已完成，保留原有的 30 条 VSCode warning、0 个错误。证据在本机私有 `.qwen/tmp/pr18400-r2-*` 报告与 harness 元数据中。本段不代表已推送新提交、远端 CI 批准、外部模型调用、云资源分配、Apple vfkit、Windows IPC 或完整仓库输入 bundle 的成功。最终字节身份、main 集成、提交推送、公开 CI 与评审回复仍是独立门槛。

### 8.8 独立 relay 启动跟进评审

后续独立复核区分了 accept 循环线程与两个 relay 半向。只处理外层启动失败，`t2.start()` 失败仍可能在第一个 relay 已活动时打印 traceback。现在内层 `try` 只覆盖 `t1.start()`、`t2.start()` 及相应 join；`RuntimeError` 路径关闭两端以唤醒已启动的 relay，随后继续使用原有 `finally` 关闭与名额归还。`connect_endpoint()` 及其它无关节的 `RuntimeError` 不在这个抑制范围内。没有增加 idle 超时、替代 transport 或 backend 降级。

回归故意让第一个 relay 成功启动、第二个 relay 启动失败，并要求第一个 relay 实际结束，后续两次健康 echo 成功且 stderr 为空。仅删除内层守卫会出现原来的 `Thread-1` / `t2.start()` traceback。故障注入针对生产真实的启动调用，不代表已把内核驱动到 OOM 状态。测试在调用 `Thread.run()` 之前保存 target 判定，因为 CPython 返回时会清除 `_target`，避免把失效的测试观测误认成资源泄漏。旧的条件 checkpoint burst 曾出现偶发 `accepted=97 / completed=95` 偏差。`.qwen/tmp/pr18400-drain-agent-report.md` 中有界三次重放在同样十一文件下均为 540 通过、8 环境跳过，保持 96 客户端、64 并发上限、5 秒与六批 burst 约束不放宽。原 trace 没有失败时刻栈，因此结论仍是 **NOT_REPRODUCED**，不是宣称调度窗口已消除。当前测试只在实际 drain 失败后捕获 SIGUSR1 线程栈，不把取证变成新的等待门限，也不屏蔽 socket 错误。

| 后续重放                           | 实测结果                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64、Node 24.18.1          | 三份聚焦文件 **66 项通过**；仓库完整 lint 也通过。                                                                                                                            |
| Linux aarch64、Node 22.23.5        | 全部十一相关文件 **540 项通过、8 项因环境跳过**；包括有界三次复现运行。                                                                                                       |
| capability-stripped root           | `CapEff=0`、`CapBnd=…f9`、`NoNewPrivs=1`，mode-000 读、写均真实 `EACCES`；**2 个目标实际执行并通过，39 项仅因测试名筛选跳过**。                                               |
| healthy 生产 spawn 与输入传输      | guest `8d00890261d7ab4e7b453209a65df8536cd50f52a28f644fb3b78e42f97b2f8b`；镜像 `d240d2f6550a597c239ec76164933291f8826b4bc1957ed823be6ece0f43a230`；**15 项通过**。            |
| 故障 peer 提供非法 UTF-8           | 同一当前 guest；镜像 `bb7979006f1b52d1e5d9ecd5c885f66df3fcfab173617a1a0781996cda27a097`；**3 项通过**。                                                                       |
| Unicode header、受控 bridge 与恢复 | 同一当前 guest；镜像 `ab618e88050dd19fb48f374299dd0d0d508e2d23d44ec045bd0282f780604e07`；**73 项通过**，释放前 64 活动上游，overflow 无新上游，一次健康恢复，最终无活动上游。 |

三份新 KVM 报告均记录完整输出、destroyed teardown、token 吊销、worker 消失与 ownership 清理零错误，且无 NIC、无目录共享。它们是真实 Linux Firecracker/KVM 场景，不替代注入式线程故障或外部 provider 证明。golden kernel/rootfs 哈希保持不变。输入诊断继续在错误文案中标明真正的载荷预算，同时区分 bundle 大小与诊断输出溢出，避免把 stderr 噪声误报成扩大载荷上限的证据。

相应证据在 `.qwen/tmp/pr18400-r3-kvm-*`、`.qwen/tmp/pr18400-r2-cap-witness.py` 及其输出记录中，新实现的 SHA 与 Linux 部署一致。main 集成、精确提交 archive 身份、最新公开 CI 与评审回复仍是独立检查。不宣称云资源分配、Apple vfkit、Windows IPC、外部模型调用、完整仓库输入 bundle 或合并批准。

### 8.9 评审驱动的证据强化

后续评审要求真正观测每个守卫，而不只是增加测试数量。以下修改只作用于测试、测试驱动和说明，不改变既有预算或 socket 协议。

- **用饱和现场证明名额归还。**启动故障注入后，63 个保持连接建立起 63 个真实上游 socket。随后两次健康 echo 正常复用剩余名额。每次连接前还等待前一对 relay 完成，因为 TCP 关闭回声本身不证明名额已经归还。销毁保持连接后，65 对 relay 均须完成，两个启动故障变体各自保持预期的完成计数。只删除外层 `finish_client()`，下一次健康客户端就以 `ECONNRESET` 失败，bridge 恰好输出一次 64-client 饱和诊断。这样不靠扩大连接总数或提高上限，就能区分漏归还一个槽位与正确归还。
- **区分原生预算错误和流后预算检查。**真实 Git 导出包含 2 MiB 随机文件内容，且 `maxBundleBytes=1048576` 时，触发原生 `spawnSync` 的 ENOBUFS。断言保留 `code=ENOBUFS`、原生子进程错误信息及 `cause.syscall === 'spawnSync git'`，避免把后续预算分支构造的 cause 当作原生错误。错误若错用总 buffer 会显示 `(1..1114112)`，而不是实际载荷上限 `(1..1048576)`，用例会转红，且不会提升超大输出。原有小 cap 用例继续单独覆盖流后长度校验，不把它当成原生映射证据。
- **实测诊断字节，而非自证常量。**测试包装器记录 bundle 创建子进程的真实 `result.stderr.length`，要求每次观测至少为 48 KiB；不记录诊断内容。两次正常 Git 执行均观测到 49,152 字节。把注入改为零诊断字节时，观测为 `[0,0]` 且 `pass:false`，不再让硬编码的 `diagnosticBytes` 掩盖故障。`[98304,134283264]` 的其它预算断言保持不变。
- **双语状态段的证据范围一致。**中英文都包含先前 Linux、capability 探测与 KVM 测量仅为历史证据，并指向确切源码和不支持环境的边界，均不以单独的旧 guest 摘要暗示当前认证。

本增量实测为：本机三份聚焦文件 **67 passed**；`qa-r3-final` 的 Linux 十一文件 **541 passed、8 environment skips**；受限 root 权限目标 **2 passed、40 个仅由测试名过滤跳过**。`scripts/verify-pr-vm-guest-vsock.py` 保持已用于 KVM 报告的 `8d00890261d7ab4e7b453209a65df8536cd50f52a28f644fb3b78e42f97b2f8b`，channel 与 runner 的 SHA 也未变。本增量是测试和说明修订，不是用旧 guest 冒称新 replay。

扩展饱和用例之初还出现过一次 90 秒的 inner relay 超时，随后聚焦重放和完整 Linux 套件均通过。原触发没有再次重现，不能把反复通过当成已修复。现在测试在失败时保留阶段、客户端 readiness、真实上游数量及完成数，未延长时限；这仍不是对所有调度时序的普遍证明。

### 8.10 Bridge 监听队列、名额归还同步与有界诊断（R4 / F5 / F6）

对 96 客户端 burst 排空失败做 Linux 并发加载复现，捕获到实时 SIGUSR1 线程栈与对端归因日志（`.qwen/tmp/pr18400-f5-live-attribution.json`），从而查明了此前未解释的间歇性排空失败（`accepted=96 / completed=94` 以及早期的 `accepted=97 / completed=95`）：

- **根因（F5）：`server.listen(32)` 仅为 `MAX_BRIDGE_CONNECTIONS = 64` 的一半。**在开启 `net.ipv4.tcp_syncookies = 1`、`tcp_abort_on_overflow = 0`、`tcp_tw_reuse = 2` 的 Linux 6.6 上，96 客户端突发溢出 32 槽监听队列，引发 1 秒 SYN 重传空洞，并在某客户端（`127.0.0.1:46658`，在 `seq 135` 被拒关闭）已被 Node 侧关闭后，由重传握手包再次合成出第二条已建连服务端 socket（`seq 149`，不同 inode）。由于两条 `relay_half` 线程都在 `recv()` 上被动等待，这条幽灵连接永久占用一个 bridge 槽位和一条上游连接（`upstream.active = 1`）。
- **受控 A/B 证实。**在隔离 Linux 副本中以 4 路并发各跑 6 波（共 24 次）：仅将 `server.listen(32)` 改为 `server.listen(128)`（保留 `sys.setswitchinterval(0.000001)` 与原 `checkpoint()`）取得 **24/24 全通过**；相反，保留 `server.listen(32)` 而仅移除 `setswitchinterval` 并精简 `checkpoint()` 写盘仍有 **3/24 失败**。现将生产监听改为 `server.listen(max(128, MAX_BRIDGE_CONNECTIONS * 2))`，保持 `MAX_BRIDGE_CONNECTIONS = 64`、单条饱和诊断及全部突发/时限断言不变。
- **名额归还同步（R4-1）与快速失败诊断（F6）。**先前仅等待 `relay_half` 结束（`relay-done`）早于 `handle_bridge_client` 的 `finally: on_done()`（`finish_client()`），在高负载 63/64 饱和时会导致第二次健康 echo 偶发撞限流。现改以 `handle_bridge_client` 退出（`client-done`，严格晚于 `on_done()` 返回）作为恢复 echo 间的同步点，并对 `failed.closed` 以及健康 `once(client, 'data')` 增加与 `healthy.closed` 及 5 秒 `AbortController` 的有界竞速，使干净 TCP FIN 拒绝毫秒级失败并真实进入 `catch` 输出诊断快照，而非挂起到 90 秒。burst 夹具的 epoch 快照也移出 `counts_lock`，在 drain 完成或每 32 次事件单调写盘，同时保留 `sys.setswitchinterval(0.000001)`。

| R4 / F5 / F6 实测                             | 结果                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64、Node 24.18.1                     | 三份聚焦文件 **67 项通过**；变更测试与文档通过 ESLint 与 Prettier。                                                                                                                                                             |
| Linux aarch64、Node 22.23.5（`qa-r4-verify`） | 十一相关文件 **541 项通过、8 项环境跳过**（`bounds guest bridge concurrency` 用时 2.24 秒）。                                                                                                                                   |
| Linux 并发加载压测                            | 饱和槽位恢复 **24/24 通过**（6 波 × 4 并发）；96 客户端 burst **32/32 通过**（8 波 × 4 并发），保持 96 客户端、64 上限、5 秒 poll、六批与 `setswitchinterval(0.000001)` 不变。                                                  |
| Linux 守卫移除负控制                          | 删除 `on_done()`（S1，4.37s）、外层 `finish_client()`（S2，3.39s）或内层 `RuntimeError` shutdown（S3，8.70s）均快速失败并实际输出 `catch` JSON 诊断（S1/S2 含 `connection limit 64 reached`，S3 含 `RuntimeError` traceback）。 |
| capability-stripped root                      | `CapEff=0`、`CapBnd=…f9`、`NoNewPrivs=1`，mode-000 读写均返回 `EACCES`；**2 项通过、40 项仅由测试名过滤跳过**。                                                                                                                 |
| healthy 真实 KVM 重放（新 guest 字节）        | guest `9cc5977f3edb9ec7b11d9c42a3b86b4bbc6fe951b4079342eccfd8340b7f70f6`；镜像 `5df6986ab567b6e30162cd8f10fa7e5281a79588d12785c57f89b9ad597598b7`；**15 项通过**。                                                              |
| 故障 peer 非法 UTF-8 KVM 重放                 | 同一新 guest；镜像 `2ac77ea9dd634f98de7c4b5612141710e78dd3ec3604a4170d085813c8a44226`；**3 项通过**。                                                                                                                           |
| Unicode header / 受控 bridge KVM 重放         | 同一新 guest；镜像 `b1cb2f6230273f5941e6b70b4388522a5a6ead8816bb9c84071d190e6b77d4a2`；**73 项通过**，释放前 64 条活动上游，最终残余活动上游为 0。                                                                              |

三份新 KVM 报告均记录完整输出、destroyed teardown、token 吊销、worker 消失、ownership 清理零错误、无 NIC 和无目录共享，且 golden kernel/rootfs 哈希未变（`.qwen/tmp/pr18400-r4-kvm-*.json` 与 `.qwen/tmp/pr18400-r4-linux-matrix.json`）。推送 head 的远端 CI、维护者评审批准、云数据面 provider、Apple vfkit、Windows IPC、外部模型调用与完整仓库输入 bundle 仍是独立边界。
