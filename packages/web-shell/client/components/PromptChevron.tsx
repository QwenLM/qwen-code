import type { CSSProperties } from 'react';

interface PromptChevronProps {
  className?: string;
  style?: CSSProperties;
}

export function PromptChevron({ className, style }: PromptChevronProps) {
  return (
    <svg
      className={className}
      style={style}
      width="0.6em"
      height="0.85em"
      viewBox="0 0 10 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1.5 1.5 L8 7 L1.5 12.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
