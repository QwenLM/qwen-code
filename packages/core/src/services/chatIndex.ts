/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { QWEN_DIR } from '../config/storage.js';

/**
 * 会话索引数据结构
 * 存储在 <project>/.qwen/chat-index.json 中(按项目隔离)
 */
export interface ChatIndex {
  /** name -> sessionId 的映射 */
  [name: string]: string;
}

/**
 * 获取索引文件路径
 * @param projectDir 项目目录路径
 */
function getIndexPath(projectDir: string): string {
  const qwenDir = path.join(projectDir, QWEN_DIR);
  return path.join(qwenDir, 'chat-index.json');
}

/**
 * 确保项目 .qwen 目录存在
 * @param projectDir 项目目录路径
 */
async function ensureQwenDir(projectDir: string): Promise<void> {
  const qwenDir = path.join(projectDir, QWEN_DIR);
  await fs.mkdir(qwenDir, { recursive: true });
}

/**
 * 读取索引文件
 * @param projectDir 项目目录路径
 * @returns 索引对象，如果文件不存在则返回空对象
 * @throws 如果是真正的错误(非 ENOENT)，则抛出异常
 */
export async function readChatIndex(projectDir: string): Promise<ChatIndex> {
  try {
    const content = await fs.readFile(getIndexPath(projectDir), 'utf-8');
    return JSON.parse(content) as ChatIndex;
  } catch (error) {
    // 文件不存在是正常情况，返回空索引
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    // 其他错误(权限问题、I/O 错误等)应该抛出
    throw error;
  }
}

/**
 * 保存会话到索引
 * @param projectDir 项目目录路径
 * @param name 会话名称
 * @param sessionId 会话 ID
 */
export async function saveSessionToIndex(
  projectDir: string,
  name: string,
  sessionId: string,
): Promise<void> {
  await ensureQwenDir(projectDir);

  const index = await readChatIndex(projectDir);
  index[name] = sessionId;

  await fs.writeFile(
    getIndexPath(projectDir),
    JSON.stringify(index, null, 2),
    'utf-8',
  );
}

/**
 * 从索引中删除会话
 * @param projectDir 项目目录路径
 * @param name 会话名称
 * @returns 是否删除成功
 */
export async function deleteSessionFromIndex(
  projectDir: string,
  name: string,
): Promise<boolean> {
  const index = await readChatIndex(projectDir);

  if (!(name in index)) {
    return false;
  }

  delete index[name];
  await fs.writeFile(
    getIndexPath(projectDir),
    JSON.stringify(index, null, 2),
    'utf-8',
  );
  return true;
}

/**
 * 根据名称获取会话 ID
 * @param projectDir 项目目录路径
 * @param name 会话名称
 * @returns 会话 ID，如果不存在则返回 undefined
 */
export async function getSessionIdByName(
  projectDir: string,
  name: string,
): Promise<string | undefined> {
  const index = await readChatIndex(projectDir);
  return index[name];
}

/**
 * 列出所有已命名的会话
 * @param projectDir 项目目录路径
 * @returns 名称到 sessionId 的映射
 */
export async function listNamedSessions(
  projectDir: string,
): Promise<ChatIndex> {
  return await readChatIndex(projectDir);
}
