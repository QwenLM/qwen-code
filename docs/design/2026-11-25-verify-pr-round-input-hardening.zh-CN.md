# `/verify-pr` 轮次输入交接加固

[English](2026-11-25-verify-pr-round-input-hardening.md) | [简体中文](2026-11-25-verify-pr-round-input-hardening.zh-CN.md)

**状态：已实现并完成本机验证；独立复核及远端发布检查仍未结束。当前 dirty patch 在 macOS arm64、Node 24.18.1 上的三个相关文件有 61 项聚焦检查通过。相同部署源码在真实 Node 22.23.5 的完整 Linux 相关命令中为 11 文件、535 项通过、8 项因环境跳过。当前 guest SHA256 `b2540d889c85761f44a7df4b46adb7bb12579fdb687921bb66e56d0366374baf` 已通过 Linux aarch64 真实 Firecracker/KVM 的 healthy transport（15 项）、非法 UTF-8（3 项）与受控 bridge 容量/恢复（73 项）。另经 capability-stripped root 实际验证，两个权限目标均被执行，2 项通过、37 项仅因测试名过滤器跳过。确切的源码、KVM 和未覆盖环境边界见 §8.6。不宣称远端提交 CI 或合并已获批准。日期：2026-11-25；后续证据：2026-11-27。**

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

在现有 `resolvedRoundInput` 白名单中增加 `entropyHex: rawRoundInput.entropyHex`。不新增另一个摘要输入，也不绕过 canonical manifest 构造。`buildInputManifest` 继续负责校验“恰好 64 个小写十六进制字符”，并在未提供 entropy 时保留其默认随机 32 字节。

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

bundle 生成使用 `git bundle create -`，已验证 stdout 能形成有效 Git bundle。`maxBuffer` 等于 `maxBundleBytes`，超过允许载荷时，在创建临时输出文件之前返回错误。错误保留 `allowed range` 文案和原始 `ENOBUFS` cause。stdout 仍以 256 KiB 分块计算 SHA，随后按既有 mode 检查和 rename 完成。这是此创建器所缓冲、写出的载荷字节预算，不是 Node 总 RSS、内核 page cache 或全部仓库/object-store 资源的绝对上限。实际尝试导出 qwen-code 的两个 OID 及完整 base 历史时，输出超过 128 MiB，保留原始 `ENOBUFS` cause 后终止，没有生成输出 bundle。传输夹具必须单独构造真实的小型双 OID Git 仓库；它不证明本仓库完整输入的交接。本切片不扩大预算、不发送截断 bundle、不静默切到宿主/共享内核路径，也不声称完整仓库 VM 轮次成功。

Node fetch 客户端在创建输出目录或连接 socket 之前，先要求 `maxBundleBytes` 与 `maxManifestBytes` 是正的安全整数。非有限上限不能在缓冲输入时使比较失效；非法上限不产生请求或输出目录。

prebuilt bundle 会分别按路径元数据和已打开 fd 执行 `maxBundleBytes` 检查。哈希循环还会在实际累计读取量超过有效预算时拒绝，并返回该读取量及 fd 的 dev/ino/nlink。拒绝发生在分片累计越过预算之后，并不承诺底层 read 调用绝不会返回超过 `maxBytes` 的数据。随后再次检查的路径元数据必须与 fd 的 dev/ino 和已哈希字节数一致，避免把某一文件状态的摘要和另一状态的大小或身份拼接起来。实际 `bundleBytes` 仍受 guest 既有 128 MiB 传输上限约束，即使调用者为余量配置更大的宿主预算。较大的预算本身不改变 guest 限制：实际小 bundle 仍可使用，超过 128 MiB 的 bundle 会在写 token 文件、创建 listener 或分配 backend 之前被拒绝。空文件或超预算文件在 token 创建、模型 listener 和 launcher 之前失败。读取使用 `O_NOFOLLOW|O_NONBLOCK`、`fstat` 和分块哈希；不把多链普通文件误改判为非普通文件，既有单链和共享 inode 拒绝仍然有效。

随后以 no-follow 方式重新打开 prebuilt 源 fd，并把其身份及大小与首次核验比对。私有暂存文件通过独占方式创建，并经 fd 设为 mode 0600。复制按 256 KiB 分片推进：累计读取量必须保持在调用方预算和固定 guest 上限内，才允许写入该分片；读完 EOF 后必须同时满足原始字节数与 SHA-256 一致。与哈希读取器相同，单次 read 可能先越过预算才被拒绝；检测到越界后不会写入该分片。提升通过独占硬链接完成，不会覆盖已存在的私有目标，而 staging 清理只针对本轮实际创建的 inode。取得所有权前发生 `EEXIST` 时保留调用方输入，随后身份不符时阻止 unlink 而不是删除替代对象。清理错误在清理块之后报告，不会遮蔽原始预算或复制错误。注入 backend 与 input server 都收到已验证的私有副本，而非调用方可能继续修改的来源路径。整个 bundle 不会被缓冲进内存；这些保证不宣称受信宿主操作者无法改写自己拥有的私有文件。

