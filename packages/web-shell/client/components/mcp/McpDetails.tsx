import type { ReactNode } from 'react';
import { AlertCircleIcon, ServerIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Card, CardDescription, CardHeader, CardTitle } from '../ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';

export function McpDetailField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm font-medium">{label}</div>
      <div className="break-words text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

export function McpToolDetail({
  tool,
}: {
  tool: {
    description?: string;
    schema?: unknown;
    annotations?: Record<string, unknown>;
    isValid?: boolean;
    invalidReason?: string;
  };
}) {
  const { t } = useI18n();
  const annotations = [
    ['destructiveHint', 'mcp.annotation.destructive'],
    ['readOnlyHint', 'mcp.annotation.readOnly'],
    ['openWorldHint', 'mcp.annotation.openWorld'],
    ['idempotentHint', 'mcp.annotation.idempotent'],
  ]
    .filter(([hint]) => tool.annotations?.[hint])
    .map(([, label]) => t(label))
    .join(', ');
  const schema = tool.schema as
    | { parametersJsonSchema?: unknown; parameters?: unknown }
    | undefined;
  const schemaContent =
    schema?.parametersJsonSchema ?? schema?.parameters ?? schema;
  return (
    <div className="flex flex-col gap-5">
      {tool.isValid === false ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t('mcp.invalidToolWarning')}</AlertTitle>
          <AlertDescription>
            {tool.invalidReason || t('mcp.status.unknown')}
            <span className="mt-1 block">{t('mcp.invalidToolHelp')}</span>
          </AlertDescription>
        </Alert>
      ) : null}
      <McpDetailField
        label={t('mcp.description')}
        value={tool.description?.trim() || t('mcp.noDescription')}
      />
      {annotations ? (
        <McpDetailField label={t('mcp.annotations')} value={annotations} />
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">{t('mcp.inputSchema')}</div>
        {schemaContent ? (
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
            {JSON.stringify(schemaContent, null, 2)}
          </pre>
        ) : (
          <div className="text-sm text-muted-foreground">
            {t('mcp.noSchema')}
          </div>
        )}
      </div>
    </div>
  );
}

export function McpResourceDetail({
  resource,
}: {
  resource: {
    uri: string;
    name?: string;
    title?: string;
    mimeType?: string;
    size?: number;
    description?: string;
  };
}) {
  const { t } = useI18n();
  const friendlyName = resource.title || resource.name || '';
  return (
    <div className="flex flex-col gap-5">
      <McpDetailField label={t('mcp.resource.uriLabel')} value={resource.uri} />
      {friendlyName && friendlyName !== resource.uri ? (
        <McpDetailField
          label={t('mcp.resource.nameLabel')}
          value={friendlyName}
        />
      ) : null}
      {resource.mimeType ? (
        <McpDetailField
          label={t('mcp.resource.mimeTypeLabel')}
          value={resource.mimeType}
        />
      ) : null}
      {typeof resource.size === 'number' ? (
        <McpDetailField
          label={t('mcp.resource.sizeLabel')}
          value={t('mcp.resource.bytes', { count: resource.size })}
        />
      ) : null}
      {resource.description ? (
        <McpDetailField
          label={t('mcp.description')}
          value={resource.description.trim()}
        />
      ) : null}
    </div>
  );
}

export function McpServerCard({
  name,
  description,
  status,
  onOpen,
}: {
  name: string;
  description?: string;
  status: ReactNode;
  onOpen: () => void;
}) {
  return (
    <Card
      size="sm"
      role="button"
      tabIndex={0}
      aria-label={name}
      className="min-w-0 cursor-pointer transition-colors hover:bg-accent/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <CardHeader className="block">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ServerIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <CardTitle className="min-w-0 flex-1 truncate">{name}</CardTitle>
              {status}
            </div>
            <CardDescription className="mt-1 min-w-0 text-xs">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="block truncate">
                      {description?.trim() || '-'}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{description?.trim() || '-'}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </CardDescription>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}
