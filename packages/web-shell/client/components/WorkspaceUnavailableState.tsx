import { FolderXIcon } from 'lucide-react';
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
  actionLabel: string;
  onAction: () => void;
  theme?: 'dark' | 'light';
}

export function WorkspaceUnavailableState({
  title,
  description,
  actionLabel,
  onAction,
  theme,
}: WorkspaceUnavailableStateProps) {
  return (
    <div
      data-web-shell-root
      data-web-shell-shadcn
      className={`flex min-h-48 w-full items-center justify-center p-4 ${theme === 'dark' ? 'dark' : ''}`}
    >
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderXIcon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onAction}>{actionLabel}</Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
