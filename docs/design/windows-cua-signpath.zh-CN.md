# 使用 SignPath 为 Windows CUA 签名

[English](windows-cua-signpath.md) | [简体中文](windows-cua-signpath.zh-CN.md)

## 问题与范围

Windows SDK 的可选 UIAccess 模式在将 worker 部署到 Program Files 前要求有效的
Authenticode 签名；默认 Windows 安装不部署该 worker。PR #12442 将早期的 PFX
导入方案替换为项目的 SignPath 测试签名服务，使 CI 能端到端验证已签名的
UIAccess 安装。不降低安装校验要求，不发布版本，也不要求用户安装测试根证书。

## 签名流程

发布构建保持现有约定：Windows 归档携带未签名的 UIAccess worker，需要 UIAccess
的部署方在目标机器上签名并信任它。发布从不依赖 SignPath，因此缺少生产证书不会
阻塞普通模式的 Windows 发布。

只有分支上的 `workflow_dispatch` 且 `dry_run=true` 才对 worker 做测试签名；
tag ref 和发布运行跳过该步骤。Windows job 只有 `contents: read` 权限。仓库内
脚本使用 Actions secret `SIGNPATH_API_TOKEN`，将各架构的 worker 直接提交到
SignPath REST API（`SubmitWithArtifact`），目标为组织
`e2bc00ea-6f24-4cde-9cfc-f0b19b2b6ece`、项目 `qwen-code`、策略
`test-signing`、产物配置 `initial`，随后轮询签名请求并下载签名文件。runner
不导入私有签名密钥。

直接调用 API 不经过 SignPath 的 GitHub 连接器；该连接器需要 SignPath GitHub
App 做来源验证。本仓库无法安装该 App，而 `test-signing` 策略不要求来源验证。

脚本先校验已知测试证书指纹 `0B27B4BA9D646BCDB1FD59B4F229C0DAA7E8EEF0`，
再将其导入一次性托管 runner 的 Root 和 TrustedPublisher 证书存储，并要求
Authenticode 状态为 `Valid` 后才替换构建出的 worker。此信任仅用于 CI，自托管
runner 不在本设计范围内。缺少输出、签名者不符或签名无效都会使 job 失败。

干净安装检查使用打包后的 payload，并在启用 lifecycle scripts 的情况下安装 SDK。
dry run 设置 `CUA_DRIVER_USE_UIACCESS=1` 并检查 Program Files 中已部署 worker
的签名；发布构建以普通模式安装，并检查没有部署 UIAccess worker。本地 native
payload 覆盖不验证公开下载与校验和路径。

## 验证与验收

workflow 测试检查 dry run 路由、测试签名步骤、权限，以及从构建到打包、安装的
步骤顺序。PowerShell 解析和 actionlint 检查语法。

合并前，需要在分支 dry run 中对两个构建目标运行确切候选版本；两个 Windows job
和 SDK 安装都必须通过，发布 job 必须保持跳过。ARM64 在 x64 runner 上交叉编译，
不构成原生 ARM64 执行证据。

测试签名结果不证明公开信任。发布公开受信任的 UIAccess worker，需要由公开受信任
CA 签发给经过验证的法律实体的证书，例如公司签名服务、Azure Artifact Signing
或 CA 签发的代码签名证书。SignPath 生产策略要求通过 GitHub App 做来源验证，
本仓库无法安装该 App。这一决定不在本 PR 范围内。

## 当前状态与待满足条件

截至 2026-10-22，`SIGNPATH_API_TOKEN` 已配置，原始 PE 配置和测试签名策略有效。
[运行 39793940639](https://github.com/QwenLM/qwen-code/actions/runs/39793940639)
构建了两个 Windows 目标，但 GitHub 连接器报错
`Failed to retrieve GitHub App token`，因此改为直接调用 API 的设计。PR 保持
Draft，等待直接 API 的 dry run 与 Windows 验收。本工作不授权任何发布或 npm 发布。
