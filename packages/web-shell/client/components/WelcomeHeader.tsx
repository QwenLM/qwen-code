import { useMemo } from 'react';
import { useI18n } from '../i18n';
import styles from './WelcomeHeader.module.css';

const TIPS_EN = [
  'Type / to open commands; Tab completes slash commands and saved prompts.',
  'Add a QWEN.md file to give Qwen Code durable project context.',
  'Use ! to run shell commands through Qwen Code, for example !ls.',
  'When a chat gets long, use /compress to free context.',
  'Use Shift+Tab or /approval-mode to switch approval modes quickly.',
  'Use /clear or /new to start fresh; previous sessions stay resumable.',
];

const TIPS_ZH = [
  '输入 / 打开命令弹窗；Tab 可以补全斜杠命令和已保存的 prompt。',
  '添加 QWEN.md 文件，为 Qwen Code 提供持久的项目上下文。',
  '可以使用 ! 从 Qwen Code 运行 shell 命令，例如 !ls。',
  '对话变长时，使用 /compress 压缩历史并释放上下文。',
  '使用 Shift+Tab 或 /approval-mode 快速切换权限模式。',
  '使用 /clear 或 /new 开始新想法；之前的会话仍可从历史恢复。',
];

const ASCII_LOGO = `
 ▄▄▄▄▄▄  ▄▄     ▄▄ ▄▄▄▄▄▄▄ ▄▄▄    ▄▄
██╔═══██╗██║    ██║██╔════╝████╗  ██║
██║   ██║██║ █╗ ██║█████╗  ██╔██╗ ██║
██║▄▄ ██║██║███╗██║██╔══╝  ██║╚██╗██║
╚██████╔╝╚███╔███╔╝███████╗██║ ╚████║
 ╚══▀▀═╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝
`.trim();

function pickTip(language: string): string {
  const tips = language === 'zh-CN' ? TIPS_ZH : TIPS_EN;
  return tips[Math.floor(Math.random() * tips.length)];
}

function shortenPath(path: string, maxLength = 72): string {
  if (!path || path.length <= maxLength) {
    return path;
  }
  const headLength = Math.max(12, Math.floor((maxLength - 3) * 0.38));
  const tailLength = Math.max(18, maxLength - headLength - 3);
  return `${path.slice(0, headLength)}...${path.slice(-tailLength)}`;
}

function formatMode(mode: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (mode) {
    case 'plan':
      return t('mode.plan');
    case 'auto-edit':
      return t('mode.auto-edit');
    case 'yolo':
      return t('mode.yolo');
    case 'default':
      return t('mode.default');
    default:
      return mode || t('mode.unknown');
  }
}

export interface WelcomeHeaderProps {
  version: string;
  cwd: string;
  currentModel: string;
  currentMode: string;
}

export function WelcomeHeader({
  version,
  cwd,
  currentModel,
  currentMode,
}: WelcomeHeaderProps) {
  const { language, t } = useI18n();
  const tip = useMemo(() => pickTip(language), [language]);
  const displayPath = useMemo(() => shortenPath(cwd), [cwd]);
  const model = currentModel || t('welcome.defaultModel');
  const mode = formatMode(currentMode, t);

  return (
    <div className={styles.header}>
      <div className={styles.banner}>
        <pre className={styles.logo} aria-hidden="true">
          {ASCII_LOGO}
        </pre>

        <div className={styles.panel}>
          <div className={styles.titleRow}>
            <span className={styles.title}>{'>_ Qwen Code'}</span>
            {version && <span className={styles.version}>(v{version})</span>}
          </div>

          <div className={styles.subtitle} aria-hidden="true">
            &nbsp;
          </div>

          <div className={styles.metaLine}>
            <span className={styles.terminalLabel}>Web terminal</span>
            <span className={styles.sep}>|</span>
            <span className={styles.model}>{model}</span>
            <span className={styles.modelHint}>{t('welcome.changeModel')}</span>
          </div>

          <div className={styles.metaLine}>
            <span>{mode}</span>
            <span className={styles.modelHint}>{t('welcome.modeHint')}</span>
          </div>

          {displayPath && (
            <div className={styles.cwd} title={cwd}>
              {displayPath}
            </div>
          )}
        </div>
      </div>

      <div className={styles.tip}>
        <span className={styles.tipLabel}>{t('welcome.tipLabel')}</span>
        <span className={styles.tipText}>{tip}</span>
      </div>
    </div>
  );
}