Node writer 无法继续接收分片时，fetch 客户端会暂停该 socket，并在 writer 的 `drain` 事件后恢复，除非操作已经失败或完成。这样可限制 writer 排队字节，而不是允许几乎整个 bundle 在队列中堆积；完整字节/SHA 校验及 writer close 后提升不变。不承诺每个 socket 分片、Node 总 RSS、内核 page cache 或整个操作的墙钟时间上界。

guest bridge 最多允许 64 条同时活动的客户端连接。满载时先关闭新 socket，不创建其上游连接或 relay 线程。每个 bridge 进程首次溢出时向 stderr 输出一条固定诊断，包含上限但不记录 token 或载荷；裸 TCP 拒绝协议不变。双向连接关闭之后才释放名额，避免错误保留已完成客户端的名额。共享 `threading.Lock` 保护 accept 侧检查并占用名额及完成侧归还；连接 upstream 或等待 relay 线程时不持锁，因此正确计数不会把活跃数据流串行化。此上限是裸 TCP 背压，不是 HTTP 429，也不是新的授权策略；不新增用户回调，不改变上游认证，不主动终止健康的慢速流。`maxRequests` 仍是已接受请求次数，不是总时长、单请求字节额度或总计费上限；idle 语义不变，空闲客户端仍占用有界名额直至完成或失败。

### 8.4 证据、审计与剩余边界

便携式生产路径验证现已覆盖：通过真实 CLI 的固定/过期 entropy；非法 manifest 和 bundle 不产生提升输入；生成 bundle 的字节和 SHA 与 `git bundle verify` 一致；`ENOBUFS`/prebuilt 超预算在 token、worker 之前拒绝；实际子进程环境不含宿主凭据；bridge 同时上游峰值最多 64，之后健康客户端仍可完成 echo。在一次性副本中移除上限可产生 65 个并发上游；连接释放后及 echo 后的活动上游为零。这些来自真实命令、Git、UDS 和 TCP，不是另写一套 schema 校验器、只检查文件名，或将 macOS 结果延伸到所有 OS。

Linux 调查使用 aarch64 宿主、真实 Node 22、Git/Python/UDS 夹具和去掉 DAC capabilities 的 root。独立分支部署、更新后的 main 集成、最新 head 的最终 Linux 门禁，以及真实 KVM/vfkit 轮次仍是单独的完成条件；不得由 macOS 测试数或会提前退出的假 launcher 推断。之后每次改动需独立审计并标明实际覆盖的环境。不会仅为这些验证新增 provider、云资源或特权 API 凭据，不修改基线 ref，也不借机修改 `packages/`、`.github/`、`.qwen/skills/` 或 `/review`。

### 8.5 最新输入增量之前的历史 Linux 与真实 KVM 证据

本节记录私有副本及空白凭据修复之前的旧 guest 证据，不证明当前 guest；当前源码的新重放见 §8.6。

完整相关 Linux 聚焦运行使用真实 Node 22.23.5：11 个文件通过，532 项通过，8 项因环境跳过，原先未处理的 `ECONNRESET` 没有复现。扩展后的 bridge burst 连续六次重放通过，保持原有 96 客户端、64 并发上限、5 秒 poll、排空与健康断言；还验证了真实 upstream 失败恢复、下批前 accept/handler/reject 完成账目，以及恰好一条有界饱和诊断。独立 root 子进程仅清除了 `CAP_DAC_OVERRIDE|CAP_DAC_READ_SEARCH`（mask 6），并核对 effective、permitted、bounding 与 securebit 变化。mode-000 目录的读、写都实际返回 `EACCES`；随后 scratch 清理与 unreadable-worktree-config 两项测试得到 **2 passed，另有 37 项仅因测试名过滤器跳过**，目标未因权限门跳过，没有用普通 root 的结果替代这项证据。

较早的 27 项 build/typecheck/bundle 成就保留为历史里程碑。当前 dirty patch 另行完成了 `npm run build && npm run typecheck && npm run bundle`，有 30 条既有 VSCode warning、0 个错误，并通过聚焦 Prettier、Python AST 与 ESLint。这些是本地构建结果，不替代新远端 head 的 CI；集成新 main 后仍需重新评估，不能按旧日期继承。

