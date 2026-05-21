import { Markdown } from './Markdown';

interface AssistantMessageProps {
  content: string;
  thinking?: string;
}

export function AssistantMessage({ content, thinking }: AssistantMessageProps) {
  return (
    <div className="msg msg-assistant">
      {thinking && (
        <div className="msg-thinking-inline">
          <span className="msg-prefix-assist">✦</span>
          <pre>{thinking}</pre>
        </div>
      )}

      {content && (
        <div className="msg-content">
          <span className="msg-prefix-assist">✦</span>
          <div className="msg-content-body">
            <Markdown content={content} />
          </div>
        </div>
      )}
    </div>
  );
}
