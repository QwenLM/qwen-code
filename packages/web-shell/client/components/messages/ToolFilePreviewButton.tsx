import { useEffect, useRef, useState } from 'react';
import { SquareArrowOutUpRightIcon } from 'lucide-react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type { ACPToolCall } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { useTranscriptRenderMode } from '../../transcriptRenderMode';
import type { TurnOutputOpenRequest } from '../artifacts/TurnOutputs';
import { getImageMimeTypeFromPath } from '../artifacts/artifactUtils';
import { getToolFilePath } from '../artifacts/turnOutputSelectors';
import { useArtifactWorkspaceTarget } from '../artifacts/useArtifactWorkspaceTarget';
import { Button } from '../ui/button';

export function ToolFilePreviewButton({
  tool,
  workspaceCwd,
  onOpen,
}: {
  tool: ACPToolCall;
  workspaceCwd?: string;
  onOpen?: (request: TurnOutputOpenRequest) => void;
}) {
  const renderMode = useTranscriptRenderMode();
  const filePath = getToolFilePath(tool);
  if (
    renderMode !== 'interactive' ||
    !onOpen ||
    !workspaceCwd ||
    !filePath?.trim()
  )
    return null;
  return (
    <AvailableFileButton
      key={JSON.stringify([workspaceCwd, filePath, tool.callId])}
      filePath={filePath}
      workspaceCwd={workspaceCwd}
      tool={tool}
      onOpen={onOpen}
    />
  );
}

function AvailableFileButton({
  filePath,
  workspaceCwd,
  tool,
  onOpen,
}: {
  filePath: string;
  workspaceCwd: string;
  tool: ACPToolCall;
  onOpen: (request: TurnOutputOpenRequest) => void;
}) {
  const { t } = useI18n();
  const { status } = useWorkspace();
  const target = useArtifactWorkspaceTarget(workspaceCwd);
  const actions = target?.actions;
  const [availableFor, setAvailableFor] = useState<typeof actions>();
  const requests = useRef({ sequence: 0 }).current;
  const current = useRef({ actions, status, onOpen });
  current.current = { actions, status, onOpen };

  useEffect(() => {
    setAvailableFor(undefined);
    if (!actions || status !== 'connected') return;
    const check = async () => {
      const request = ++requests.sequence;
      try {
        const stat = await actions.stat(filePath);
        if (request === requests.sequence) {
          setAvailableFor(stat.type === 'file' ? actions : undefined);
        }
      } catch {
        if (request === requests.sequence) setAvailableFor(undefined);
      }
    };
    void check();
    window.addEventListener('focus', check);
    return () => {
      requests.sequence++;
      window.removeEventListener('focus', check);
    };
  }, [actions, filePath, requests, status, tool.status]);

  if (!actions || status !== 'connected' || availableFor !== actions)
    return null;

  const open = async () => {
    const request = ++requests.sequence;
    try {
      const stat = await actions.stat(filePath);
      if (
        request !== requests.sequence ||
        current.current.actions !== actions ||
        current.current.status !== 'connected' ||
        current.current.onOpen !== onOpen
      )
        return;
      if (stat.type !== 'file') {
        setAvailableFor(undefined);
        return;
      }
      onOpen({
        id: `file:${workspaceCwd}:${filePath}`,
        kind: 'attachment',
        title: filePath.split(/[/\\]/).pop() || filePath,
        turnId: tool.callId,
        workspacePath: filePath,
        workspaceCwd,
        silentUnavailable: true,
      });
    } catch {
      if (request === requests.sequence) setAvailableFor(undefined);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="ml-auto text-muted-foreground"
      title={t('tool.viewCurrentFile')}
      onClick={() => void open()}
    >
      {t(
        getImageMimeTypeFromPath(filePath) ? 'tool.viewImage' : 'tool.viewFile',
      )}
      <SquareArrowOutUpRightIcon aria-hidden="true" />
    </Button>
  );
}