| 实际 KVM 场景                      | 证据与边界                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生产默认 spawn 与真实 round input  | 15 项 guest 检查，包括小型真实双 OID bundle 与 manifest/SHA/entropy 一致、真实 model-vsock 绑定、HTTP 200/401/429，以及匹配的 health nonce；仅向本地测试上游产生一次真实请求。除日志捕获版本外，另行重放生产默认 spawn。      |
| 故障 peer 提供非法 UTF-8           | 3 项 guest 检查：生产 Python 客户端以状态 1 拒绝原始非法字节，没有剩余暂存或提升输入文件。                                                                                                                                    |
| Unicode header、受控 bridge 与恢复 | 当前生产 guest SHA256 为 `878f85657e02bbfdd7c2c0a91a501c65a4d17f62dd59f97a5b4ebcb352f53c36`。73 项检查全部通过，释放前实际有 64 条活动上游，overflow 不建立新上游，随后一次恢复尝试即完成健康 echo，teardown 后活动上游为 0。 |

当前重放固定生产 guest SHA256 `878f85657e02bbfdd7c2c0a91a501c65a4d17f62dd59f97a5b4ebcb352f53c36` 与派生镜像 SHA256 `a5ca43f3f92a091a29af9170358d9d8ed2c042f7363987b81ac69c64ad5cfbc9`，并断言恰好一条有界饱和诊断。这些场景使用依据固定 kernel/rootfs 资产创建的独立可写派生镜像，并未修改 golden rootfs。报告均完整；实际 backend 为 Linux aarch64 Firecracker/KVM，无 NIC、无目录共享；核对了 token 吊销、工作盘删除及 ownership 清理。所选源码部署逐份核对 SHA，但它是 HEAD 加 dirty patch 的验证夹具，不等同于远端 PR 提交，也不声称完整 qwen-code bundle 能满足 guest 固定的 128 MiB 上限。

两个非法输入场景绑定独立 fault peer，并使用无 `roundInput` 的路径。它们在真实 VM 中执行真实 guest 帧解析器，不声称生产 input server 会发出这些恶意载荷，也不声称因隔离降级而改变其它 guest 路线，或使 legacy 代理配置可用于无网卡 guest。受控 bridge 压测的 upstream 在完成 echo 后结束响应方向，不是只等 guest 关闭而始终保留未完成响应。先前客户端先关闭却未产生 upstream EOF 的尝试，不记为成功 teardown，也不据此声称发现了通用 Firecracker 缺陷。这里验证的是明确的请求/响应完成后再释放名额，而不是针对任意 idle-stream 的 N 秒后终止规则。

本图没有 Apple Virtualization.framework/vfkit、Windows、provider-vm、fcsandbox、完整仓库 VM 轮、外部模型请求、真实 API 凭据或新云资源的证据。最终 main 集成、实际推送 head、其 CI 和评审回复仍是独立检查。本图不构成 PR 合并批准。

### 8.6 当前输入交接与重放证据（2026-11-27）

其后两轮独立审计又识别出 prebuilt 首次校验后的来源替换窗口，以及 Unicode 空白凭据的双端语义差异。有界修复见 §8.2–§8.3。新的真实子进程驱动会在合法 manifest 已生成后，以另一个同尺寸、单链普通文件替换来源，随后实际读取 backend handoff 和真实 input-server UDS。修复前，两个消费者收到替换后的字节，而 manifest 仍保留原摘要；修复后，它们都通过私有 mode-0600 副本收到原始已验证字节及匹配摘要。provider 回调仅作为这条数据流的哨兵，不是云资源分配或真实 VM 报告；该哨兵故意失败所留下的云生命周期错误，不会被记为成功 teardown。

随后的对抗夹具在复制循环已读取一个源分片之后再扩展源文件。预算为 1024 字节时，仅先写入 64 字节，下一分片即被拒绝；调用方且已扩展的源文件保持不变，不会创建分配或 token 文件。另一碰撞用例把调用方的合法输入放在精确的 staging 路径：`EEXIST` 保留该文件及其原始 SHA，而不是无条件清理。两种用例分别能击杀旧的全量复制与非拥有者 unlink 行为，现已纳入正式回归。JSON 字节夹具同样实测可接受的 `4.0`、`4e0`、`18400.0`，拒绝 fractional bundle 大小、PR 编号和代理端口，并逐字节比对保留的 manifest 内容。

