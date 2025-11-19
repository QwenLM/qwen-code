# Qwen Code Theme Command

## Overview

The `/theme` command in Qwen Code opens a dialog that allows users to change the visual theme of the CLI. This command provides an interactive interface for selecting from built-in themes and custom themes defined in settings. The implementation has been optimized for performance, memory efficiency, and responsiveness.

## How It Works

### 1. Command Invocation

- Typing `/theme` in the Qwen Code CLI triggers the theme dialog
- The command is handled by `themeCommand` which returns a dialog action with type 'theme'

### 2. Dialog Interface

The ThemeDialog component provides:

- A left panel with theme selection (radio button list)
- A right panel with live theme preview showing code and diff examples
- Tab navigation between theme selection and scope configuration
- Scope selector to choose where to save the theme setting (user/workspace/system)
- **Optimized rendering**: Uses React.memo and useMemo to prevent unnecessary re-renders and calculations

### 3. Available Themes

Built-in themes include:

- **Dark Themes**: AyuDark, AtomOneDark, Dracula, GitHubDark, DefaultDark, QwenDark, ShadesOfPurple
- **Light Themes**: AyuLight, GitHubLight, GoogleCode, DefaultLight, QwenLight, XCode
- **ANSI Themes**: ANSI, ANSILight

### 4. Custom Themes

- Users can define custom themes in their settings.json file
- Custom themes can be added via `customThemes` object in the settings
- Theme files can also be loaded directly from JSON files (only from within the home directory for security)
- **Optimized loading**: Implements caching for faster theme retrieval and reduced processing

### 5. Theme Preview

- The dialog shows a live preview of the selected theme
- Includes Python code highlighting and a diff example
- This helps users see how the theme will look before applying it
- **Performance optimized**: Layout calculations are memoized to avoid redundant computations

### 6. Theme Application

- When a theme is selected, it's applied immediately to the preview
- When confirmed, the theme is saved to the selected scope (user/workspace/system)
- The theme persists across sessions
- **Efficient theme switching**: Uses optimized lookup mechanisms in the theme manager

### 7. Security Note

- For security, theme files can only be loaded from within the user's home directory
- This prevents loading potentially malicious theme files from untrusted sources
- **Memory safety**: Implements proper cache clearing to prevent memory leaks

## Performance Optimizations

- **Theme Manager**: Implements O(1) theme lookup using name-based cache
- **File Loading**: Caches loaded theme files separately to avoid re-reading from disk
- **UI Rendering**: Uses React hooks (useMemo, useCallback) for efficient re-rendering
- **Memory Management**: Provides methods for clearing theme caches to prevent memory bloat
- **Custom Theme Processing**: Optimized validation and loading of custom themes

## Usage Steps

1. Type `/theme` in Qwen Code CLI
2. Browse themes using arrow keys (with live preview)
3. Press Enter to select a theme or Tab to switch to scope configuration
4. If switching to scope configuration, select the scope where you want to save the theme
5. The selected theme will be applied and saved to your settings

## Configuration

Themes can also be set directly in settings.json:

```json
{
  "ui": {
    "theme": "QwenDark",
    "customThemes": {
      "MyCustomTheme": {
        "name": "MyCustomTheme",
        "type": "dark",
        "Foreground": "#ffffff",
        "Background": "#000000"
        // ... other color definitions
      }
    }
  }
}
```
