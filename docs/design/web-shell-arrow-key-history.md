# Web Shell arrow-key history preference

[English](web-shell-arrow-key-history.md) | [简体中文](web-shell-arrow-key-history.zh-CN.md)

## Problem

In the Web Shell composer, Up and Down can recall earlier prompts and replace the text currently visible in the editor. Users who want the arrows for editing need a way to turn off this shortcut.

## Design

Add **Recall history with arrow keys** under **Settings → UI**. The browser's local storage saves the selection across reloads. The toggle defaults to on when no preference has been saved. Changing it takes effect immediately in the active Web Shell.

The ordinary, split-pane, and managed Web Shell composers read the preference. With the toggle off, Up and Down still move the caret and navigate completion menus. Shell command history, explicit message history search, and the mobile input history list remain available.

## Acceptance criteria

- With the default setting, Up recalls a prompt and Down can restore the draft.
- After turning the setting off, Up and Down leave the draft text intact. The preference stays off after reload and turning it back on restores arrow-key recall.
- Up and Down can still move the caret and navigate completion menus. Explicit history search and the mobile input history list can still recall prompts.
