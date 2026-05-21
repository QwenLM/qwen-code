interface UserMessageProps {
  content: string;
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <div className="msg msg-user">
      <span className="msg-prefix">&gt;</span>
      <span className="msg-body">{content}</span>
    </div>
  );
}
