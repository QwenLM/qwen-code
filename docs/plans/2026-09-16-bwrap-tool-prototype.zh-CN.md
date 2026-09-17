# bwrap 工具执行原型

[English](2026-09-16-bwrap-tool-prototype.md) | [简体中文](2026-09-16-bwrap-tool-prototype.zh-CN.md)

## 范围与状态

实施[统一沙箱设计](../design/2026-09-16-tool-execution-sandbox.zh-CN.md)的第一步可行性验证。这是由开发者运行的原型，不是已发布的沙箱或配置迁移。生产启动器、权限与配置保持原状。下方结果必须区分真实 Linux 观测与尚未实施的发布要求。

本文记录已完成的 v7 可行性阶段。当前验证脚本已迁移到[沙箱执行 API](../design/2026-09-16-sandbox-execution-api.zh-CN.md)，直接打包已修改的 core 服务、relay 和 worker，不再包含临时宿主 shell 启动器。下方 v7 hash 与结果保留为历史证据。

## 实施方式

原型放在 `scripts/sandbox-prototype/`。为实验单独打包现有 `ShellExecutionService`，不修改其实现。可信适配器校验测试根，构建 bwrap 参数并安全引用为固定 `exec` 包装命令，交由现有服务执行。这一临时适配器验证服务的 PTY/管道生命周期；生产实现仍须在最终启动边界直接传递 executable/argv，并落实启动环境与描述符控制。

采用只读根、一个准入工作区、私有临时目录、最小设备、私有 PID namespace 和新 procfs。命令网络明确设置为 open 或 closed。拒绝与 HOME/祖先、可信安装/状态或 procfs 重叠的工作区授权。原型只接受操作者创建的测试根；Git 发现和可配置附加根不在范围内。

独立安装的文件 worker 通过 stdin 接收单次、有大小上限的 JSON 写入请求。目录创建、临时写入、新鲜度验证和原子 rename 都在 bwrap 内执行。父进程不打开目标写入。实验仅支持 UTF-8 文本和明确的旧内容预期；完整编码、二进制、文件模式和工具结果兼容性留待接入阶段。

使用可信、一次性的宿主 HTTP/状态测试服务，证明命令禁网时宿主通信与状态写入仍然正常。这不是完整模型 turn。验证真实 namespace 身份、宿主 procfs 不可见、PTY 输入/resize/Ctrl+C、超时/取消、后台晋升，以及约束设置失败时在 payload 执行前拒绝。文件边界独立于 shell 命令验证。

## 验证与证据

可执行测试计划与原始本地报告放在 `.qwen/e2e-tests/bwrap-tool-prototype.md`。先记录全局 CLI 基线。在真实 Linux 上运行原型，正向证据绝不使用替代 bwrap。加入窄范围负对照，证明移除约束后越界写与网络断言会失败。验证后代进程终止，并将依赖与共享 macOS 安装隔离。

执行构建、类型检查、打包、变更脚本的 lint/格式检查及独立原型验证。执行后在此记录准确环境、命令、检查结果、限制及可行性失败。这些检查不代表已交付运行时沙箱功能。

### 复现方式

在具有 Node >= 22、`/usr/bin/bwrap`、`/bin/bash` 和 `setsid` 的 Linux 上，将原型构建到可写测试工作区之外的新安装目录：

```sh
node scripts/sandbox-prototype/build.mjs /tmp/qwen-prototype-install
npm install --prefix /tmp/qwen-prototype-install --ignore-scripts --no-audit --no-fund @lydell/node-pty@1.2.0-beta.10
node /tmp/qwen-prototype-install/verify.mjs
```

构建需要仓库已安装开发依赖。也可以在 macOS 构建 JavaScript bundle 后复制到 Linux；原生 PTY 依赖只在 Linux 安装。验证器创建并删除独立测试目录，以最小环境重新执行，校验产物 hash，并输出逐项结果与 JSON 报告。缺少前提时失败，不能跳过后显示通过。安装产物与原生依赖目录保留用于复现，测试目录清理单独验证。

## 结果

