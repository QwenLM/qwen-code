# 杭州 ARM64 Runner 验收

[English](hangzhou-arm64-runner-smoke.md) | [简体中文](hangzhou-arm64-runner-smoke.zh-CN.md)

## 目标

在 5 台新杭州 ECS 承接生产 CI 前，分别验证代码检出和宿主机工具链。Runner 在线状态只证明监听进程能连接 GitHub。

## 设计

矩阵通过每台主机的专用验收标签调度。每个任务验证 ARM64 架构和服务账号，以只读权限检出触发提交，并检查 Git、Node 22、npm、pnpm 和共享的 Qwen Code 安装。各任务独立报告结果，一台主机失败时其余检查继续运行。

工作流支持手动触发。在专用验收分支推送对工作流的变更时启动首次验收。生产 Runner 标签和工作流调度沿用现有配置。

## 验收

GitHub 在 5 台主机上各调度一个任务。每个任务报告实际选中的 Runner、检出和工具链结果。每台主机已注册的两个监听进程均可接收该主机的任务。
