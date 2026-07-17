import { useCallback, useMemo, useState, type Ref } from 'react';
import { SearchIcon, ServerIcon } from 'lucide-react';
import type { SerializedMcpStatusMessage } from '../messages/McpStatusMessage';
import { ExtensionsManagerPage } from '../extensions/ExtensionsManagerPage';
import { McpManagerPage } from '../mcp/McpManagerPage';
import { SkillsManagerPage } from '../skills/SkillsManagerPage';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import { Input } from '../ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { useI18n } from '../../i18n';
import type { EmbeddedManagerPage } from './manager-page';

type PluginTab = 'extensions' | 'mcp' | 'skills';

interface PluginManagerPageProps {
  mcpMessage: SerializedMcpStatusMessage | null;
  loadMcpMessage: () => Promise<void>;
  onClose: () => void;
  onUseSkill: (name: string) => void;
  initialFocusRef?: Ref<HTMLButtonElement>;
}

export function PluginManagerPage({
  mcpMessage,
  loadMcpMessage,
  onClose,
  onUseSkill,
  initialFocusRef,
}: PluginManagerPageProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<PluginTab>('extensions');
  const [detailOpen, setDetailOpen] = useState(false);
  const [pageRevision, setPageRevision] = useState(0);
  const [mcpLoaded, setMcpLoaded] = useState(false);
  const [mcpLoadError, setMcpLoadError] = useState<string | null>(null);

  const loadMcp = useCallback(() => {
    setMcpLoaded(false);
    setMcpLoadError(null);
    void loadMcpMessage()
      .then(() => setMcpLoaded(true))
      .catch((error: unknown) => {
        setMcpLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [loadMcpMessage]);

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
    if (nextTab === 'mcp') {
      loadMcp();
    }
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
      {!detailOpen ? (
        <div className="sticky -top-4 z-10 -mx-5 -mt-4 border-b bg-background px-5 py-3">
          <TabsList className="h-8" aria-label={t('plugins.sections')}>
            <TabsTrigger ref={initialFocusRef} value="extensions">
              {t('plugins.extensions')}
            </TabsTrigger>
            <TabsTrigger value="mcp">{t('plugins.mcp')}</TabsTrigger>
            <TabsTrigger value="skills">{t('plugins.skills')}</TabsTrigger>
          </TabsList>
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
        ) : mcpLoadError ? (
          <Alert variant="destructive" className="mt-4">
            <AlertTitle>{t('plugins.mcpLoadFailed')}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{mcpLoadError}</p>
              <Button variant="outline" size="sm" onClick={loadMcp}>
                {t('common.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : mcpMessage && mcpLoaded ? (
          <McpManagerPage
            key={`mcp-${pageRevision}`}
            message={mcpMessage}
            onClose={onClose}
            embedded={embedded}
          />
        ) : (
          <div className="flex w-full flex-col gap-6 pb-8 pt-4">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t('common.search')}
                readOnly
                className="pl-9"
                placeholder={`${t('common.search')} MCP…`}
              />
            </div>
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerIcon />
                </EmptyMedia>
                <EmptyTitle>{t('mcp.empty')}</EmptyTitle>
                <EmptyDescription>{t('mcp.emptyDescription')}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
