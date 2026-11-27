import { FolderXIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { languageDirection, type WebShellLanguage } from '../i18n';
import { Button } from './ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './ui/empty';

interface WorkspaceUnavailableStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  theme?: 'dark' | 'light';
  language?: WebShellLanguage;
  icon?: ReactNode;
}

export function WorkspaceUnavailableState({
  title,
  description,
  actionLabel,
  onAction,
  theme,
  language = 'en',
  icon,
}: WorkspaceUnavailableStateProps) {
  return (
    <div
      data-web-shell-root
      data-web-shell-shadcn
      lang={language}
      dir={languageDirection(language)}
      className={`flex min-h-48 w-full items-center justify-center p-4 ${theme === 'dark' ? 'dark' : ''}`}
    >
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon ?? <FolderXIcon />}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {actionLabel && onAction ? (
          <EmptyContent>
            <Button onClick={onAction}>{actionLabel}</Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
}