当前三个本地聚焦文件在 macOS arm64/Node 24.18.1 上有 **61 项检查通过**。完整 Linux 相关命令使用当前部署源码，结果为 **11 文件通过、535 项通过、8 项因环境跳过**，并保留原有 5 秒 bridge 轮询和载荷/容量断言。这些是当前应用的实际集成运行，不是远端 CI 统计。权限目标另外在 root 子进程中实际执行 **2 项通过，37 项仅由测试名过滤器跳过**；该子进程清除了 `CAP_DAC_OVERRIDE|CAP_DAC_READ_SEARCH`，并阻止 uid-0 exec 自动恢复 capability。真实 mode-000 目录上的读、写都返回 `EACCES`。

另有普通 Linux TCP/UDS 场景，在没有任何 guest socket/thread monkeypatch 的情况下完成三轮六批重放。每批仍启动 96 个 TCP 客户端，达到 64-client 上限后销毁这些客户端，不隐藏连接错误，且同时要求活动上游归零和 Python 实际线程数回落到启动基线，才允许下一批。三轮的峰值均为 64，每批结束时都回落到 1 个 Python 线程，恰有一条有界饱和诊断，并完成最后八个健康 echo。这比瞬时 `upstreamActive=0` 更严格地闭合生命周期检查；不证明硬件 AF_VSOCK，也不把此前仪器化运行中的偶发倒计时失败上升为对任意调度器的确定性结论。下面的真实 KVM 重放另行覆盖生产硬件传输。

| 当前 KVM 场景                                   | 实测结果                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| healthy 默认生产 spawn 与真实 prebuilt Git 输入 | guest SHA256 `b2540d889c85761f44a7df4b46adb7bb12579fdb687921bb66e56d0366374baf`；派生镜像 SHA256 `8873e973d1af40294ada515d2f80c0cce33e5d79d76ee183844f7ff313aa7180`。**15 项检查全部通过**。小型真实双 OID bundle 被复制进私有 launcher，经 VSOCK 交付，并与 manifest/SHA/entropy 一致。HTTP 200/401/429、health nonce 及一次本机合成上游请求均符合既有的 token 与请求预算。 |
| 故障 peer 提供非法 UTF-8                        | 派生镜像 SHA256 `be91ff6a039d210c3cba277684ca08d3fccb62c1118a53a123f33d10ade809fb`。**3 项检查全部通过**：真实 guest 拒绝原始非法 UTF-8、非零退出，且不遗留提升输入文件。                                                                                                                                                                                                    |
| Unicode header、受控 bridge 与恢复              | 使用相同当前 guest；派生镜像 SHA256 `5d5c2087d58fffe0309f11d967f48fc5e8f2cf19d479e25feffaf64c5a019fb9`。**73 项检查全部通过**。释放前实际有 64 条活动上游，overflow 不建立新上游，一次即恢复 healthy echo，最终无残留活动上游。                                                                                                                                              |

三个 KVM 报告均为完整输出、已销毁 teardown、token 已吊销、worker 已不存在，ownership 清理错误为零，且无 NIC、无目录共享。healthy 使用默认生产 spawn；非法输入场景使用明确的故障 peer/launcher helper，不冒充默认生产 input source。所有镜像均由固定 golden rootfs SHA256 `1ba7902e9c4d5daa6ec1cc4ee03c1e32350b73b3ea0c370e641dc77561c446ac` 与 kernel SHA256 `aee80c3ab9bc2d32f4c00de8ddf919c200359a400aae7c4710e8bc8ad438e1c4` 重新派生，其哈希保持不变。保存报告与元数据后，仅删除本轮新建的私有派生运行目录；一次构建配置失败的半成品也单独识别并删除，没有计成 VM 结果。

输入夹具使用小型真实 Git 仓库，而非完整 qwen-code 历史，因此 guest 固定的 128 MiB 上限仍然成立。本节证据保存在私有 `.qwen/tmp/pr18400-final-v2-kvm-*.json` 与 `.qwen/tmp/pr18400-final-v2-cap-witness.json`，记录的是本机/授权宿主测量，不是已推送 PR 提交、完整云数据面、Apple vfkit、外部模型调用或完整仓库 bundle 的成功证明。私有副本及 Unicode 修复均包含在当前 dirty patch 中。后续无方向与对抗复核在最终的复制与数值改动上未发现进一步可确认的缺陷；但没有证明特殊文件系统的全部行为，包括零进展写入与异常 close，也不替代远端评审。与最新 main 集成、实际推送及 head 身份、CI 和评审回复仍是独立的完成条件。
