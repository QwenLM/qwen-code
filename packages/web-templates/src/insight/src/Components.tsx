// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';
import { useState } from 'react';
import { t, type SupportedLanguage } from './i18n';

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
  label,
  language,
}: {
  text: string;
  label?: string;
  language?: SupportedLanguage;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const displayLabel = label || (language ? t('copy', language) : 'Copy');
  const copiedLabel = language ? t('copied', language) : 'Copied!';

  return (
    <button className="copy-btn" onClick={handleCopy}>
      {copied ? copiedLabel : displayLabel}
    </button>
  );
}
