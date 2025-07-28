# 语言选择器使用说明 / Language Selector Usage Guide

## 概述 / Overview

MINE AI CLI 现在支持多语言界面，通过 `/lang` 命令可以轻松切换界面语言。

MINE AI CLI now supports multi-language interface. You can easily switch interface language using the `/lang` command.

## 支持的语言 / Supported Languages

- **English** (en) - English
- **中文** (zh) - 中文  
- **简体中文** (zh-CN) - 简体中文
- **繁體中文** (zh-TW) - 繁體中文
- **日本語** (ja) - 日本語
- **한국어** (ko) - 한국어
- **Español** (es) - Español
- **Français** (fr) - Français
- **Deutsch** (de) - Deutsch
- **Русский** (ru) - Русский

## 使用方法 / Usage

### 查看当前语言和可用选项 / View Current Language and Available Options

```bash
/lang
```

这将显示：
- 当前设置的语言
- 所有可用的语言选项
- 使用示例

This will show:
- Currently set language
- All available language options  
- Usage examples

### 设置新语言 / Set New Language

```bash
/lang <language_code>
```

**示例 / Examples:**

```bash
# 切换到中文 / Switch to Chinese
/lang zh

# 切换到英文 / Switch to English  
/lang en

# 切换到简体中文 / Switch to Simplified Chinese
/lang zh-CN

# 切换到日文 / Switch to Japanese
/lang ja
```

## 环境变量配置 / Environment Variable Configuration

语言设置可以通过环境变量进行配置。在项目根目录的 `.env` 文件中设置：

Language settings can be configured via environment variables. Set in the `.env` file in the project root:

```bash
# 设置默认语言 / Set default language
MINE_AI_LANGUAGE=en
```

## 配置优先级 / Configuration Priority

语言设置的优先级顺序：
1. 用户通过 `/lang` 命令设置的语言（保存在 settings.json）
2. 环境变量 `MINE_AI_LANGUAGE`
3. 默认语言（英文）

Language setting priority order:
1. Language set by user via `/lang` command (saved in settings.json)
2. Environment variable `MINE_AI_LANGUAGE`  
3. Default language (English)

## 自动补全 / Auto-completion

`/lang` 命令支持自动补全功能。输入 `/lang ` 后按 Tab 键可以看到所有可用的语言代码。

The `/lang` command supports auto-completion. Type `/lang ` and press Tab to see all available language codes.

## 重启说明 / Restart Notice

更改语言设置后，需要重启 MINE AI CLI 以应用新的语言设置。

After changing language settings, you need to restart MINE AI CLI to apply the new language settings.

## 故障排除 / Troubleshooting

### 语言设置未生效 / Language Setting Not Taking Effect

1. 确保已重启 CLI / Make sure CLI is restarted
2. 检查 `.env` 文件配置 / Check `.env` file configuration  
3. 确认设置文件权限 / Confirm settings file permissions

### 不支持的语言代码 / Unsupported Language Code

如果输入了不支持的语言代码，系统会显示错误信息并列出所有支持的语言。

If an unsupported language code is entered, the system will show an error message and list all supported languages.

## 技术实现 / Technical Implementation

- 语言配置存储在用户设置文件中 / Language configuration stored in user settings file
- 支持环境变量覆盖 / Supports environment variable override
- 提供命令行自动补全 / Provides command-line auto-completion
- 双语错误信息和帮助文本 / Bilingual error messages and help text 