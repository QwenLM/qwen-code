import { FolderClosedIcon, FolderPlusIcon, LockIcon } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export interface WorkspaceSelectorOption {
  id: string;
  cwd: string;
  label: string;
  primary: boolean;
  trusted: boolean;
}

interface WorkspaceSelectorProps {
  workspaces: WorkspaceSelectorOption[];
  selectedWorkspaceCwd?: string;
  disabled?: boolean;
  busy?: boolean;
  scratchSupported: boolean;
  existingFolderSupported: boolean;
  className?: string;
  onSelectWorkspace: (cwd: string | undefined) => void;
  onCreateScratch: () => void;
  onOpenExistingFolder: () => void;
}

/**
 * Composer workspace menu. Capability-gated creation actions and disabled
 * untrusted entries keep presentation aligned with daemon authorization.
 */
export function WorkspaceSelector({
  workspaces,
  selectedWorkspaceCwd,
  disabled,
  busy,
  scratchSupported,
  existingFolderSupported,
  className,
  onSelectWorkspace,
  onCreateScratch,
  onOpenExistingFolder,
}: WorkspaceSelectorProps) {
  const { t } = useI18n();
  const selected = workspaces.find((workspace) =>
    selectedWorkspaceCwd
      ? workspace.cwd === selectedWorkspaceCwd
      : workspace.primary,
  );
  const canCreate = scratchSupported || existingFolderSupported;
  if (workspaces.length <= 1 && !canCreate) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled || busy}>
        <button
          type="button"
          className={className}
          aria-label={t('sidebar.workspaceSelectLabel')}
          title={selected?.cwd}
        >
          <FolderClosedIcon size={16} strokeWidth={1.2} />
          <span data-slot="select-value">{selected?.label ?? ''}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup
          value={selected?.id}
          onValueChange={(id) => {
            const next = workspaces.find((workspace) => workspace.id === id);
            if (!next?.trusted) return;
            onSelectWorkspace(next.primary ? undefined : next.cwd);
          }}
        >
          {workspaces.map((workspace) => (
            <DropdownMenuRadioItem
              key={workspace.id}
              value={workspace.id}
              disabled={!workspace.trusted}
              title={workspace.cwd}
            >
              <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
              {!workspace.trusted && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <LockIcon />
                  {t('sidebar.workspaceUntrusted')}
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {canCreate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={busy}>
                <FolderPlusIcon />
                {t('sidebar.newWorkspace')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {scratchSupported && (
                  <DropdownMenuItem onSelect={onCreateScratch}>
                    {t('sidebar.startFromScratch')}
                  </DropdownMenuItem>
                )}
                {existingFolderSupported && (
                  <DropdownMenuItem onSelect={onOpenExistingFolder}>
                    {t('sidebar.useExistingFolder')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