于 2026-09-16 完成，源码基线为 `04721b5dca49e2a100de4d84257a7fa945a698a3`。独立最终运行 **23/23 项检查通过**：22 项功能/安全用例加测试目录清理，退出码 0，无跳过。环境为 Lima `qwen-sbx`、Linux `7.0.0-31-generic`、ARM64、Node `v22.22.1`、bubblewrap `0.11.1` 和 `@lydell/node-pty@1.2.0-beta.10`。没有修改内核/AppArmor 设置。

| 领域                 | 实际结果                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件系统与 namespace | 真实私有 PID namespace 及与之对应的新 procfs；宿主进程 root 别名不可达；工作区写入成功，越界写入失败；只读与受保护根策略拒绝写入/授权。                                     |
| 宿主分离与网络       | 工具禁网时，宿主 loopback HTTP 与状态写入继续正常。同一工具请求在开放网络时成功。这些是宿主测试服务，不是真实模型 turn。                                                    |
| 现有 shell 生命周期  | 管道与真实 PTY 都通过。覆盖 PTY 输入/resize、终端 Ctrl+C、取消、超时、后台移交/输出/结束通知、脱离会话的后代进程及父进程死亡。PTY 依赖缺失时回退管道，同时保留 bwrap 约束。 |
| 文件 worker          | 嵌套创建、原子替换、陈旧内容拒绝、越界/父目录符号链接逃逸拒绝及输入大小限制通过。独立检查还验证了只读工作区中的写入拒绝。                                                   |
| 失败与清理           | bwrap 缺失、挂载设置失败时不会产生 payload 标记；失败 payload 只执行一次。清理通过 PID/启动时间核对进程身份，并在登记 namespace 成员之前拒绝宿主 namespace。                |

三项独立、限定范围的变异对照证明断言能发现约束缺失：移除网络隔离后，请求从退出 17 变为退出 0；仅授予一次性越界文件写权限后，拒绝检查从退出 0 变为退出 42；移除 PID 隔离后，namespace 身份断言失败。这些对照绝不在无约束状态下运行整套测试。

`npm run build`、`npm run typecheck`、`npm run bundle`、脚本 lint/格式检查和双语文档检查均通过。独立执行 `node dist/cli.js --version` 返回 `0.23.4`，这仅为 bundle 冒烟检查。代码审查发现并关闭了测试脚本清理风险：先拒绝宿主 namespace，再枚举 PID；对应负例在断言失败时也恢复清理集合。没有剩余阻塞审查项。

最终验证脚本 SHA-256 为 `d7a0ec63dc4c1c8420bf083905d81da44e8a0352f9735e0c34db92df04738dfa`；打包的未修改 shell 服务为 `d57553153ea82bf0c404dba1264a34e2e9bcf2929e333b8f52184b3928db5564`。原始证据位于 `.qwen/e2e-tests/bwrap-tool-prototype-independent-v7.log`、`.qwen/e2e-tests/bwrap-tool-prototype-independent-controls.log` 及对应测试计划。安装 manifest 记录了全部打包输入和产物 hash。

## 对生产接入的结论

v7 结束时仍有以下前提。上方链接的后续内部 API 阶段处理第 1–2 项，面向用户的工具接入仍待完成。

1. 将结构化的 executable/argv/environment 启动计划传入两处实际 spawn。原型的宿主 shell 包装不是生产安全边界；最小驱动环境只在本实验内避免启动注入。
2. 实现兼容管道与 PTY 的可信启动状态通道。当前服务既不提供额外控制描述符，也不提供 worker stdin 传输。测试标记只能证明已测用例，不能作为通用启动状态协议。
3. 保留信号语义：终端 Ctrl+C 实测返回 `exitCode: 0`、`signal: 2`。只看零退出码不能判成功。终端信号终止 bwrap supervisor 时，不保证保留内部 shell trap 的退出码。
4. 在退役整 CLI 后端前，接入完整文件工具语义、受保护的 worker 分发、所选 runtime 的策略传播及全部必需执行入口。并发文件更新、完整编码/二进制/模式兼容性、Linux x64、其他内核版本、Landlock 和生产自动后端选择，在本轮均未验证或未实现。
