# Qwen Code General, UI, IDE & Output Settings Reference

## `general` — General Settings

```jsonc
// ~/.qwen/settings.json
{
  "general": {
    "preferredEditor": "vim", // preferred editor for opening files
    "vimMode": false, // Vim keybindings (default: false)
    "enableAutoUpdate": true, // check for updates on startup (default: true)
    "gitCoAuthor": true, // auto-add Co-authored-by to git commits (default: true)
    "language": "auto", // UI language ("auto" = follow system)
    // custom languages: place JS files in ~/.qwen/locales/
    "outputLanguage": "auto", // LLM output language ("auto" = follow system)
    "terminalBell": true, // play terminal bell when response completes (default: true)
    "chatRecording": true, // save chat history to disk (default: true)
    // disabling this breaks --continue and --resume
    "debugKeystrokeLogging": false, // enable debug keystroke logging
    "defaultFileEncoding": "utf-8", // default file encoding
    // "utf-8" | "utf-8-bom"
    "checkpointing": {
      "enabled": false, // session checkpointing/recovery (default: false)
    },
  },
}
```

### Common Scenarios

#### Enable Vim Mode

```jsonc
{
  "general": {
    "vimMode": true,
  },
}
```

#### Disable Auto Update

```jsonc
{
  "general": {
    "enableAutoUpdate": false,
  },
}
```

#### Switch UI Language

```jsonc
{
  "general": {
    "language": "zh", // or "en", "ja", "auto"
  },
}
```

#### Set Preferred Editor

```jsonc
{
  "general": {
    "preferredEditor": "code", // or "vim", "nvim", "sublime", etc.
  },
}
```

#### Configure File Encoding

```jsonc
{
  "general": {
    "defaultFileEncoding": "utf-8-bom", // for projects requiring BOM
  },
}
```

---

## `ui` — UI Settings

```jsonc
{
  "ui": {
    "theme": "Qwen Dark", // color theme name
    "customThemes": {}, // custom theme definitions
    "hideWindowTitle": false, // hide the window title bar
    "showStatusInTitle": false, // show agent status and thoughts in terminal title
    "hideTips": false, // hide helpful tips in the UI
    "showLineNumbers": true, // show line numbers in code output (default: true)
    "showCitations": false, // show citations for generated text
    "customWittyPhrases": [], // custom phrases to show during loading
    "enableWelcomeBack": true, // show welcome-back dialog when returning to a project
    "enableUserFeedback": true, // show feedback dialog after conversations
    "accessibility": {
      "enableLoadingPhrases": true, // enable loading phrases (disable for accessibility)
      "screenReader": false, // screen reader mode (plain-text rendering)
    },
  },
}
```

### Common Scenarios

#### Switch Theme

```jsonc
{
  "ui": {
    "theme": "Qwen Light", // or "Qwen Dark"
  },
}
```

#### Hide Tips

```jsonc
{
  "ui": {
    "hideTips": true,
  },
}
```

#### Enable Screen Reader Mode

```jsonc
{
  "ui": {
    "accessibility": {
      "screenReader": true,
    },
  },
}
```

#### Show Agent Status in Title

```jsonc
{
  "ui": {
    "showStatusInTitle": true,
  },
}
```

---

## `ide` — IDE Integration Settings

```jsonc
{
  "ide": {
    "enabled": false, // auto-connect to IDE (default: false)
    "hasSeenNudge": false, // whether the user has seen the IDE integration nudge
  },
}
```

---

## `output` — Output Format

```jsonc
{
  "output": {
    "format": "text", // "text" | "json"
  },
}
```

The `json` format is useful for programmatic integration scenarios.
