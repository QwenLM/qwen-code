import { useEffect, useRef, type ReactNode } from 'react';
import {
  AlertCircleIcon,
  CircleCheckIcon,
  InfoIcon,
  XIcon,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription } from './alert';
import { Button } from './button';
import { Spinner } from './spinner';

export type ManagementNoticeTone = 'error' | 'success' | 'info' | 'progress';

interface ManagementNoticeProps {
  children: ReactNode;
  closeLabel: string;
  noticeKey: string;
  onDismiss: () => void;
  tone: ManagementNoticeTone;
  className?: string;
}

export function ManagementNotice({
  children,
  closeLabel,
  noticeKey,
  onDismiss,
  tone,
  className,
}: ManagementNoticeProps) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (tone === 'error' || tone === 'progress') return;
    const timer = window.setTimeout(() => onDismissRef.current(), 3_000);
    return () => window.clearTimeout(timer);
  }, [noticeKey, tone]);

  return (
    <Alert
      variant={
        tone === 'error'
          ? 'destructive'
          : tone === 'success'
            ? 'success'
            : 'default'
      }
    >
      {tone === 'error' ? (
        <AlertCircleIcon />
      ) : tone === 'success' ? (
        <CircleCheckIcon />
      ) : tone === 'progress' ? (
        <Spinner />
      ) : (
        <InfoIcon />
      )}
      <AlertDescription className={className}>{children}</AlertDescription>
      {tone !== 'progress' ? (
        <AlertAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onDismiss}
          >
            <XIcon />
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
