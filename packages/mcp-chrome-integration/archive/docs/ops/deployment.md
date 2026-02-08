# MCP Chrome Integration - 部署和发布文档

本文档提供 MCP Chrome Integration 的完整部署和发布流程，适用于生产环境部署和 Chrome Web Store 发布。

**版本**: 1.0
**适用对象**: 项目维护者、DevOps 工程师
**最后更新**: 2026-01-25

---

## 📋 目录

1. [发布前准备](#1-发布前准备)
2. [构建生产版本](#2-构建生产版本)
3. [Chrome Web Store 发布](#3-chrome-web-store-发布)
4. [Native Messaging Host 分发](#4-native-messaging-host-分发)
5. [版本管理](#5-版本管理)
6. [发布清单](#6-发布清单)
7. [回滚方案](#7-回滚方案)
8. [持续集成/部署](#8-持续集成部署)

---

## 1. 发布前准备

### 1.1 检查清单

在发布前，确保完成以下检查：

#### 代码质量

- [ ] 所有单元测试通过
- [ ] 集成测试通过
- [ ] 代码审查完成
- [ ] 没有已知的关键 bug
- [ ] 性能测试通过

#### 文档

- [ ] CHANGELOG.md 已更新
- [ ] README.md 反映最新功能
- [ ] API 文档更新
- [ ] 用户指南更新

#### 版本号

- [ ] package.json 版本号已更新
- [ ] manifest.json 版本号已更新
- [ ] 遵循语义化版本规范（SemVer）

#### 安全

- [ ] 依赖项安全扫描通过（`npm audit`）
- [ ] 敏感信息已移除（API keys, tokens）
- [ ] 内容安全策略（CSP）配置正确

### 1.2 环境准备

```bash
# 1. 确保使用最新代码
git checkout main
git pull origin main

# 2. 安装依赖
pnpm install

# 3. 运行测试
pnpm test

# 4. 运行构建
pnpm build
```

---

## 2. 构建生产版本

### 2.1 构建所有组件

```bash
# 使用构建脚本
./scripts/build-all.sh
```

或手动构建：

```bash
# 1. 构建 shared 包
cd packages/shared
pnpm build
cd ../..

# 2. 构建 native-server
cd app/native-server
pnpm build
cd ../..

# 3. 构建 chrome-extension（生产模式）
cd app/chrome-extension
NODE_ENV=production pnpm build
cd ../..
```

### 2.2 优化和压缩

#### Chrome Extension 优化

```bash
cd app/chrome-extension

# 移除 source maps（生产环境）
rm -rf dist/extension/**/*.map

# 压缩 JavaScript（如果未自动压缩）
# esbuild 默认在生产模式下压缩
```

#### Native Server 优化

```bash
cd app/native-server

# 仅安装生产依赖
pnpm install --prod

# 移除开发文件
rm -rf src/ tests/ *.test.js
```

### 2.3 验证构建产物

```bash
# 检查文件大小
du -sh app/chrome-extension/dist/extension/
du -sh app/native-server/dist/

# 验证关键文件存在
ls -la app/chrome-extension/dist/extension/manifest.json
ls -la app/native-server/dist/index.js
```

---

## 3. Chrome Web Store 发布

### 3.1 准备扩展包

#### 固定 Extension ID（重要）

为了在更新时保持相同的 Extension ID，需要生成私钥：

```bash
cd app/chrome-extension/dist/extension

# 方法 1: 使用 Chrome 打包工具
# 1. 打开 chrome://extensions/
# 2. 启用开发者模式
# 3. 点击"打包扩展程序"
# 4. 选择 dist/extension 目录
# 5. 保存生成的 .pem 私钥文件

# 方法 2: 从现有 .pem 提取 public key
# 将提取的 key 添加到 manifest.json
```

在 `manifest.json` 中添加（生产版本）：

```json
{
  "key": "YOUR_PUBLIC_KEY_HERE",
  ...
}
```

⚠️ **注意**: 不要将 `.pem` 私钥提交到代码仓库！

#### 创建 ZIP 包

```bash
cd app/chrome-extension/dist

# 创建发布包
zip -r mcp-chrome-integration-v1.0.0.zip extension/

# 验证 ZIP 内容
unzip -l mcp-chrome-integration-v1.0.0.zip
```

### 3.2 Chrome Web Store 提交

1. **登录开发者控制台**
   - 访问 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   - 使用 Google 账号登录

2. **创建新应用**（首次发布）
   - 点击"新增项目"
   - 上传 ZIP 包
   - 填写应用信息

3. **填写应用详情**

   **基本信息**:
   - 应用名称：MCP Chrome Integration
   - 简短描述：(140 字符以内)
   - 详细描述：包含功能列表、使用说明
   - 分类：开发工具 / 生产力

   **图标和截图**:
   - 图标：128x128 PNG
   - 小图标：48x48 PNG
   - 截图：1280x800 或 640x400（至少 1 张，最多 5 张）
   - 宣传图片：440x280（可选）

   **隐私相关**:
   - 隐私政策 URL（如果收集数据）
   - 单一用途说明
   - 权限说明

4. **定价和分发**
   - 选择国家/地区
   - 设置价格（免费/付费）

5. **提交审核**
   - 点击"提交审核"
   - 审核时间：通常 1-3 个工作日

### 3.3 更新现有扩展

```bash
# 1. 更新版本号
# 编辑 app/chrome-extension/public/manifest.json
{
  "version": "1.1.0"  # 遵循 SemVer
}

# 2. 重新构建
cd app/chrome-extension
pnpm build

# 3. 创建新的 ZIP 包
cd dist
zip -r mcp-chrome-integration-v1.1.0.zip extension/

# 4. 在 Developer Dashboard 中上传新版本
```

### 3.4 审核常见问题

**常见拒绝原因**:

- 权限使用未充分说明
- manifest.json 配置错误
- 包含混淆代码（未提供源码）
- 违反内容政策

**加快审核**:

- 提供清晰的权限说明
- 在描述中解释 Native Messaging 用途
- 提供测试账号（如需要）

---

## 4. Native Messaging Host 分发

### 4.1 打包 Native Server

#### 创建安装包

```bash
cd app/native-server

# 方法 1: npm 包（推荐）
npm pack

# 生成 mcp-chrome-integration-native-1.0.0.tgz

# 方法 2: 独立可执行文件（使用 pkg）
npm install -g pkg
pkg dist/index.js --targets node18-macos-x64,node18-linux-x64,node18-win-x64 --output bin/mcp-server
```

#### 创建安装脚本

**macOS/Linux** (`install.sh`):

```bash
#!/bin/bash
set -e

echo "Installing MCP Chrome Integration Native Server..."

# 1. 安装 Node 包
npm install -g mcp-chrome-integration-native

# 2. 注册 Native Messaging Host
mcp-chrome-integration register

# 3. 验证安装
mcp-chrome-integration doctor

echo "✅ Installation complete!"
```

**Windows** (`install.bat`):

```batch
@echo off
echo Installing MCP Chrome Integration Native Server...

npm install -g mcp-chrome-integration-native
mcp-chrome-integration register
mcp-chrome-integration doctor

echo Installation complete!
```

### 4.2 npm 包发布（可选）

如果要发布到 npm registry：

```bash
cd app/native-server

# 1. 登录 npm
npm login

# 2. 发布
npm publish

# 发布 scoped 包（推荐）
npm publish --access public
```

在 `package.json` 中配置：

```json
{
  "name": "@mcp-chrome/native-server",
  "version": "1.0.0",
  "bin": {
    "mcp-chrome-integration": "./dist/cli.js"
  },
  "files": ["dist/**/*", "README.md", "LICENSE"]
}
```

### 4.3 用户安装流程

**推荐的用户安装方式**:

1. **通过 npm 全局安装**（最简单）:

   ```bash
   npm install -g @mcp-chrome/native-server
   mcp-chrome-integration register
   ```

2. **通过下载安装脚本**:

   ```bash
   curl -fsSL https://your-domain.com/install.sh | bash
   ```

3. **手动安装**:
   - 下载压缩包
   - 解压到指定目录
   - 运行 `./scripts/install.sh`

---

## 5. 版本管理

### 5.1 语义化版本（SemVer）

遵循 `MAJOR.MINOR.PATCH` 格式：

- **MAJOR**: 不兼容的 API 变更
- **MINOR**: 向下兼容的新功能
- **PATCH**: 向下兼容的 bug 修复

**示例**:

- `1.0.0` → 首次正式发布
- `1.0.1` → Bug 修复
- `1.1.0` → 新功能
- `2.0.0` → 破坏性变更

### 5.2 更新版本号

```bash
# 使用 npm version 命令自动更新所有 package.json
npm version patch  # 1.0.0 → 1.0.1
npm version minor  # 1.0.0 → 1.1.0
npm version major  # 1.0.0 → 2.0.0

# 手动更新（确保同步所有文件）
# - package.json (根目录)
# - app/chrome-extension/package.json
# - app/chrome-extension/public/manifest.json
# - app/native-server/package.json
```

### 5.3 Git 标签

```bash
# 创建标签
git tag -a v1.0.0 -m "Release version 1.0.0"

# 推送标签
git push origin v1.0.0

# 推送所有标签
git push origin --tags
```

### 5.4 CHANGELOG

在 `CHANGELOG.md` 中记录变更：

```markdown
# Changelog

## [1.1.0] - 2026-01-25

### Added

- 新增 AI 语义搜索功能
- 添加书签管理工具

### Changed

- 优化截图性能
- 更新依赖项

### Fixed

- 修复 Native Messaging 连接问题
- 修复表单填充 bug

### Security

- 更新依赖以修复安全漏洞

## [1.0.0] - 2026-01-20

### Added

- 初始发布
- 20+ 个浏览器工具
- Native Messaging 支持
```

---

## 6. 发布清单

### 6.1 发布前检查（Pre-release Checklist）

#### 代码

- [ ] 所有测试通过（单元测试、集成测试）
- [ ] 代码审查完成
- [ ] 没有 `console.log` 或调试代码
- [ ] 没有 TODO 或 FIXME 注释（或已记录到 issue）
- [ ] 依赖项安全扫描通过 (`npm audit`)

#### 文档

- [ ] CHANGELOG.md 已更新
- [ ] README.md 已更新
- [ ] 用户安装指南已更新（INSTALLATION.md）
- [ ] API 文档已更新

#### 版本

- [ ] 所有 package.json 版本号一致
- [ ] manifest.json 版本号已更新
- [ ] Git 标签已创建

#### 构建

- [ ] 生产构建成功
- [ ] 构建产物已验证
- [ ] Chrome Extension ZIP 包已创建
- [ ] Native Server 包已创建

#### 配置

- [ ] 生产环境配置正确
- [ ] API endpoints 指向生产环境
- [ ] 敏感信息已移除

### 6.2 发布步骤（Release Steps）

1. **准备发布分支**

   ```bash
   git checkout -b release/v1.0.0
   ```

2. **更新版本号**

   ```bash
   npm version 1.0.0
   ```

3. **更新 CHANGELOG**

   ```bash
   vim CHANGELOG.md
   ```

4. **构建生产版本**

   ```bash
   ./scripts/build-all.sh
   ```

5. **运行测试**

   ```bash
   pnpm test
   ```

6. **创建发布包**

   ```bash
   # Chrome Extension
   cd app/chrome-extension/dist
   zip -r mcp-chrome-integration-v1.0.0.zip extension/

   # Native Server
   cd app/native-server
   npm pack
   ```

7. **提交变更**

   ```bash
   git add .
   git commit -m "chore: prepare release v1.0.0"
   git push origin release/v1.0.0
   ```

8. **创建 Pull Request**
   - 从 `release/v1.0.0` 到 `main`
   - 审查变更
   - 合并到 main

9. **创建 Git 标签**

   ```bash
   git checkout main
   git pull
   git tag -a v1.0.0 -m "Release v1.0.0"
   git push origin v1.0.0
   ```

10. **发布到 Chrome Web Store**
    - 上传 ZIP 包
    - 填写发布说明
    - 提交审核

11. **发布 Native Server**（如果使用 npm）

    ```bash
    cd app/native-server
    npm publish
    ```

12. **创建 GitHub Release**
    - 访问 GitHub Releases 页面
    - 创建新 release
    - 上传构建产物
    - 填写 release notes

### 6.3 发布后检查（Post-release Checklist）

- [ ] Chrome Web Store 审核通过
- [ ] npm 包已发布（如适用）
- [ ] GitHub Release 已创建
- [ ] 文档网站已更新（如有）
- [ ] 通知用户（邮件列表、社交媒体）
- [ ] 监控错误报告和用户反馈
- [ ] 确认自动更新工作正常

---

## 7. 回滚方案

### 7.1 Chrome Extension 回滚

如果新版本有严重问题：

1. **禁用新版本**
   - 在 Developer Dashboard 中取消发布

2. **恢复旧版本**
   - 上传之前的版本 ZIP
   - 降低版本号（如 1.1.0 → 1.0.1）

3. **通知用户**
   - 在 Store 描述中说明问题
   - 提供临时解决方案

### 7.2 Native Server 回滚

```bash
# npm 包回滚
npm unpublish @mcp-chrome/native-server@1.1.0

# 或发布修复版本
npm version patch
npm publish
```

### 7.3 回滚决策树

```
发现严重 bug
    ↓
是否影响核心功能？
    ├─ 是 → 立即回滚
    ├─ 否 → 评估影响范围
           ↓
       影响 > 20% 用户？
           ├─ 是 → 紧急回滚
           └─ 否 → 发布热修复版本
```

---

## 8. 持续集成/部署

### 8.1 GitHub Actions 配置

创建 `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install pnpm
        run: npm install -g pnpm

      - name: Install dependencies
        run: pnpm install

      - name: Run tests
        run: pnpm test

      - name: Build
        run: ./scripts/build-all.sh

      - name: Create Chrome Extension ZIP
        run: |
          cd app/chrome-extension/dist
          zip -r ../../mcp-chrome-integration.zip extension/

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            app/mcp-chrome-integration.zip
            app/native-server/*.tgz
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 8.2 自动化测试

创建 `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [18, 20]

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js ${{ matrix.node }}
        uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node }}

      - name: Install dependencies
        run: pnpm install

      - name: Run tests
        run: pnpm test

      - name: Build
        run: pnpm build
```

### 8.3 自动发布到 Chrome Web Store

使用 `chrome-webstore-upload-cli`:

```yaml
- name: Publish to Chrome Web Store
  run: |
    npx chrome-webstore-upload-cli upload \
      --source mcp-chrome-integration.zip \
      --extension-id ${{ secrets.EXTENSION_ID }} \
      --client-id ${{ secrets.CLIENT_ID }} \
      --client-secret ${{ secrets.CLIENT_SECRET }} \
      --refresh-token ${{ secrets.REFRESH_TOKEN }}
```

---

## 📊 发布时间表示例

### 常规发布周期

| 周  | 活动               |
| --- | ------------------ |
| 1-2 | 开发新功能         |
| 3   | 功能冻结，bug 修复 |
| 4   | 测试和文档         |
| 5   | 发布准备           |
| 6   | 发布和监控         |

### 紧急热修复

| 时间 | 活动         |
| ---- | ------------ |
| H+0  | 发现严重 bug |
| H+1  | 修复开发     |
| H+2  | 测试验证     |
| H+3  | 构建和发布   |
| H+4  | 监控部署     |

---

## 🔗 相关资源

- [Chrome Web Store 开发者文档](https://developer.chrome.com/docs/webstore/)
- [npm 发布指南](https://docs.npmjs.com/cli/publish)
- [语义化版本规范](https://semver.org/lang/zh-CN/)
- [Conventional Commits](https://www.conventionalcommits.org/)

---

**文档版本**: 1.0
**最后更新**: 2026-01-25
**维护者**: Qwen Code Team
