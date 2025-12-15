# Language Command

The `/language` command allows you to customize the language settings for both the Qwen Code user interface (UI) and the language model's output. This command supports two distinct functionalities:

1. Setting the UI language for the Qwen Code interface
2. Setting the output language for the language model (LLM)

## UI Language Settings

To change the UI language of Qwen Code, use the `ui` subcommand:

```
/language ui [zh-CN|en-US|ru-RU]
```

### Available UI Languages

- **zh-CN**: Simplified Chinese (简体中文)
- **en-US**: English
- **ru-RU**: Russian (Русский)

### Examples

```
/language ui zh-CN    # Set UI language to Simplified Chinese
/language ui en-US    # Set UI language to English
/language ui ru-RU    # Set UI language to Russian
```

### UI Language Subcommands

You can also use direct subcommands for convenience:

- `/language ui zh-CN` or `/language ui zh` or `/language ui 中文`
- `/language ui en-US` or `/language ui en` or `/language ui english`
- `/language ui ru-RU` or `/language ui ru` or `/language ui русский`

## LLM Output Language Settings

To set the language for the language model's responses, use the `output` subcommand:

```
/language output <language>
```

This command generates a language rule file that instructs the LLM to respond in the specified language. The rule file is saved to `~/.qwen/output-language.md`.

### Examples

```
/language output 中文      # Set LLM output language to Chinese
/language output English   # Set LLM output language to English
/language output 日本語    # Set LLM output language to Japanese
```

## Viewing Current Settings

When used without arguments, the `/language` command displays the current language settings:

```
/language
```

This will show:

- Current UI language
- Current LLM output language (if set)
- Available subcommands

## Notes

- UI language changes take effect immediately and reload all command descriptions
- LLM output language settings are persisted in a rule file that is automatically included in the model's context
- To request additional UI language packs, please open an issue on GitHub
