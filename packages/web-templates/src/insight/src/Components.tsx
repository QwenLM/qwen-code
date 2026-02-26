// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';
import { useState } from 'react';

// Simple Markdown Parser Component
export function MarkdownText({ children }: { children: string }) {
  if (!children || typeof children !== 'string') return children;

  // Split by bold markers (**text**)
  const parts = children.split(/(\*\*.*?\*\*)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return part;
      })}
    </>
  );
}

export function CopyButton({
  text,
  label = 'Copy',
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button className="copy-btn" onClick={handleCopy}>
      {copied ? 'Copied!' : label}
    </button>
  );
}
