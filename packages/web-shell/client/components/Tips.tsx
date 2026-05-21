import { useMemo } from 'react';

const TIPS = [
  '试试 /insight, 从聊天记录中生成个性化洞察。',
  '输入 / 查看所有可用命令。',
  '使用 @ 引用文件路径。',
  '按 Esc 取消正在进行的请求。',
  '使用 Shift+Enter 换行。',
  '按 ↑↓ 浏览历史消息。',
];

function pickTip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

export function Tips() {
  const tip = useMemo(() => pickTip(), []);

  return (
    <div className="tips-line">
      <span className="tips-label">提示：</span>
      <span className="tips-text">{tip}</span>
    </div>
  );
}
