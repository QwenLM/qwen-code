import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrainIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react';
import {
  useWorkspaceActions,
  type DaemonWorkspaceSettingsStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  createCloudMemoryClient,
  type CloudMemoryItem,
  type CloudMemoryRecallPreference,
} from '../../cloud-memory';
import {
  CLOUD_MEMORY_IMPORT_LIMITS,
  parseCloudMemoryImport,
} from '../../cloud-memory-import';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription } from '../ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Textarea } from '../ui/textarea';

interface CloudMemoryPanelProps {
  onOpenSettings?: () => void;
}

interface CloudMemorySettings {
  enabled: boolean;
  recallPreference: CloudMemoryRecallPreference;
}

function effectiveSetting(
  status: DaemonWorkspaceSettingsStatus,
  key: string,
): unknown {
  return status.settings.find((setting) => setting.key === key)?.values
    .effective;
}

function localCloudMemorySettings(
  status: DaemonWorkspaceSettingsStatus,
): CloudMemorySettings {
  const preference = effectiveSetting(status, 'memory.cloudRecallPreference');
  return {
    enabled: effectiveSetting(status, 'memory.cloudEnabled') === true,
    recallPreference:
      preference === 'precise' || preference === 'rich'
        ? preference
        : 'balanced',
  };
}

function timestamp(item: CloudMemoryItem): string {
  const value = item.updatedAt ?? item.createdAt;
  if (!value) return '—';
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(millis).toLocaleString();
}

