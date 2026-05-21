interface SystemMessageProps {
  content: string;
  variant: 'info' | 'error' | 'warning';
}

export function SystemMessage({ content, variant }: SystemMessageProps) {
  return (
    <div className={`msg-system msg-system-${variant}`}>
      <pre>{content}</pre>
    </div>
  );
}
