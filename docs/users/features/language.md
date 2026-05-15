# Internationalization (i18n) & Language

Qwen Code is built for multilingual workflows: it supports UI localization (i18n/l10n) in the CLI, lets you choose the assistant output language, and allows custom UI language packs.

## Overview

From a user point of view, Qwen Code’s “internationalization” spans multiple layers:

| Capability / Setting     | What it controls                                                       | Where stored                 |
| ------------------------ | ---------------------------------------------------------------------- | ---------------------------- |
| `/language ui`           | Terminal UI text (menus, system messages, prompts)                     | `~/.qwen/settings.json`      |
| `/language output`       | Language the AI responds in (an output preference, not UI translation) | `~/.qwen/output-language.md` |
| Custom UI language packs | Overrides/extends built-in UI translations                             | `~/.qwen/locales/*.js`       |

## UI Language

This is the CLI’s UI localization layer (i18n/l10n): it controls the language of menus, prompts, and system messages.

### Setting the UI Language

Use the `/language ui` command:

```bash
/language ui zh-CN    # Chinese
/language ui en-US    # English
/language ui ru-RU    # Russian
/language ui de-DE    # German
/language ui ja-JP    # Japanese
/language ui pt-BR    # Portuguese (Brazil)
/language ui fr-FR    # French
/language ui ca-ES    # Catalan
```

Aliases are also supported:

```bash
/language ui zh       # Chinese
/language ui en       # English
/language ui ru       # Russian
/language ui de       # German
/language ui ja       # Japanese
/language ui pt       # Portuguese
/language ui fr       # French
/language ui ca       # Catalan
```

### Auto-detection

On first startup, Qwen Code detects your system locale and sets the UI language automatically.

Detection priority:

1. `QWEN_CODE_LANG` environment variable
2. `LANG` environment variable
3. System locale via JavaScript Intl API
4. Default: English

### Dynamic Command Translation

Dynamic slash command descriptions from skills, extensions, file commands, and
MCP prompts can be translated with AI. This is **off by default** to avoid
unexpected model calls, latency, and token usage.

```bash
/language translate status  # Show current status
/language translate on      # Enable AI translation for dynamic descriptions
/language translate off     # Disable AI translation
```

Use `/language translate cache refresh` to re-translate cached dynamic
descriptions after enabling translation, or `/language translate cache clear` to
remove cached translations.

## LLM Output Language

The LLM output language controls what language the AI assistant responds in, regardless of what language you type your questions in.

### How It Works

The LLM output language is controlled by a rule file at `~/.qwen/output-language.md`. This file is automatically included in the LLM's context during startup, instructing it to respond in the specified language.

### Auto-detection

On first startup, if no `output-language.md` file exists, Qwen Code automatically creates one based on your system locale. For example:

- System locale `zh` creates a rule for Chinese responses
- System locale `en` creates a rule for English responses
- System locale `ru` creates a rule for Russian responses
- System locale `de` creates a rule for German responses
- System locale `ja` creates a rule for Japanese responses
- System locale `pt` creates a rule for Portuguese responses
- System locale `fr` creates a rule for French responses
- System locale `ca` creates a rule for Catalan responses

### Manual Setting

Use `/language output <language>` to change:

```bash
/language output Chinese
/language output English
/language output Japanese
/language output German
```

Any language name works. The LLM will be instructed to respond in that language.

> [!note]
>
> After changing the output language, restart Qwen Code for the change to take effect.

### File Location

```
~/.qwen/output-language.md
```

## Configuration

### Via Settings Dialog

1. Run `/settings`
2. Find "Language" under General
3. Select your preferred UI language

### Via Environment Variable

```bash
export QWEN_CODE_LANG=zh
```

This influences auto-detection on first startup (if you haven’t set a UI language and no `output-language.md` file exists yet).

## Custom Language Packs

For UI translations, you can create custom language packs in `~/.qwen/locales/`:

- Example: `~/.qwen/locales/es.js` for Spanish
- Example: `~/.qwen/locales/fr.js` for French

User directory takes precedence over built-in translations.

> [!tip]
>
> Contributions are welcome! If you’d like to improve built-in translations or add new languages.
> For a concrete example, see [PR #1238: feat(i18n): add Russian language support](https://github.com/QwenLM/qwen-code/pull/1238).

### Maintaining `zh-TW` (Traditional Chinese for Taiwan)

`zh-TW` is **not** an automatic OpenCC s2t conversion of `zh.js` — it is a hand-maintained Taiwan-vocabulary translation. When adding or updating keys, please follow the conventions below.

The "CI enforced?" column indicates whether `npm run check-i18n` will fail the build on a violation. Rows marked **No** are style guidance enforced by review only — typically because the offending form has a legitimate non-UI meaning (`文件` can mean "document", `打開` is colloquially fine in Taiwan).

| Avoid                 | Use instead           | CI enforced? | Reason                                                                                                                                                                           |
| --------------------- | --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件 (file)           | 檔案                  | No           | Taiwan term for filesystem files (but `文件` can legitimately mean "document")                                                                                                   |
| 服務器 / 服务器       | 伺服器                | Yes          | Taiwan term for "server"                                                                                                                                                         |
| 菜單 / 菜单           | 選單                  | Yes          | Taiwan term for "menu"                                                                                                                                                           |
| 鏈接 / 链接           | 連結                  | Yes          | Taiwan term for "link" (bare `鏈` is fine — e.g. 區塊鏈)                                                                                                                         |
| 打開                  | 開啟                  | No           | Taiwan-preferred verb for "open" (UI); `打開` is colloquially common                                                                                                             |
| 爲 / 啓 / 曆史 / 鏈接 | 為 / 啟 / 歷史 / 連結 | Yes          | Variant Traditional forms from raw OpenCC s2t. Note: `曆` is context-dependent and correct in calendar terms (日曆, 農曆, 西曆); CI only flags the bigram `曆史`, not bare `曆`. |

If you are not a Traditional Chinese speaker and need to bootstrap a value, **do not paste raw OpenCC `s2t` output**: the default s2t profile emits variant Traditional characters (e.g. 爲, 啓) that Taiwan does not use, and never rewrites Mainland-Chinese vocabulary (服務器, 菜單). Prefer `s2twp.json` (Simplified → Taiwan with phrase mapping) as a starting point and then ask a Taiwan-Chinese speaker to review.

The `check-i18n` script (run in CI via `npm run check-i18n`) will fail the build if any of the CI-enforced substrings above end up in a `zh-TW` value. See `scripts/check-i18n.ts → ZH_TW_FORBIDDEN_PATTERNS` for the full list. If a translation legitimately needs to contain a CI-forbidden substring, add its key to `ZH_TW_ALLOWED_EXCEPTIONS` in the same file with a brief justification.

> [!note]
>
> The check uses plain substring matching, which does not understand Chinese word boundaries. A bigram pattern can therefore false-positive across compound-word boundaries — for example, `區塊鏈接口` (= `區塊鏈` + `接口`) contains the substring `鏈接` even though neither word is incorrect. If you hit a surprising CI failure of this kind, add the translation key to `ZH_TW_ALLOWED_EXCEPTIONS` rather than removing the pattern.

### Language Pack Format

```javascript
// ~/.qwen/locales/es.js
export default {
  Hello: 'Hola',
  Settings: 'Configuracion',
  // ... more translations
};
```

## Related Commands

- `/language` - Show current language settings
- `/language ui [lang]` - Set UI language
- `/language output <language>` - Set LLM output language
- `/settings` - Open settings dialog
