/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SVGProps } from 'react';

type SidebarIconProps = SVGProps<SVGSVGElement>;

export function FolderIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M3.5 7.8c0-1.1.9-2 2-2h4.2l1.8 2.1h7c1.1 0 2 .9 2 2v7.5c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2V7.8Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M3.8 11h16.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function FolderPlusIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M3.5 7.8c0-1.1.9-2 2-2h4.2l1.8 2.1h7c1.1 0 2 .9 2 2v7.5c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2V7.8Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M15.5 14.9h4.2m-2.1-2.1V17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function NewThreadIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M6.2 17.8 17.8 6.2M12.8 6.2h5v5M6.2 11.2v6.6h6.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function SlidersIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M5.5 7h13M8.5 12h7M10.5 17h3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function OpenThreadIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      {...props}
    >
      <path
        d="M8.2 7.2h8.6v8.6M16.4 7.6 7.2 16.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function ChatBubbleIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M5.2 6.7c0-1.2 1-2.2 2.2-2.2h9.2c1.2 0 2.2 1 2.2 2.2v6.2c0 1.2-1 2.2-2.2 2.2h-5.3l-4.2 4v-4H7.4c-1.2 0-2.2-1-2.2-2.2V6.7Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M8.8 8.8h6.4M8.8 11.5h4.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function DiffIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M6.5 5.5v13M17.5 5.5v13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
      <path
        d="M4.4 9.5h4.2M15.4 9.5h4.2M13.3 14.6h6.3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function RefreshIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M18.5 7.6a7 7 0 1 0 1 6.1M18.6 4.6v3.3h-3.3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function CloseIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="m7.2 7.2 9.6 9.6M16.8 7.2l-9.6 9.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function TerminalIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M4.6 6.5c0-1.1.9-2 2-2h10.8c1.1 0 2 .9 2 2v11c0 1.1-.9 2-2 2H6.6c-1.1 0-2-.9-2-2v-11Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="m8 9 2.6 2.6L8 14.2M12.4 14.3h3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function ChevronUpIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="m7.2 14.2 4.8-4.8 4.8 4.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

export function ChevronDownIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="m7.2 9.8 4.8 4.8 4.8-4.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

export function CopyIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M8.2 8.2h8.1c.9 0 1.6.7 1.6 1.6v8.1c0 .9-.7 1.6-1.6 1.6H8.2c-.9 0-1.6-.7-1.6-1.6V9.8c0-.9.7-1.6 1.6-1.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M10.2 4.5h5.6c.9 0 1.7.8 1.7 1.7M4.5 15.8V8.2c0-.9.8-1.7 1.7-1.7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function SendIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="m5 12 14-7-5.1 14-2.7-5.8L5 12Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="m11.2 13.2 3.5-3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function TrashIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M7.3 8.4h9.4l-.7 9.1c-.1 1.1-.9 1.9-2 1.9h-4c-1.1 0-1.9-.8-2-1.9l-.7-9.1ZM9.3 5.8h5.4M10.3 5.8l.4-1.2h2.6l.4 1.2M6.2 8.4h11.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function StopIcon(props: SidebarIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d="M8 8h8v8H8z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
