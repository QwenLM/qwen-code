# Fork 发版与版本管理架构设计

> 规范 alishu/qwen-code fork 的版本号策略、分支模型、发布流程、upstream sync 后的版本衔接，以及两个分发渠道（npm / standalone binary）的协同。

## 1. 现状分析

### 1.1 仓库关系

```
QwenLM/qwen-code (upstream, GitHub)
  └── @qwen-code/qwen-code             ← 公共 npm 包
        │
        ▼ fork
alishu/qwen-code (internal, GitLab)
  └── @alife/dataworks-qwen-code       ← 内部 npm 包 (anpm)
  └── standalone binary                ← OSS 分发
```

### 1.2 当前版本状态

| 维度               | 现状                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| 内部 fork 基础版本 | `0.14.8`                                                                      |
| 上游最新版本       | `v0.15.0-preview.2`                                                           |
| 内部发布版本格式   | `0.14.8-dataworks.N` (latest) / `0.14.8-beta.N` (beta)                        |
| 版本管理工具       | `scripts/version.js` (手动 bump) + `scripts/publish-packages.js` (自动递增 N) |

### 1.3 当前问题

| 问题                                                     | 影响                                      |
| -------------------------------------------------------- | ----------------------------------------- |
| 版本号与上游的对应关系不明确                             | 用户无法判断当前版本包含了上游哪些功能    |
| npm 发布无 git tag                                       | 无法从 git 历史追溯某个发布版本的代码快照 |
| standalone binary 构建只在 `feat/bindary-build` 分支触发 | 与 main 分支发布脱节，需要手动同步        |
| 版本 bump 是手动操作                                     | 容易遗漏，多个 package.json 需要同步更新  |
| 无 CHANGELOG                                             | 用户无法了解版本间的变更内容              |

## 2. 版本号策略

### 2.1 版本号格式

```
{upstream_base}-dataworks.{N}
```

| 组成部分        | 说明                                             | 示例               |
| --------------- | ------------------------------------------------ | ------------------ |
| `upstream_base` | 与上游对齐的基础版本号 (x.y.z)                   | `0.14.8`           |
| `dataworks`     | 固定标识符，标记为 DataWorks fork 版本           | —                  |
| `N`             | 基于该 base 的内部递增序号，自动从 registry 计算 | `0`, `1`, `2`, ... |

#### 完整示例

```
0.14.8-dataworks.0   ← 基于上游 0.14.8 的第一个 fork 发布
0.14.8-dataworks.1   ← bug fix 或小改动
0.14.8-dataworks.2   ← 又一次发布
0.15.0-dataworks.0   ← upstream sync 到 0.15.0 后的第一个 fork 发布
```

### 2.2 dist-tag 策略

| dist-tag | 含义         | 触发条件                              | 用户安装方式                                  |
| -------- | ------------ | ------------------------------------- | --------------------------------------------- |
| `latest` | 正式版       | main 分支发布，或 `release_mode=true` | `npm install @alife/dataworks-qwen-code`      |
| `beta`   | 预发布测试版 | 非 main 分支默认                      | `npm install @alife/dataworks-qwen-code@beta` |

### 2.3 与上游版本的对应规则

```
upstream sync 合入 → bump upstream_base → 重置 N 从 0 开始

示例时间线：
  fork 0.14.8-dataworks.3  (正在开发)
       ↓ upstream sync v0.15.0 合入 main
  fork 0.15.0-dataworks.0  (sync 后首次发布)
  fork 0.15.0-dataworks.1  (后续 fork 改动)
```

**base 版本更新时机**：

| 场景                                          | 操作                      |
| --------------------------------------------- | ------------------------- |
| upstream sync 合入了上游的新 tag (如 v0.15.0) | 将 base 更新为 `0.15.0`   |
| upstream sync 合入但没有新 tag                | base 保持不变，继续递增 N |
| fork 独立 bug fix / feature                   | base 不变，继续递增 N     |

## 3. 分支模型

### 3.1 分支定义

```
main                          ← 稳定集成分支，所有 MR 合入目标
  │
  ├── sync/upstream-YYYYMMDD  ← upstream sync 临时分支（CI 自动创建，MR 合入 main 后删除）
  │
  ├── release/*               ← 发布准备分支（push/MR 自动触发 beta 构建）
  │
  ├── feat/*                  ← 功能开发分支
  │
  ├── fix/*                   ← bug 修复分支
  │
  └── feat/bindary-build      ← standalone binary 构建触发分支（现状，待优化）
```

