# 使用 SignPath 为 Windows CUA 签名

[English](windows-cua-signpath.md) | [简体中文](windows-cua-signpath.zh-CN.md)

## 问题与范围

Windows SDK 的可选 UIAccess 模式在将 worker 部署到 Program Files 前要求有效的
Authenticode 签名；默认 Windows 安装不部署该 worker。PR #12442 在打包前增加签名；本次修订将其中的 PFX
导入路径替换为项目的 SignPath 服务。不降低安装校验要求，不发布版本，也不要求
用户安装测试根证书。本次接入仅签署 UIAccess worker。

## 签名流程

托管 Windows job 为各架构构建未签名 worker，以包含架构的唯一文件名上传原始
PE artifact。固定提交版本的 SignPath action 将该 artifact ID 提交到组织
`e2bc00ea-6f24-4cde-9cfc-f0b19b2b6ece`、项目 `qwen-code`、产物配置
`initial`，随后下载已完成签名请求的输出。Windows job 只有 `actions: read`
和 `contents: read` 权限。`SIGNPATH_API_TOKEN` 保存在 Actions secret 中；
runner 不导入私有签名密钥。action 的认证下载绑定到为所上传 artifact、仓库和
workflow run 创建的签名请求。

只有分支上的 `workflow_dispatch` 且 `dry_run=true` 才选择 `test-signing`。
tag ref 和所有发布运行均选择 `release-signing`；即使手动对 tag dispatch 时
保留默认 `dry_run` 值，也使用生产策略。生产策略审批和公开受信任证书是服务端
前置条件。

测试路径先校验已知测试证书指纹
`0B27B4BA9D646BCDB1FD59B4F229C0DAA7E8EEF0`，再将其导入一次性托管
runner 的 Root 和 TrustedPublisher 证书存储。此信任仅用于 CI，自托管 runner
不在本设计范围内。生产路径不导入根证书。两条路径均要求 Authenticode 状态为
`Valid` 才能打包；输出缺失或签名无效会让 job 失败。

全新安装检查设置 `CUA_DRIVER_USE_UIACCESS=1`，使用打包后的产物，启用生命周期
脚本安装 SDK，并检查部署到 Program Files 的 worker 签名。它覆盖打包与安装；原生产物覆盖变量使其不经过
公开下载与校验和路径。

## 验证与验收

工作流测试检查策略选择、artifact 输入、权限，以及从未签名构建到签名、打包、
安装的顺序。PowerShell 解析和 actionlint 检查语法。保留的手工测试签名 x64
worker 为测试证书和 PE 内容提供独立证据，但不能证明工作流的认证 API 提交。

合并前配置 `SIGNPATH_API_TOKEN`，在精确候选提交上对两个构建目标执行分支
dry run。两个 Windows job 和 SDK 安装都必须通过，发布 job 必须跳过。
ARM64 在 x64 runner 上交叉构建，因此不构成 ARM64 实机运行证据。

公开发布验收前，需配置生产证书、完成生产策略审批，并在没有导入测试根证书的
干净 Windows 机器上安装 publisher 签名的候选包，实际执行一次 UIAccess 输入。
测试签名结果不能满足这项验收条件。

## 当前状态与未完成前置条件

截至 2026-10-22，`SIGNPATH_API_TOKEN` 已于 UTC 14:09:38 重新生成并配置。
原始 PE 配置与 test-signing 策略有效，SignPath 显示已关联 GitHub trusted builds；
但这不代表 GitHub App 已安装并获授权。
[run 39793940639](https://github.com/QwenLM/qwen-code/actions/runs/39793940639)
在 `67e69b53bc9d55e489c3d780240b2792482274ed` 上完成两个 Windows 目标构建后，
提交签名时以 `Failed to retrieve GitHub App token` 失败，未运行签名后打包与安装。
需修复 GitHub App 安装或访问授权。生产证书状态为 `CSR PENDING`，
`release-signing` 为 `INVALID`。在线签名和 Windows 验收完成前，PR 保持 Draft。
本次工作不授权 release 或 npm 发布。
