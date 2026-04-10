/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { QWEN_DIR } from '../config/storage.js';

/**
 * 会话索引数据结构
 * 存储在 ~/.qwen/chat-index.json 中
 */
export interface ChatIndex {
  /** name -> sessionId 的映射 */
  [name: string]: string;
}

/**
 * 获取索引文件路径
 */
function getIndexPath(): string {
  return path.join(os.homedir(), QWEN_DIR, 'chat-index.json');
}

/**
 * 确保 ~/.qwen 目录存在
 */
async function ensureQwenDir(): Promise<void> {
  const qwenDir = path.join(os.homedir(), QWEN_DIR);
  await fs.mkdir(qwenDir, { recursive: true });
}

/**
 * 读取索引文件
 * @returns 索引对象，如果文件不存在则返回空对象
 */
export async function readChatIndex(): Promise<ChatIndex> {
  try {
    const content = await fs.readFile(getIndexPath(), 'utf-8');
    return JSON.parse(content) as ChatIndex;
  } catch (error) {
    // 文件不存在或解析错误，返回空索引
    return {};
  }
}

/**
 * 保存会话到索引
 * @param name 会话名称
 * @param sessionId 会话 ID
 */
export async function saveSessionToIndex(
  name: string,
  sessionId: string,
): Promise<void> {
  await ensureQwenDir();
  
  const index = await readChatIndex();
  index[name] = sessionId;
  
  await fs.writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
}

/**
 * 从索引中删除会话
 * @param name 会话名称
 * @returns 是否删除成功
 */
export async function deleteSessionFromIndex(name: string): Promise<boolean> {
  const index = await readChatIndex();
  
  if (!(name in index)) {
    return false;
  }
  
  delete index[name];
  await fs.writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
  return true;
}

/**
 * 根据名称获取会话 ID
 * @param name 会话名称
 * @returns 会话 ID，如果不存在则返回 undefined
 */
export async function getSessionIdByName(name: string): Promise<string | undefined> {
  const index = await readChatIndex();
  return index[name];
}

/**
 * 列出所有已命名的会话
 * @returns 名称到 sessionId 的映射
 */
export async function listNamedSessions(): Promise<ChatIndex> {
  return await readChatIndex();
}