### 3.2 分支与发布的关系

```
feat/* ──── MR ────→ main ──── CI 手动触发 ────→ npm publish (latest)
  │                                                  │
  │                                                  ▼
  │                                           0.14.8-dataworks.N
  │
  └── MR ────→ release/* ──── 自动触发 ────→ npm publish (beta)
                                                │
                                                ▼
                                          0.14.8-beta.N
```

## 4. 发布流程

### 4.1 npm 发布流程

```
┌─────────────────────────────────────────────────────────┐
│                    npm-publish.yml                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. npm ci                                              │
│  2. npm run build           (tsc 编译)                   │
│  3. npm run bundle          (esbuild 打包)               │
│  4. publish-packages.js:                                │
│     a. 写入 .npmrc 认证                                  │
│     b. 查询 registry 计算下一个 N                         │
│     c. 更新所有 package.json → x.y.z-dataworks.N         │
│     d. 重新 bundle (嵌入新版本号)                          │
│     e. npm publish --workspaces --tag latest             │
│  5. 验证 dist-tags                                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### 参数说明

| 参数           | 类型    | 默认值      | 说明                     |
| -------------- | ------- | ----------- | ------------------------ |
| `tag`          | string  | `latest`    | npm dist-tag             |
| `pre_id`       | string  | `dataworks` | 版本号后缀标识符         |
| `dry_run`      | boolean | `true`      | 模拟发布                 |
| `auto_version` | string  | `true`      | 自动递增版本号           |
| `release_mode` | boolean | `false`     | 非 main 分支强制发正式版 |

### 4.2 standalone binary 发布流程

```
┌─────────────────────────────────────────────────────────┐
│                 build-standalone.yml                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. resolve-version.sh → 计算版本号                       │
│  2. npm run build + bundle                              │
│  3. build-standalone-ci.sh:                             │
│     a. 注入版本号到 dist/cli.js                           │
│     b. 下载 Node.js v22.14.0 binary                     │
│     c. 下载 native modules (node-pty, clipboard)         │
│     d. 打包 tarball + SHA256SUMS + metadata.json         │
│  4. upload-oss.sh → 上传到 OSS                           │
│  5. upload-policy.sh → 按分支决定是否更新 latest 指针       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### OSS 目录结构

```
dataworks-notebook-cn-shanghai.oss-cn-shanghai.aliyuncs.com/public-datasets/aone-release/alishu/qwen-code/
  {version}/
    qwen-code-{version}-linux-{arch}.tar.gz
    SHA256SUMS
    metadata.json
  latest/
    metadata.json              ← 仅 main/release 分支更新
  deploy-qwen.sh               ← 用户安装入口
  upgrade-qwen.sh              ← 用户升级入口
```

#### 用户安装/升级

```bash
# 首次安装
curl -fsSL https://dataworks-notebook-cn-shanghai.oss-cn-shanghai.aliyuncs.com/public-datasets/aone-release/alishu/qwen-code/deploy-qwen.sh | bash

# 升级
curl -fsSL .../upgrade-qwen.sh | bash

# 指定版本
curl -fsSL .../deploy-qwen.sh | bash -s -- --version 0.14.8-dataworks.3
```

### 4.3 两个渠道的版本对齐

当前问题：npm 和 standalone binary 的版本号独立计算，可能不一致。

**建议规范**：

| 规则                                  | 说明                                        |
| ------------------------------------- | ------------------------------------------- |
| npm 版本是权威来源                    | standalone binary 应使用与 npm 相同的版本号 |
| binary 构建应在 npm 发布成功后触发    | 保证版本号一致                              |
| `metadata.json` 中记录对应的 npm 版本 | 便于追溯                                    |

## 5. upstream sync 后的版本衔接

### 5.1 完整流程

