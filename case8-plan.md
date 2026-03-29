# Implementation Plan: /insight Report Language Support

## Issue

[#2022: feat: /insight report should respect user language settings](https://github.com/QwenLM/qwen-code/issues/2022)

## Problem

The `/insight` HTML report is entirely in English:

- All section headings, labels, and static text are hardcoded in English
- LLM-generated qualitative content is in English regardless of user's language setting
- `<html lang="en">` is hardcoded
- The CLI messages for `/insight` are translated, but the HTML report ignores language settings

## Solution Overview

Pass the user's preferred language through the entire insight generation pipeline:

1. **CLI command** reads the user's output language setting
2. **StaticInsightGenerator** accepts and propagates language
3. **DataProcessor** prepends language instructions to LLM prompts
4. **TemplateRenderer** sets `<html lang>` and includes language in `INSIGHT_DATA`
5. **Web app (React)** uses a built-in i18n module to translate static UI strings

## Files to Modify

### CLI Side (Node.js)

| File                                                                     | Change                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `packages/cli/src/i18n/languages.ts`                                     | Add `getLanguageCodeFromName()` reverse mapping                   |
| `packages/cli/src/utils/languageUtils.ts`                                | Export `readOutputLanguageFile()`                                 |
| `packages/cli/src/services/insight/types/StaticInsightTypes.ts`          | Add `language?: string` to `InsightData`                          |
| `packages/cli/src/services/insight/generators/StaticInsightGenerator.ts` | Accept `language` param, pass to DataProcessor & TemplateRenderer |
| `packages/cli/src/services/insight/generators/DataProcessor.ts`          | Accept `language`, prepend language instruction to LLM prompts    |
| `packages/cli/src/services/insight/generators/TemplateRenderer.ts`       | Accept `language`, set `<html lang>`, include in `INSIGHT_DATA`   |
| `packages/cli/src/ui/commands/insightCommand.ts`                         | Read user's output language, pass to generator                    |

### Web Templates (Browser React)

| File                                                     | Change                                                 |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `packages/web-templates/src/insight/src/types.ts`        | Add `language?: string` to `InsightData`               |
| `packages/web-templates/src/insight/src/i18n.ts`         | **NEW** - Translation dictionary for en/zh/ru/de/ja/pt |
| `packages/web-templates/src/insight/src/App.tsx`         | Use `t()` for static strings                           |
| `packages/web-templates/src/insight/src/Header.tsx`      | Use `t()` for stat labels                              |
| `packages/web-templates/src/insight/src/Qualitative.tsx` | Use `t()` for section titles                           |
| `packages/web-templates/src/insight/src/Charts.tsx`      | Use `t()` for chart labels                             |

## Language Resolution Flow

```
output-language.md (e.g., "Chinese")
       ↓
languageNameToLocale("Chinese") → "zh"
       ↓
Passed through pipeline
       ↓
┌──────────────────────────────────────────┐
│ DataProcessor: prepend to LLM prompts    │
│ "Please respond in Chinese."             │
├──────────────────────────────────────────┤
│ TemplateRenderer: <html lang="zh-CN">    │
│ INSIGHT_DATA.language = "zh"             │
├──────────────────────────────────────────┤
│ React App: t("Messages", "zh") → "消息"  │
└──────────────────────────────────────────┘
```

## LLM Prompt Language Instruction

For each qualitative insight prompt, prepend:

```
You MUST respond entirely in {LANGUAGE_NAME} language. All text, descriptions, and content must be in {LANGUAGE_NAME}.
```

## Translation Coverage

- English (en) - default, all strings
- Chinese (zh) - full translations
- Russian (ru) - full translations
- German (de) - full translations
- Japanese (ja) - full translations
- Portuguese (pt) - full translations
- Other languages - fall back to English keys

## Testing Strategy

1. Verify language is correctly passed through pipeline
2. Verify HTML lang attribute is set correctly
3. Verify LLM prompts include language instruction
4. Verify React components render translated strings
5. Verify fallback to English for unsupported languages
