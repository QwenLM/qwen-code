import { useCallback, useMemo, useState, type Ref } from 'react';
import type { SerializedMcpStatusMessage } from '../messages/McpStatusMessage';
import { ExtensionsManagerPage } from '../extensions/ExtensionsManagerPage';
import { McpManagerPage } from '../mcp/McpManagerPage';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { useI18n } from '../../i18n';
import type { EmbeddedManagerPage } from './manager-page';

type PluginTab = 'extensions' | 'mcp';

interface PluginManagerPageProps {
  mcpMessage: SerializedMcpStatusMessage | null;
  loadMcpMessage: () => Promise<void>;
  onClose: () => void;
  initialFocusRef?: Ref<HTMLButtonElement>;
}

export function PluginManagerPage({
  mcpMessage,
  loadMcpMessage,
  onClose,
  initialFocusRef,
}: PluginManagerPageProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<PluginTab>('extensions');
  const [detailOpen, setDetailOpen] = useState(false);
  const [pageRevision, setPageRevision] = useState(0);
  const [mcpLoaded, setMcpLoaded] = useState(false);

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
      setMcpLoaded(false);
      void loadMcpMessage()
        .then(() => setMcpLoaded(true))
        .catch(() => undefined);
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
        ) : mcpMessage && mcpLoaded ? (
          <McpManagerPage
            key={`mcp-${pageRevision}`}
            message={mcpMessage}
            onClose={onClose}
            embedded={embedded}
          />
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
