import { useMemo } from 'react';
import styles from './WelcomeHeader.module.css';

const TIPS = [
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

function pickTip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

function shortenPath(path: string, maxLength = 72): string {
  if (!path || path.length <= maxLength) {
    return path;
  }
  const headLength = Math.max(12, Math.floor((maxLength - 3) * 0.38));
  const tailLength = Math.max(18, maxLength - headLength - 3);
  return `${path.slice(0, headLength)}...${path.slice(-tailLength)}`;
}

function formatMode(mode: string): string {
  switch (mode) {
    case 'plan':
      return 'plan mode';
    case 'auto-edit':
      return 'auto-accept edits';
    case 'yolo':
      return 'YOLO mode';
    case 'default':
      return 'default mode';
    default:
      return mode || 'unknown mode';
  }
}

interface WelcomeHeaderProps {
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
  const tip = useMemo(() => pickTip(), []);
  const displayPath = useMemo(() => shortenPath(cwd), [cwd]);
  const model = currentModel || 'unknown model';
  const mode = formatMode(currentMode);

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
            <span>Web Shell</span>
            <span className={styles.sep}>|</span>
            <span className={styles.model}>{model}</span>
            <span className={styles.modelHint}>(/model to change)</span>
          </div>

          <div className={styles.metaLine}>
            <span>{mode}</span>
            <span className={styles.modelHint}>
              Shift+Tab or /approval-mode
            </span>
          </div>

          {displayPath && (
            <div className={styles.cwd} title={cwd}>
              {displayPath}
            </div>
          )}
        </div>
      </div>

      <div className={styles.tip}>
        <span className={styles.tipLabel}>Tips:</span>
        <span className={styles.tipText}>{tip}</span>
      </div>
    </div>
  );
}