```
Day 0: fork 当前版本 0.14.8-dataworks.5

Day 1: upstream sync MR 创建
  ├── CI 自动创建 sync/upstream-20260423 分支
  ├── 自动或人工解决冲突
  ├── 运行 .fork/verify.sh 检查 fork 定制（见 fork-patch-guard-design.md）
  └── MR review + merge 到 main

Day 2: 版本 bump（如果上游有新 tag）
  ├── 检查上游 tag: git tag -l 'v*' --sort=-v:refname | head -5
  ├── 如果上游发了 v0.15.0:
  │     npm run release:version 0.15.0
  │     git commit -m "chore(release): bump base version to 0.15.0"
  ├── 如果上游没有新 tag:
  │     base 版本不变，跳过此步骤
  └── push to main

Day 3: 发布
  ├── 触发 npm-publish.yml (auto_version=true)
  │     → 发布 0.15.0-dataworks.0 (如果 bump 了)
  │     → 或 0.14.8-dataworks.6 (如果没 bump)
  └── 触发 build-standalone.yml (使用相同版本号)
```

### 5.2 版本 bump 检查清单

upstream sync 合入 main 后，执行以下检查：

```markdown
- [ ] 检查上游是否有新的 release tag
- [ ] 如有新 tag，运行 `npm run release:version <new_version>`
- [ ] 检查 `config.sandboxImageUri` 是否更新
- [ ] 运行 `bash .fork/verify.sh` 验证 fork 定制完整性
- [ ] 提交版本 bump commit
- [ ] 触发 npm-publish.yml 发布
```

## 6. 分发方式分析：standalone binary vs bundle-only

### 6.1 当前 standalone binary 的真实结构

当前的 "standalone binary" **并非编译产物**，而是一个 shell 脚本打包：

```
qwen-code-standalone/
├── bin/qwen                    ← bash 启动脚本（非二进制）
├── node/bin/node               ← 内嵌 Node.js v22.14.0（~50 MB）
├── dist/cli.js                 ← esbuild 打包的全部应用代码（~25 MB）
├── dist/vendor/ripgrep/        ← rg 二进制（~24 MB）
├── dist/locales/               ← i18n（~844 KB）
├── dist/bundled/               ← 内置 skill 文档（~792 KB）
├── native_modules/
│   ├── @lydell/node-pty-linux-*/   ← PTY 原生模块（~88 KB）
│   └── @teddyzhu/clipboard-linux-*/  ← 剪贴板原生模块（~1.4 MB）
└── metadata.json
```

`bin/qwen` 做的事情只有三行：设置 `NODE_PATH` → 用内嵌 node 执行 `dist/cli.js`。

### 6.2 原生模块是否必须

| 模块        | 用途                  | 缺失时的表现                                         | 结论     |
| ----------- | --------------------- | ---------------------------------------------------- | -------- |
| `node-pty`  | 交互式 PTY shell 执行 | 自动 fallback 到 `child_process.spawn`，交互能力降级 | **可选** |
| `clipboard` | 剪贴板图片粘贴        | 静默禁用该功能                                       | **可选** |

两个模块都在 `optionalDependencies` 中，代码中有 try/catch + graceful fallback。

### 6.3 最小可行部署（bundle-only）

只需要 `dist/cli.js` + 系统 Node.js + ripgrep 即可运行核心功能：

```bash
# 前置条件：系统已安装 Node.js >= 20
node /opt/qwen-code/dist/cli.js
```

| 组件                                | 大小           | 是否必须             |
| ----------------------------------- | -------------- | -------------------- |
| `dist/cli.js`                       | ~25 MB         | 是                   |
| `dist/vendor/ripgrep/{platform}/rg` | ~5 MB (单平台) | 是（或用系统 rg）    |
| `dist/locales/`                     | ~844 KB        | 否（仅中文时可跳过） |
| `dist/bundled/`                     | ~792 KB        | 否（内置技能文档）   |

**最小部署 ~30 MB，对比 standalone 的 ~120-200 MB。**

### 6.4 简化分发方案（建议）

可以用 **bundle tarball + OSS** 替代当前的 standalone binary：

```
OSS 目录结构（简化后）：
qwen-code/
  {version}/
    qwen-code-{version}-linux-{arch}.tar.gz    ← dist/ 打包
    SHA256SUMS
    metadata.json
  latest/
    metadata.json
  install.sh       ← 下载 + 解压 + 创建 symlink
  upgrade.sh       ← 检查版本 + 下载新版
```

安装/更新脚本的核心逻辑简化为：

