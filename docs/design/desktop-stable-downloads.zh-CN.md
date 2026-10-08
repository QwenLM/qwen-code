# 当前 Desktop 下载

[English](./desktop-stable-downloads.md)

## 问题

README 将新用户引向 `desktop-latest`。该发布用于提供更新清单，并保留一次性的 Electron 到 Tauri 迁移安装包；其附件不是当前的全新安装选项。带版本号的 Desktop 发布和更新源本身是最新的。

## 决策

创建独立的 `desktop-stable` 发布，仅包含 macOS、Windows 和 Linux 的当前稳定版安装包。README 中的两个下载链接都指向它。在现有 Desktop 发布任务中，稳定更新源推进后更新此发布，沿用相同的草稿、预发布、演练和防降级条件。不改变 GitHub 仓库级别的 Latest 选择。

从已经发布的带版本号发布所对应的本地构建产物中复制安装包。写入前，将其 SHA-256 摘要和大小与 GitHub 带版本号附件的元数据进行比较；确认替代安装包上传正确后，再删除旧安装包名称。重复发布可以修复未完成的上传，并跳过已匹配的文件。首次创建的别名发布保持草稿状态，直到安装包通过验证。GitHub 附件替换不是原子操作，因此更新失败后，页面可能暂时混有不同版本的安装包，需要重新运行修复。

只更新 `desktop-latest` 的正文，说明其更新源和旧版迁移用途，并链接到当前下载页面。现有的附件发布逻辑保持不变。在现有 OSS 稳定更新源验证中，将对外提供的别名附件与本地安装包和 GitHub 摘要比较，通过后才提升 OSS latest 清单。不新增工作流或凭据。

## 上线

公开 README 新链接前，使用当前稳定版的带版本号发布初始化别名。现有的已发布快捷路径会有意跳过重建，因此仅重新调度同一版本不会初始化别名。拥有发布写权限的维护者可以运行本次改动中的辅助脚本：

```sh
version=0.25.0 # 上线时使用 desktop-latest.json 中的版本。
gh release download "desktop-v$version" --repo QwenLM/qwen-code --dir release-assets
node .github/scripts/update-desktop-downloads.mjs --assets release-assets --version "$version" --repository QwenLM/qwen-code
node .github/scripts/update-desktop-downloads.mjs --assets release-assets --version "$version" --repository QwenLM/qwen-code --verify
```

初始化期间不要并发发布 Desktop。脚本会拒绝与稳定更新源不匹配的版本。后续稳定版发布会自动维护别名。若发布失败，可使用现有 `clobber` 选项重跑；若仅需修复别名，则可针对已发布产物重新运行辅助脚本。

## 验收和范围

- README 的两个下载链接都指向当前安装包，包括使用通用名称的 macOS DMG 的正确字节内容。
- 草稿、预发布、演练和较旧版本的发布不会替换稳定版下载。
- 旧版 Electron 迁移附件保持完整，仅修改其发布说明。
- 别名中缺失、过时或多余的附件会阻止 OSS latest 提升。
- `qwen.ai` 网站由其他渠道维护，不在本次改动范围内。

## 验证状态

已通过公开 GitHub 界面和发布更新源复现原问题。本地测试拦截 GitHub 写入，验证发布和校验逻辑。实际发布后的下载验证需要维护者先初始化上游别名；开发期间不修改任何上游发布。
