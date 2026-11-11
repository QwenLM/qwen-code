/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { platform, homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { CLI_DISPLAY_NAME } from '../../brand.js';
import {
  CommandKind,
  type SlashCommand,
  type CommandContext,
} from './types.js';

/** /insights 的产品注入点：品牌文案、报告页脚与诊断日志。 */
export interface InsightsCommandOptions {
  /** 报告标题/页脚与命令文案中的产品显示名；缺省用本包品牌。 */
  productName?: string;
  /** 报告页脚的产品链接；缺省不渲染。 */
  footerLink?: string;
  /** 在可执行文件旁写 htmlPath 诊断日志（Windows 路径问题取证用）。 */
  debugLog?: boolean;
}

/**
 * 完整实现归 cli；产品差异只有品牌与诊断，经 options 注入。
 * 内置命令用缺省品牌，插件传入自己的品牌与页脚。
 */
export function createInsightsCommand(
  options: InsightsCommandOptions = {},
): SlashCommand {
  const productName = options.productName ?? CLI_DISPLAY_NAME;
  return {
    name: 'insights',
    description: `Generate a report analyzing your ${productName} sessions`,
    kind: CommandKind.BUILT_IN,
    autoExecute: true,

    async action(context: CommandContext, _args: string) {
      const agentContext = context.services.agentContext;
      if (!agentContext) {
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content: 'Agent context is not available.',
        };
      }

      // The package root exposes this factory before --config-dir is applied.
      const [{ generateInsights }, { MessageType }] = await Promise.all([
        import('@qwen-code/core'),
        import('../types.js'),
      ]);
      const config = agentContext.config;
      // 始终扫描项目根的历史：worktree 会话的 transcript 也归属原项目。
      const cwd = config.getSessionArtifactProjectRoot();
      const { ui } = context;

      const abortController = new AbortController();
      const unregister = ui.registerCancellable(() => {
        abortController.abort();
      });

      ui.setPendingItem({
        type: MessageType.INFO,
        text: `Analyzing your ${productName} history...`,
      });

      try {
        const report = await generateInsights({
          config,
          cwd,
          productName,
          footerLink: options.footerLink,
          abortSignal: abortController.signal,
          onProgress: (phase, detail) => {
            ui.setPendingItem({
              type: MessageType.INFO,
              text: `${phase} ${detail}`,
            });
          },
        });

        ui.setPendingItem(null);
        unregister();

        // Ink 渲染带反斜杠的 Windows 路径会吞字符，展示层统一用正斜杠。
        const htmlPath = normalize(report.htmlPath);
        const displayPath = htmlPath.split('\\').join('/');

        if (options.debugLog) {
          writeDebugLog(htmlPath);
        }

        openInBrowser(htmlPath);

        ui.addItem(
          {
            type: MessageType.INFO,
            text: `Insights report generated: ${displayPath}`,
          },
          Date.now(),
        );
      } catch (err) {
        ui.setPendingItem(null);
        unregister();
        const message =
          err instanceof Error ? err.message : 'Unknown error occurred';
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Insights generation failed: ${message}`,
          },
          Date.now(),
        );
      }

      return undefined;
    },
  };
}

function writeDebugLog(htmlPath: string): void {
  const execDir = dirname(process.execPath);
  const debugLogPath = join(execDir, 'insights-debug.log');
  const debugContent = `[${new Date().toISOString()}]\nreport.htmlPath: ${JSON.stringify(htmlPath)}\nos.homedir(): ${JSON.stringify(homedir())}\nplatform: ${platform()}\n\n`;
  try {
    appendFileSync(debugLogPath, debugContent, 'utf-8');
  } catch {
    /* ignore write errors */
  }
}

/** 内置命令：本包品牌的缺省实例。 */
export const insightsCommand: SlashCommand = createInsightsCommand();

function openInBrowser(filePath: string): void {
  const os = platform();
  let command: string;
  let args: string[];

  if (os === 'darwin') {
    command = 'open';
    args = [filePath];
  } else if (os === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    command = 'xdg-open';
    args = [filePath];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