```bash
# install.sh 核心逻辑
VERSION=$(curl -s .../latest/metadata.json | jq -r .version)
curl -fSL ".../qwen-code-${VERSION}-linux-amd64.tar.gz" | tar xz -C /opt/qwen-code/releases/${VERSION}
ln -sfn /opt/qwen-code/releases/${VERSION} /opt/qwen-code/current
ln -sfn /opt/qwen-code/current/bin/qwen /usr/local/bin/qwen
```

其中 `bin/qwen` 简化为：

```bash
#!/bin/bash
exec node "$(dirname "$0")/../dist/cli.js" "$@"
```

**前提条件**：目标机器已安装 Node.js >= 20。如果不能保证，仍需内嵌 Node.js。

### 6.5 对比总结

| 维度         | 当前 standalone                       | bundle-only（建议）        |
| ------------ | ------------------------------------- | -------------------------- |
| 部署大小     | ~120-200 MB                           | ~30 MB                     |
| Node.js 依赖 | 无（内嵌）                            | 系统需要 >= 20             |
| PTY 交互     | 完整                                  | 降级（child_process）      |
| 剪贴板粘贴   | 支持                                  | 不支持                     |
| 构建复杂度   | 高（下载 node/native modules/多架构） | 低（esbuild 产物直接打包） |
| 更新方式     | 重新下载完整包                        | 只需替换 dist/             |

**建议**：对于内部开发环境（已有 Node.js），优先使用 bundle-only 分发。standalone binary 保留给无 Node.js 的裸机环境。

## 7. 已识别的 gap 及改进建议

### 7.1 短期 (P0)

| Gap                                             | 建议                                                          | 状态 |
| ----------------------------------------------- | ------------------------------------------------------------- | ---- |
| npm 发布后无 git tag                            | `publish-packages.js` 成功后自动创建 `v{version}` tag 并 push | TODO |
| standalone build 只在 `feat/bindary-build` 触发 | 增加 main 分支触发，或在 npm 发布成功后自动触发 binary 构建   | TODO |
| 无 CHANGELOG                                    | 基于 conventional commits 自动生成，或至少在发布时手动维护    | TODO |

### 7.2 中期 (P1)

| Gap                                    | 建议                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| 版本 bump 手动操作                     | upstream sync MR 合入后自动检测上游 tag，生成版本 bump commit |
| npm 和 binary 版本可能不一致           | 统一发布流水线，一个 CI job 串联两个渠道                      |
| Node.js 版本不一致 (npm=20, binary=22) | 统一到 Node.js 22                                             |

### 7.3 长期 (P2)

| Gap                        | 建议                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| 无回滚机制 (npm)           | 支持 `npm dist-tag add @alife/dataworks-qwen-code@{old_version} latest` 快速回滚 |
| 无灰度发布                 | 先发 `canary` tag 给小范围用户，验证后再切 `latest`                              |
| 版本号人工判断是否跟随上游 | 自动从 `.last-synced-upstream-tag` 推导 base 版本                                |

## 8. 关键文件索引

| 文件                                     | 用途                                     |
| ---------------------------------------- | ---------------------------------------- |
| `.aoneci/npm-publish.yml`                | npm 发布 CI pipeline                     |
| `.aoneci/build-standalone.yml`           | standalone binary 构建 CI                |
| `.aoneci/upload-qwen-scripts.yml`        | 部署脚本同步到 OSS                       |
| `scripts/publish-packages.js`            | npm 发布核心逻辑 (auto-version, publish) |
| `scripts/version.js`                     | 版本号 bump 工具                         |
| `scripts/prepare-cli-for-publish.js`     | CLI 包 prepublishOnly 钩子               |
| `.aoneci/scripts/build-standalone-ci.sh` | binary 打包                              |
| `.aoneci/scripts/resolve-version.sh`     | binary 版本号计算                        |
| `.aoneci/scripts/upload-oss.sh`          | OSS 上传                                 |
| `.aoneci/scripts/upload-policy.sh`       | 分支级上传策略                           |
| `.aoneci/scripts/deploy-qwen.sh`         | 用户安装脚本                             |
| `.aoneci/scripts/upgrade-qwen.sh`        | 用户升级脚本                             |
| `.fork/patches.md`                       | fork 定制追踪清单 (待建)                 |
| `.fork/verify.sh`                        | fork 定制验证脚本 (待建)                 |
