import type { SVGProps } from 'react';

export function MonitorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M4 12h3l2-5 4 10 2-5h5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
