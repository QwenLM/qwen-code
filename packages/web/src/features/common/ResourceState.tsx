import type { ReactNode } from 'react';

interface ResourceStateProps {
  loading?: boolean;
  error?: Error;
  empty?: boolean;
  emptyText?: string;
  children: ReactNode;
}

export function ResourceState({
  loading,
  error,
  empty,
  emptyText = 'No data yet.',
  children,
}: ResourceStateProps) {
  if (loading) return <div className="web-empty">Loading…</div>;
  if (error) return <div className="web-error">{error.message}</div>;
  if (empty) return <div className="web-empty">{emptyText}</div>;
  return <>{children}</>;
}

export function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
