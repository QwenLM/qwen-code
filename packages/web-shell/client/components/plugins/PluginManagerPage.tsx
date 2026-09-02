import { useCallback, useEffect, useMemo, useState, type Ref } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { AgentsManagerPage } from '../agents/AgentsManagerPage';
import { ExtensionsManagerPage } from '../extensions/ExtensionsManagerPage';
import { McpManagerPage } from '../mcp/McpManagerPage';
import { SkillsManagerPage } from '../skills/SkillsManagerPage';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { useI18n } from '../../i18n';
import { workspaceLabel } from '../../utils/workspace';
import type { EmbeddedManagerPage } from './manager-page';

type PluginTab = 'extensions' | 'mcp' | 'skills' | 'agents';

interface PluginManagerPageProps {
  onClose: () => void;
  onUseSkill: (name: string) => void;
  initialFocusRef?: Ref<HTMLButtonElement>;
}

export function PluginManagerPage({
  onClose,
  onUseSkill,
  initialFocusRef,
}: PluginManagerPageProps) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const workspaces = useMemo(() => {
    const listed = (workspace.capabilities?.workspaces ?? []).filter(
      (entry) => entry.kind !== 'live',
    );
    if (listed.length > 0) return listed;
    return workspace.workspaceCwd
      ? [
          {
            id: 'primary',
            cwd: workspace.workspaceCwd,
            primary: true,
            trusted: true,
          },
        ]
      : [];
  }, [workspace.capabilities?.workspaces, workspace.workspaceCwd]);
  const defaultWorkspaceCwd =
    workspaces.find(
      (entry) => entry.cwd === workspace.workspaceCwd && entry.trusted,
    )?.cwd ??
    workspaces.find((entry) => entry.primary && entry.trusted)?.cwd ??
    workspaces.find((entry) => entry.trusted)?.cwd;
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState(
    () => defaultWorkspaceCwd,
  );
  const [activeTab, setActiveTab] = useState<PluginTab>('extensions');
  const [detailOpen, setDetailOpen] = useState(false);
  const [pageRevision, setPageRevision] = useState(0);

  useEffect(() => {
    if (
      selectedWorkspaceCwd &&
      workspaces.some(
        (entry) => entry.cwd === selectedWorkspaceCwd && entry.trusted,
      )
    ) {
      return;
    }
    setSelectedWorkspaceCwd(defaultWorkspaceCwd);
  }, [defaultWorkspaceCwd, selectedWorkspaceCwd, workspaces]);

  const resetToRoot = useCallback(() => {
    setDetailOpen(false);
    setPageRevision((revision) => revision + 1);
  }, []);
  const embedded = useMemo<EmbeddedManagerPage>(
    () => ({ onRoot: resetToRoot, onDetailChange: setDetailOpen }),
    [resetToRoot],
  );

  const handleTabChange = (value: string) => {
    const nextTab = value as PluginTab;
    setActiveTab(nextTab);
    setDetailOpen(false);
    setPageRevision((revision) => revision + 1);
  };

  const workspaceSelect = (disabled: boolean) =>
    activeTab === 'mcp' && workspaces.length > 1 ? (
      <Select
        value={selectedWorkspaceCwd}
        disabled={disabled}
        onValueChange={(cwd) => {
          setSelectedWorkspaceCwd(cwd);
          setDetailOpen(false);
          setPageRevision((revision) => revision + 1);
        }}
      >
        <SelectTrigger
          className="h-8 w-48"
          aria-label={t('sidebar.workspaceSelectLabel')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((entry) => (
            <SelectItem
              key={entry.id}
              value={entry.cwd}
              disabled={!entry.trusted}
            >
              {workspaceLabel(entry)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
      {!detailOpen ? (
        <div className="sticky -top-4 z-10 -mx-5 -mt-4 flex items-center justify-between gap-3 border-b bg-background px-5 py-3">
          <TabsList className="h-8" aria-label={t('plugins.sections')}>
            <TabsTrigger ref={initialFocusRef} value="extensions">
              {t('plugins.extensions')}
            </TabsTrigger>
            <TabsTrigger value="mcp">{t('plugins.mcp')}</TabsTrigger>
            <TabsTrigger value="skills">{t('plugins.skills')}</TabsTrigger>
            <TabsTrigger value="agents">{t('plugins.agents')}</TabsTrigger>
          </TabsList>
          {workspaceSelect(false)}
        </div>
      ) : null}

      <TabsContent value={activeTab} className="mt-0">
        {activeTab === 'extensions' ? (
          <ExtensionsManagerPage
            key={`extensions-${pageRevision}`}
            onClose={onClose}
            embedded={embedded}
          />
        ) : activeTab === 'skills' ? (
          <SkillsManagerPage
            key={`skills-${pageRevision}`}
            onClose={onClose}
            onUseSkill={onUseSkill}
            embedded={embedded}
          />
        ) : activeTab === 'agents' ? (
          <AgentsManagerPage
            key={`agents-${pageRevision}`}
            onClose={onClose}
            embedded={embedded}
          />
        ) : (
          <McpManagerPage
            key={`mcp-${pageRevision}-${selectedWorkspaceCwd ?? ''}`}
            onClose={onClose}
            embedded={embedded}
            workspaceCwd={selectedWorkspaceCwd}
            workspaceControl={workspaceSelect(true)}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}