export function CloudMemoryPanel({ onOpenSettings }: CloudMemoryPanelProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();
  const client = useMemo(
    () => createCloudMemoryClient(actions.invokeCloudMemory),
    [actions.invokeCloudMemory],
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const [configured, setConfigured] = useState<boolean>();
  const [settings, setSettings] = useState<CloudMemorySettings>();
  const [items, setItems] = useState<CloudMemoryItem[]>([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [tokens, setTokens] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const [nextToken, setNextToken] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [detail, setDetail] = useState<CloudMemoryItem>();
  const [deleting, setDeleting] = useState<CloudMemoryItem>();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(0);
      setTokens([undefined]);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadPage = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(undefined);
    try {
      const status = await actions.loadCloudMemoryStatus();
      if (id !== requestId.current) return;
      setConfigured(status.configured);
      if (!status.configured) {
        setItems([]);
        return;
      }
      const [settingsStatus, result] = await Promise.all([
        actions.loadSettingsStatus(),
        debouncedQuery
          ? client
              .search(debouncedQuery)
              .then((memories) => ({ memories, nextToken: undefined }))
          : client.list(tokens[page]),
      ]);
      if (id !== requestId.current) return;
      setSettings(localCloudMemorySettings(settingsStatus));
      setItems(result.memories);
      setNextToken(result.nextToken);
    } catch (caught) {
      if (id === requestId.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [actions, client, debouncedQuery, page, tokens]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const updateSettings = async (
    patch: Partial<{
      enabled: boolean;
      recallPreference: CloudMemoryRecallPreference;
    }>,
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      if (patch.enabled !== undefined) {
        await actions.setWorkspaceSetting(
          'user',
          'memory.cloudEnabled',
          patch.enabled,
        );
      }
      if (patch.recallPreference !== undefined) {
        await actions.setWorkspaceSetting(
          'user',
          'memory.cloudRecallPreference',
          patch.recallPreference,
        );
      }
      setSettings((current) => ({
        enabled: patch.enabled ?? current?.enabled ?? false,
        recallPreference:
          patch.recallPreference ?? current?.recallPreference ?? 'balanced',
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const addMemory = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.capture(draft.trim(), 'verbatim');
      setDraft('');
      setAddOpen(false);
      setNotice(t('memory.cloud.added'));
      await loadPage();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    if (files.length > CLOUD_MEMORY_IMPORT_LIMITS.files) {
      setError(t('memory.cloud.importTooMany'));
      return;
    }
    setBusy(true);
    setError(undefined);
    let imported = 0;
    try {
      for (const file of Array.from(files)) {
        if (file.size > CLOUD_MEMORY_IMPORT_LIMITS.fileBytes) {
          throw new Error(
            t('memory.cloud.importTooLarge', { name: file.name }),
          );
        }
        const segments = parseCloudMemoryImport(file.name, await file.text());
        for (const segment of segments) {
          await client.capture(segment, 'extract');
          imported += 1;
        }
      }
      setNotice(t('memory.cloud.imported', { count: imported }));
      await loadPage();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const removeMemory = async () => {
    if (!deleting) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.remove(deleting.memoryId);
      setDeleting(undefined);
      setNotice(t('memory.cloud.deleted'));
      await loadPage();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (configured === false && !loading) {
    return (
      <Empty className="min-h-80 rounded-lg border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BrainIcon />
          </EmptyMedia>
          <EmptyTitle>{t('memory.cloud.setupTitle')}</EmptyTitle>
          <EmptyDescription>
            {t('memory.cloud.setupDescription')}
          </EmptyDescription>
        </EmptyHeader>
        {onOpenSettings && (
          <Button type="button" onClick={onOpenSettings}>
            {t('memory.cloud.openSettings')}
          </Button>
        )}
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {(error || notice) && (
        <Alert variant={error ? 'destructive' : 'default'}>
          <AlertDescription>{error ?? notice}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            className="pl-9"
            placeholder={t('memory.cloud.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          value={settings?.recallPreference ?? 'balanced'}
          disabled={busy || loading || !settings}
          onValueChange={(value) =>
            void updateSettings({
              recallPreference: value as CloudMemoryRecallPreference,
            })
          }
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="precise">{t('memory.cloud.precise')}</SelectItem>
            <SelectItem value="balanced">
              {t('memory.cloud.balanced')}
            </SelectItem>
            <SelectItem value="rich">{t('memory.cloud.rich')}</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 rounded-md border px-3 py-2">
          <span className="text-sm">{t('memory.cloud.enabled')}</span>
          <Switch
            checked={settings?.enabled ?? false}
            disabled={busy || loading || !settings}
            onCheckedChange={(enabled) => void updateSettings({ enabled })}
          />
        </div>
        <input
          ref={fileInput}
          hidden
          multiple
          type="file"
          accept=".json,.jsonl,.md,.txt"
          onChange={(event) => void importFiles(event.target.files)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || !settings?.enabled}
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon />
          {t('memory.cloud.import')}
        </Button>
        <Button
          type="button"
          disabled={busy || !settings?.enabled}
          onClick={() => setAddOpen(true)}
        >
          <PlusIcon />
          {t('memory.cloud.add')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        {loading ? (
          <div className="flex min-h-60 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t('memory.loading')}
          </div>
        ) : items.length === 0 ? (
          <Empty className="min-h-60">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BrainIcon />
              </EmptyMedia>
              <EmptyTitle>{t('memory.cloud.emptyTitle')}</EmptyTitle>
              <EmptyDescription>
                {t('memory.cloud.emptyDescription')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('memory.cloud.content')}</TableHead>
                <TableHead className="w-32">
                  {t('memory.cloud.source')}
                </TableHead>
                <TableHead className="w-44">
                  {t('memory.cloud.updated')}
                </TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((memory) => (
                <TableRow key={memory.memoryId}>
                  <TableCell className="max-w-0">
                    <button
                      type="button"
                      className="block w-full truncate text-left hover:underline"
                      disabled={busy}
                      onClick={() => setDetail(memory)}
                    >
                      {memory.content}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{memory.source ?? '—'}</Badge>
                  </TableCell>
                  <TableCell>{timestamp(memory)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('memory.cloud.delete')}
                      onClick={() => setDeleting(memory)}
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {!debouncedQuery && (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page === 0 || loading}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            <ChevronLeftIcon /> {t('memory.cloud.previous')}
          </Button>
          <span className="text-sm tabular-nums text-muted-foreground">
            {page + 1}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!nextToken || loading}
            onClick={() => {
              if (!nextToken) return;
              setTokens((current) => [
                ...current.slice(0, page + 1),
                nextToken,
              ]);
              setPage((value) => value + 1);
            }}
          >
            {t('memory.cloud.next')} <ChevronRightIcon />
          </Button>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memory.cloud.add')}</DialogTitle>
            <DialogDescription>
              {t('memory.cloud.addDescription')}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            className="min-h-40"
            maxLength={CLOUD_MEMORY_IMPORT_LIMITS.segmentCharacters}
            placeholder={t('memory.cloud.addPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={busy || !settings?.enabled || !draft.trim()}
              onClick={() => void addMemory()}
            >
              {t('memory.cloud.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!detail}
        onOpenChange={(open) => !open && setDetail(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memory.cloud.detail')}</DialogTitle>
            <DialogDescription>{detail?.memoryId}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-sm">
            {detail?.content}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('memory.cloud.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('memory.cloud.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void removeMemory()}
            >
              {t('memory.cloud.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
