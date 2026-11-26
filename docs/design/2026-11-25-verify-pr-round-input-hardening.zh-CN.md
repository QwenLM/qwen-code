# `/verify-pr` 轮次输入交接加固

[English](2026-11-25-verify-pr-round-input-hardening.md) | [简体中文](2026-11-25-verify-pr-round-input-hardening.zh-CN.md)

**状态：已实现，并在 macOS arm64、Node 24.18.1 上完成本地验证（27 项聚焦测试，以及 build、typecheck、bundle）。2026-11-26 于同一工具链依据 `aa027f065eb3c26bee55739fdbf9220428f11cc6` 复核同样结果。硬件传输验证不在本次范围内。日期：2026-11-25。**

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

测试在隔离临时根目录下建立一个已存在、可搜索但不可写的输出父目录（mode 0500）。嵌套 `outPath` 在前置 `lstat` 中返回 `ENOENT`，随后 scratch 创建成功，真实 `mkdirSync(..., {recursive: true})` 才以 `EACCES`/`EPERM` 失败。普通文件阻挡路径作为对照：前置 `ENOTDIR` 拒绝发生在 scratch 创建之前，不能误当成泄漏证据。权限夹具要求非 root 用户；root 绕过权限检查的情形不能记为通过。测试在删除夹具前恢复目录权限，不 mock Git 或文件系统。显式 base/head OID、只读 alternates、不复制 `.git/config`、不导出私有分支或秘密文件、原子替换输出的现有校验保持不变。

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
