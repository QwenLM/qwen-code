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
```

Aliases are also supported:

```bash
/language ui zh       # Chinese
/language ui en       # English
/language ui ru       # Russian
/language ui de       # German
```

### Auto-detection

On first startup, Qwen Code detects your system locale and sets the UI language automatically.

Detection priority:

1. `QWEN_CODE_LANG` environment variable
2. `LANG` environment variable
3. System locale via JavaScript Intl API
4. Default: English

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
