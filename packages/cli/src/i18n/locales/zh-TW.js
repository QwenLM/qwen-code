/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import zh from './zh.js';

export default {
  ...zh,
  'When a new todo item is created': '建立新待辦事項時',
  'When a todo item is marked as completed': '待辦事項標記為完成時',
  'Input to command is JSON with todo_id, todo_content, todo_status, and all_todos. Output JSON with decision (allow/block) and reason.':
    '命令輸入為包含 todo_id、todo_content、todo_status 和 all_todos 的 JSON。輸出為包含 decision（allow/block）和 reason 的 JSON。',
  'Input to command is JSON with todo_id, todo_content, previous_status, and all_todos. Output JSON with decision (allow/block) and reason.':
    '命令輸入為包含 todo_id、todo_content、previous_status 和 all_todos 的 JSON。輸出為包含 decision（allow/block）和 reason 的 JSON。',
  'allow todo creation': '允許建立待辦事項',
  'block todo creation and show reason to model':
    '阻止建立待辦事項並向模型顯示原因',
  'allow todo completion': '允許完成待辦事項',
  'block todo completion and show reason to model':
    '阻止完成待辦事項並向模型顯示原因',
};
