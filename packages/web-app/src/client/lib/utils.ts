import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortenTitle(title: string, maxLen = 50): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen - 3) + '...';
}

export function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

export function isMacOS(): boolean {
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
}
