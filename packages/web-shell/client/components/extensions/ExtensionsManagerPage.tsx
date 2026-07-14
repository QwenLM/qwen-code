import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  BotIcon,
  BoxIcon,
  CommandIcon,
  EllipsisVerticalIcon,
  FileTextIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
} from 'lucide-react';
import {
  DaemonHttpError,
  type DaemonExtensionEntry,
  type DaemonExtensionUpdateState,
  type ExtensionInteractionResponse,
  type ExtensionPendingInteraction,
} from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useWorkspaceActions,
  useWorkspaceEventSignals,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { trimDialogLabel } from '../../utils/dialogLabels';
import styles from './ExtensionsManagerPage.module.css';
import {
  filterExtensions,
  preserveSelectedExtensionName,
} from './extensions-manager-logic';
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';
import { Button } from '../ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import { Input } from '../ui/input';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { Separator } from '../ui/separator';
import { Spinner } from '../ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
type Scope = 'user' | 'workspace';
type Mutation = 'enable' | 'disable';
type T = ReturnType<typeof useI18n>['t'];
type PendingInteractionState = {
  operationId: string;
  interaction: ExtensionPendingInteraction;
  owner: 'install' | 'mutation';
};

const UPDATE_AVAILABLE: DaemonExtensionUpdateState = 'update available';

interface ExtensionsManagerPageProps {
  onClose: () => void;
  backButtonRef?: Ref<HTMLButtonElement>;
}

function extensionTitle(extension: DaemonExtensionEntry): string {
  return extension.displayName || extension.name;
}

function statusLabel(extension: DaemonExtensionEntry, t: T): string {
  return extension.isActive
    ? t('extensions.manage.status.enabled')
    : t('extensions.manage.status.disabled');
}

function updateLabel(
  state: DaemonExtensionUpdateState | undefined,
  t: T,
): string {
  switch (state) {
    case 'update available':
      return t('extensions.manage.updateAvailable');
    case 'up to date':
      return t('extensions.manage.upToDate');
    case 'not updatable':
      return t('extensions.manage.notUpdatable');
    case 'checking for updates':
      return t('extensions.manage.checkingUpdates');
    case 'updating':
      return t('extensions.manage.updating');
    case 'updated':
      return t('extensions.manage.updateComplete');
    case 'updated, needs restart':
      return t('extensions.manage.restartRequired');
    case 'error':
      return t('extensions.manage.updateError');
    case 'unknown':
    case undefined:
      return t('extensions.manage.unknownUpdate');
  }
}

function mutationMessage(operation: string, name: string, t: T): string {
  switch (operation) {
    case 'enable':
      return t('extensions.manage.enabling', { name });
    case 'disable':
      return t('extensions.manage.disabling', { name });
    case 'uninstall':
      return t('extensions.manage.uninstalling', { name });
    case 'update':
      return t('extensions.manage.updatingExtension', { name });
    default:
      return t('extensions.manage.queued', { name });
  }
}

function mutationSuccessMessage(operation: string, name: string, t: T): string {
  switch (operation) {
    case 'enable':
      return t('extensions.manage.enabled', { name });
    case 'disable':
      return t('extensions.manage.disabled', { name });
    case 'uninstall':
      return t('extensions.manage.uninstalled', { name });
    case 'update':
      return t('extensions.manage.updated', { name });
    default:
      return t('extensions.manage.queued', { name });
  }
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-sm font-medium">{trimDialogLabel(label)}</div>
      <div className="break-words text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

function CapabilityList({
  items,
  empty,
  icon: Icon,
}: {
  items: string[];
  empty: string;
  icon: typeof CommandIcon;
}) {
  if (!items.length) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle>{empty}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Card>
      <CardContent className="flex flex-col">
        {items.map((item, index) => (
          <div key={item}>
            {index > 0 ? <Separator /> : null}
            <div className="flex min-w-0 items-center gap-3 py-3 [contain-intrinsic-size:auto_44px] [content-visibility:auto]">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 break-words">{item}</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ExtensionInteractionDialog({
  pendingInteraction,
  submitting,
  selectedPlugin,
  interactionValue,
  setSelectedPlugin,
  setInteractionValue,
  submit,
  t,
}: {
  pendingInteraction: PendingInteractionState | null;
  submitting: boolean;
  selectedPlugin: string;
  interactionValue: string;
  setSelectedPlugin: (value: string) => void;
  setInteractionValue: (value: string) => void;
  submit: (response: ExtensionInteractionResponse) => void;
  t: T;
}) {
  return (
    <Dialog
      open={Boolean(pendingInteraction)}
      onOpenChange={(open) => {
        if (!open && pendingInteraction && !submitting) {
          submit({ cancelled: true });
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader className="items-start px-3 text-left">
          <DialogTitle>
            {pendingInteraction?.interaction.kind === 'setting'
              ? pendingInteraction.interaction.setting.name
              : t('extensions.manage.selectExtension')}
          </DialogTitle>
          <DialogDescription>
            {pendingInteraction?.interaction.kind === 'marketplace_plugin'
              ? t('extensions.manage.installSelectPluginDescription', {
                  marketplace: pendingInteraction.interaction.marketplace.name,
                })
              : pendingInteraction?.interaction.setting.description}
          </DialogDescription>
        </DialogHeader>
        {pendingInteraction?.interaction.kind === 'marketplace_plugin' ? (
          <RadioGroup
            aria-label={t('extensions.manage.selectExtension')}
            value={selectedPlugin}
            onValueChange={setSelectedPlugin}
            className="flex flex-col gap-2 px-3"
          >
            {pendingInteraction.interaction.plugins.map((plugin) => {
              const id = `marketplace-plugin-${plugin.name}`;
              return (
                <div
                  key={plugin.name}
                  className="flex items-start gap-3 rounded-md border border-border p-3 has-data-[state=checked]:bg-accent/50"
                >
                  <RadioGroupItem
                    id={id}
                    value={plugin.name}
                    disabled={submitting}
                    className="mt-0.5"
                  />
                  <label
                    htmlFor={id}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1"
                  >
                    <span className="font-medium">{plugin.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {plugin.description ??
                        plugin.category ??
                        (plugin.source === '.' || plugin.source === './'
                          ? t('extensions.manage.marketplaceRoot')
                          : plugin.source) ??
                        t('extensions.manage.noDescription')}
                    </span>
                    {plugin.tags?.length ? (
                      <span className="text-xs text-muted-foreground">
                        {plugin.tags.join(' · ')}
                      </span>
                    ) : null}
                  </label>
                </div>
              );
            })}
          </RadioGroup>
        ) : null}
        {pendingInteraction?.interaction.kind === 'marketplace_plugin' ? (
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => submit({ cancelled: true })}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={submitting || !selectedPlugin}
              onClick={() => submit({ pluginName: selectedPlugin })}
            >
              {submitting ? <Spinner /> : null}
              {pendingInteraction.owner === 'mutation'
                ? t('extensions.manage.update')
                : t('extensions.manage.install')}
            </Button>
          </DialogFooter>
        ) : pendingInteraction?.interaction.kind === 'setting' ? (
          <>
            <Input
              autoComplete="off"
              aria-label={pendingInteraction.interaction.setting.name}
              type={
                pendingInteraction.interaction.setting.sensitive
                  ? 'password'
                  : 'text'
              }
              value={interactionValue}
              onChange={(event) => setInteractionValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !submitting) {
                  event.preventDefault();
                  submit({ value: interactionValue });
                }
              }}
            />
            <DialogFooter>
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => submit({ cancelled: true })}
              >
                {t('common.cancel')}
              </Button>
              <Button
                disabled={submitting}
                onClick={() => submit({ value: interactionValue })}
              >
                {submitting ? <Spinner /> : null}
                {pendingInteraction.owner === 'mutation'
                  ? t('extensions.manage.update')
                  : t('extensions.manage.install')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ExtensionsManagerPage({
  onClose,
  backButtonRef,
}: ExtensionsManagerPageProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useWorkspaceActions();
  const signals = useWorkspaceEventSignals();
  const [extensions, setExtensions] = useState<DaemonExtensionEntry[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [updateStates, setUpdateStates] = useState<
    Record<string, DaemonExtensionUpdateState>
  >({});
  const [loading, setLoading] = useState(false);
  const [checkingName, setCheckingName] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [uninstallName, setUninstallName] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installSource, setInstallSource] = useState('');
  const [installing, setInstalling] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<{
    operationId: string;
    source: string;
  } | null>(null);
  const [pendingInteraction, setPendingInteraction] =
    useState<PendingInteractionState | null>(null);
  const interactionIdRef = useRef<string | null>(null);
  const [interactionValue, setInteractionValue] = useState('');
  const [selectedPlugin, setSelectedPlugin] = useState('');
  const [submittingInteraction, setSubmittingInteraction] = useState(false);
  const [operationsRecovered, setOperationsRecovered] = useState(false);
  const mutationInFlightRef = useRef(false);
  const interactionOperationIdRef = useRef<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const returnFocusNameRef = useRef<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<{
    operationId: string;
    name: string;
    suppressMessage?: boolean;
  } | null>(null);

  const clearInteraction = useCallback((operationId?: string) => {
    if (operationId && interactionOperationIdRef.current !== operationId) {
      return;
    }
    interactionOperationIdRef.current = null;
    interactionIdRef.current = null;
    setPendingInteraction(null);
    setInteractionValue('');
    setSelectedPlugin('');
  }, []);

  const showInteraction = useCallback(
    (
      operationId: string,
      interaction: ExtensionPendingInteraction,
      owner: 'install' | 'mutation',
    ) => {
      if (interactionIdRef.current !== interaction.id) {
        setInteractionValue('');
        setSelectedPlugin('');
        interactionIdRef.current = interaction.id;
      }
      interactionOperationIdRef.current = operationId;
      setPendingInteraction({ operationId, interaction, owner });
    },
    [],
  );

  const load = useCallback(
    (preserveMessage = false) => {
      setLoading(true);
      return actions
        .loadExtensionsStatus()
        .then((status) => {
          const nextExtensions = status.extensions ?? [];
          setExtensions(nextExtensions);
          if (!preserveMessage) {
            setMessage(status.errors?.[0]?.error ?? null);
          }
          setSelectedName((name) =>
            preserveSelectedExtensionName(name, nextExtensions),
          );
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setLoading(false));
    },
    [actions],
  );

  const checkAllUpdates = useCallback(() => {
    return actions
      .checkExtensionUpdates(connection.clientId)
      .then((result) => setUpdateStates(result.states))
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
  }, [actions, connection.clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 2000;
    const recover = async () => {
      try {
        const { operations } = await actions.activeExtensionOperations();
        if (cancelled) return;
        const activeInstall = operations.find(
          (operation) => operation.operation === 'install',
        );
        if (activeInstall) {
          setPendingInstall(
            (current) =>
              current ?? {
                operationId: activeInstall.operationId,
                source:
                  activeInstall.source ?? activeInstall.name ?? 'extension',
              },
          );
        }
        const activeMutation = operations.find(
          (operation) => operation.operation !== 'install',
        );
        if (activeMutation) {
          mutationInFlightRef.current = true;
          setPendingMutation(
            (current) =>
              current ?? {
                operationId: activeMutation.operationId,
                name: activeMutation.name ?? 'extension',
              },
          );
          setBusyName((current) => current ?? activeMutation.name ?? null);
        }
        setRecoveryError(null);
        setOperationsRecovered(true);
      } catch (error) {
        if (!cancelled) {
          setRecoveryError(
            error instanceof Error ? error.message : String(error),
          );
          timer = setTimeout(() => void recover(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      }
    };
    void recover();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [actions]);

  const extensionsVersionRef = useRef(signals?.extensionsVersion ?? 0);
  useEffect(() => {
    const version = signals?.extensionsVersion ?? 0;
    if (version !== extensionsVersionRef.current) {
      extensionsVersionRef.current = version;
      setUpdateStates({});
      void load(true);
    }
  }, [load, signals?.extensionsVersion]);

  useEffect(() => {
    if (extensions.length === 0) return;
    void checkAllUpdates();
  }, [checkAllUpdates, extensions]);

  useEffect(() => {
    if (!pendingInstall) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    const poll = async () => {
      try {
        const operation = await actions.extensionOperationStatus(
          pendingInstall.operationId,
        );
        if (cancelled) return;
        retryDelay = 1000;
        if (operation.status === 'waiting_for_input') {
          if (operation.interaction) {
            showInteraction(
              operation.operationId,
              operation.interaction,
              'install',
            );
            timer = setTimeout(() => void poll(), 5000);
          } else {
            setMessage(t('extensions.manage.operationFailed'));
            clearInteraction(pendingInstall.operationId);
            setPendingInstall(null);
          }
          return;
        }
        if (operation.status === 'failed') {
          setMessage(
            t('extensions.install.failed', {
              source: pendingInstall.source,
              error: operation.error ?? '',
            }),
          );
          clearInteraction(pendingInstall.operationId);
          setPendingInstall(null);
          return;
        }
        if (
          operation.status === 'succeeded' ||
          operation.status === 'succeeded_with_refresh_error'
        ) {
          setMessage(
            operation.status === 'succeeded_with_refresh_error'
              ? t('extensions.manage.refreshFailed', {
                  error: operation.result?.error ?? '',
                })
              : t('extensions.install.installed', {
                  name: operation.result?.name ?? pendingInstall.source,
                }),
          );
          clearInteraction(pendingInstall.operationId);
          setPendingInstall(null);
          void load(true);
          return;
        }
        setMessage(
          t('extensions.install.started', {
            source: pendingInstall.source,
          }),
        );
        timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : String(error));
        if (error instanceof DaemonHttpError && error.status === 404) {
          clearInteraction(pendingInstall.operationId);
          setPendingInstall(null);
          return;
        }
        timer = setTimeout(() => void poll(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [actions, clearInteraction, load, pendingInstall, showInteraction, t]);

  const submitInteraction = useCallback(
    (response: ExtensionInteractionResponse) => {
      if (!pendingInteraction) return;
      const owner = pendingInteraction.owner;
      const restartPolling = () => {
        if (owner === 'install') {
          setPendingInstall((current) => (current ? { ...current } : current));
        } else {
          setPendingMutation((current) => (current ? { ...current } : current));
        }
      };
      setSubmittingInteraction(true);
      actions
        .respondToExtensionInteraction(
          pendingInteraction.operationId,
          pendingInteraction.interaction.id,
          response,
          connection.clientId,
        )
        .then(() => {
          clearInteraction(pendingInteraction.operationId);
          restartPolling();
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
          clearInteraction(pendingInteraction.operationId);
          restartPolling();
        })
        .finally(() => setSubmittingInteraction(false));
    },
    [actions, clearInteraction, connection.clientId, pendingInteraction],
  );

  useEffect(() => {
    if (!pendingMutation) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    const poll = async () => {
      try {
        const operation = await actions.extensionOperationStatus(
          pendingMutation.operationId,
        );
        if (cancelled) return;
        retryDelay = 1000;
        if (operation.status === 'waiting_for_input') {
          if (operation.interaction) {
            showInteraction(
              operation.operationId,
              operation.interaction,
              'mutation',
            );
            timer = setTimeout(() => void poll(), 5000);
          } else {
            setMessage(t('extensions.manage.operationFailed'));
            clearInteraction(pendingMutation.operationId);
            setPendingMutation(null);
            setBusyName(null);
            mutationInFlightRef.current = false;
          }
          return;
        }
        if (operation.status === 'failed') {
          setMessage(operation.error ?? t('extensions.manage.operationFailed'));
          clearInteraction(pendingMutation.operationId);
          setPendingMutation(null);
          setBusyName(null);
          mutationInFlightRef.current = false;
          return;
        }
        if (
          operation.status === 'succeeded' ||
          operation.status === 'succeeded_with_refresh_error'
        ) {
          if (operation.status === 'succeeded_with_refresh_error') {
            setMessage(
              t('extensions.manage.refreshFailed', {
                error: operation.result?.error ?? '',
              }),
            );
          } else if (!pendingMutation.suppressMessage) {
            setMessage(
              mutationSuccessMessage(
                operation.operation,
                pendingMutation.name,
                t,
              ),
            );
          }
          clearInteraction(pendingMutation.operationId);
          setPendingMutation(null);
          setBusyName(null);
          mutationInFlightRef.current = false;
          if (operation.operation === 'uninstall') {
            setSelectedName(null);
          }
          if (operation.operation === 'update') {
            setUpdateStates((current) => {
              const next = { ...current };
              delete next[pendingMutation.name];
              return next;
            });
          }
          void load(true);
          return;
        }
        if (!pendingMutation.suppressMessage) {
          setMessage(
            mutationMessage(operation.operation, pendingMutation.name, t),
          );
        }
        timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : String(error));
        if (error instanceof DaemonHttpError && error.status === 404) {
          clearInteraction(pendingMutation.operationId);
          setPendingMutation(null);
          setBusyName(null);
          mutationInFlightRef.current = false;
          return;
        }
        timer = setTimeout(() => void poll(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [actions, clearInteraction, load, pendingMutation, showInteraction, t]);

  const refreshList = useCallback(() => {
    setMessage(null);
    void load();
  }, [load]);

  const checkUpdates = useCallback(
    (name: string) => {
      setCheckingName(name);
      setMessage(null);
      setUpdateStates((current) => ({
        ...current,
        [name]: 'checking for updates',
      }));
      actions
        .checkExtensionUpdates(connection.clientId)
        .then((result) => {
          setUpdateStates(result.states);
          setMessage(updateLabel(result.states[name], t));
        })
        .catch((error: unknown) => {
          setUpdateStates((current) => ({ ...current, [name]: 'error' }));
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setCheckingName(null));
    },
    [actions, connection.clientId, t],
  );

  const installExtension = useCallback(() => {
    const source = installSource.trim();
    const clientId = connection.clientId;
    if (
      !source ||
      !operationsRecovered ||
      pendingInstall ||
      pendingMutation ||
      mutationInFlightRef.current
    )
      return;
    setInstalling(true);
    setMessage(null);
    actions
      .installExtension({ source, consent: true }, clientId)
      .then((result) => {
        setPendingInstall({ operationId: result.operationId, source });
        setInstallSource('');
        setInstallOpen(false);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setInstalling(false));
  }, [
    actions,
    connection.clientId,
    installSource,
    operationsRecovered,
    pendingInstall,
    pendingMutation,
  ]);

  const runMutation = useCallback(
    (
      name: string,
      run: (clientId?: string) => Promise<unknown>,
      options: { suppressMessage?: boolean } = {},
    ): boolean => {
      const clientId = connection.clientId;
      if (
        !operationsRecovered ||
        pendingInstall ||
        pendingMutation ||
        mutationInFlightRef.current
      ) {
        return false;
      }
      mutationInFlightRef.current = true;
      setBusyName(name);
      setMessage(null);
      let startedPolling = false;
      run(clientId)
        .then((result) => {
          const operationId =
            result &&
            typeof result === 'object' &&
            'operationId' in result &&
            typeof result.operationId === 'string'
              ? result.operationId
              : undefined;
          if (operationId) {
            startedPolling = true;
            setPendingMutation({
              operationId,
              name,
              suppressMessage: options.suppressMessage,
            });
            return;
          }
          if (!options.suppressMessage) {
            setMessage(t('extensions.manage.queued', { name }));
          }
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!startedPolling) {
            mutationInFlightRef.current = false;
            setBusyName(null);
            void load(true);
          }
        });
      return true;
    },
    [
      connection.clientId,
      load,
      operationsRecovered,
      pendingInstall,
      pendingMutation,
      t,
    ],
  );

  const selectedExtension = useMemo(
    () => extensions.find((extension) => extension.name === selectedName),
    [extensions, selectedName],
  );

  const filteredExtensions = useMemo(
    () => filterExtensions(extensions, query),
    [extensions, query],
  );

  const returnToList = useCallback(() => {
    returnFocusNameRef.current = selectedName;
    setSelectedName(null);
  }, [selectedName]);

  useEffect(() => {
    if (selectedName || !returnFocusNameRef.current) return;
    cardRefs.current.get(returnFocusNameRef.current)?.focus();
    returnFocusNameRef.current = null;
  }, [selectedName]);

  const standaloneNavigation = (
    <Breadcrumb className="sticky -top-4 z-10 -mx-5 -mt-4 border-b bg-background px-5 py-3">
      <BreadcrumbList className="text-base">
        <BreadcrumbItem>
          <Button
            ref={backButtonRef}
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t('common.back')}
          >
            <ArrowLeftIcon />
          </Button>
        </BreadcrumbItem>
        <BreadcrumbItem>
          {selectedExtension ? (
            <BreadcrumbLink asChild>
              <button type="button" onClick={returnToList}>
                {t('extensions.manage.title')}
              </button>
            </BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{t('extensions.manage.title')}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {selectedExtension ? <BreadcrumbSeparator /> : null}
        {selectedExtension ? (
          <BreadcrumbItem>
            <BreadcrumbPage>{extensionTitle(selectedExtension)}</BreadcrumbPage>
          </BreadcrumbItem>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
  const navigation = standaloneNavigation;

  if (selectedExtension) {
    const details = selectedExtension.details;
    const updateState =
      updateStates[selectedExtension.name] ?? selectedExtension.updateState;
    const busy =
      !operationsRecovered ||
      pendingInstall !== null ||
      busyName !== null ||
      pendingMutation !== null;
    const checking = checkingName === selectedExtension.name;
    const mutation: Mutation = selectedExtension.isActive
      ? 'disable'
      : 'enable';
    const toggleScope = (scope: Scope) =>
      runMutation(
        selectedExtension.name,
        (clientId) =>
          mutation === 'enable'
            ? actions.enableExtension(
                selectedExtension.name,
                { scope },
                clientId,
              )
            : actions.disableExtension(
                selectedExtension.name,
                { scope },
                clientId,
              ),
        { suppressMessage: true },
      );
    const commands = details?.commands ?? [];
    const skills = details?.skills ?? [];
    const agents = details?.agents ?? [];
    const mcpServers = details?.mcpServers ?? [];
    const contextFiles = details?.contextFiles ?? [];

    return (
      <div className="flex w-full flex-col gap-6 pb-8">
        {navigation}
        <div className="flex w-full flex-col gap-6">
          <div className="flex items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted">
              <PackageIcon />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="break-words text-2xl font-semibold">
                  {extensionTitle(selectedExtension)}
                </h1>
                <Badge variant="outline">v{selectedExtension.version}</Badge>
                <Badge
                  variant="secondary"
                  className={
                    selectedExtension.isActive
                      ? 'bg-[var(--success-bg)] text-[var(--success-color)]'
                      : undefined
                  }
                >
                  {statusLabel(selectedExtension, t)}
                </Badge>
              </div>
              {selectedExtension.description ? (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p
                        className="mt-1 line-clamp-2 text-sm text-muted-foreground"
                        tabIndex={0}
                      >
                        {selectedExtension.description}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm whitespace-normal">
                      {selectedExtension.description}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
            <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('extensions.manage.actions')}
                >
                  {busy || checking ? <Spinner /> : <EllipsisVerticalIcon />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={busy || checkingName !== null}
                    onSelect={() => checkUpdates(selectedExtension.name)}
                  >
                    {t('extensions.manage.checkUpdates')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={
                      busy || checking || updateState !== UPDATE_AVAILABLE
                    }
                    onSelect={() =>
                      runMutation(selectedExtension.name, (clientId) =>
                        actions.updateExtension(
                          selectedExtension.name,
                          clientId,
                        ),
                      )
                    }
                  >
                    {t('extensions.manage.update')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() => toggleScope('user')}
                  >
                    {mutation === 'enable'
                      ? t('extensions.manage.enable')
                      : t('extensions.manage.disable')}
                    · {t('settings.scope.user')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() => toggleScope('workspace')}
                  >
                    {mutation === 'enable'
                      ? t('extensions.manage.enable')
                      : t('extensions.manage.disable')}
                    · {t('settings.scope.workspace')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={busy}
                    onSelect={(event) => {
                      event.preventDefault();
                      setActionsOpen(false);
                      setUninstallName(selectedExtension.name);
                    }}
                  >
                    {t('extensions.manage.uninstallAction')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {message || recoveryError ? (
            <Alert>
              <AlertCircleIcon />
              <AlertDescription className="break-words">
                {message ?? recoveryError}
              </AlertDescription>
            </Alert>
          ) : null}

          <Tabs defaultValue="overview">
            <TabsList className="max-w-full overflow-x-auto">
              <TabsTrigger value="overview">
                {t('extensions.manage.overview')}
              </TabsTrigger>
              <TabsTrigger value="commands">
                {trimDialogLabel(t('extensions.manage.commands'))}{' '}
                {commands.length}
              </TabsTrigger>
              <TabsTrigger value="skills">
                {trimDialogLabel(t('extensions.manage.skills'))} {skills.length}
              </TabsTrigger>
              <TabsTrigger value="agents">
                {trimDialogLabel(t('extensions.manage.agents'))} {agents.length}
              </TabsTrigger>
              <TabsTrigger value="mcp">
                {trimDialogLabel(t('extensions.manage.mcpServers'))}{' '}
                {mcpServers.length}
              </TabsTrigger>
              <TabsTrigger value="context">
                {trimDialogLabel(t('extensions.manage.contextFiles'))}{' '}
                {contextFiles.length}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="pt-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t('extensions.manage.overview')}</CardTitle>
                  {selectedExtension.description ? (
                    <CardDescription>
                      {selectedExtension.description}
                    </CardDescription>
                  ) : null}
                </CardHeader>
                <CardContent className="grid gap-6 sm:grid-cols-2">
                  <DetailField
                    label={t('extensions.manage.name')}
                    value={selectedExtension.name}
                  />
                  <DetailField
                    label={t('extensions.manage.version')}
                    value={selectedExtension.version}
                  />
                  <DetailField
                    label={t('extensions.manage.status')}
                    value={statusLabel(selectedExtension, t)}
                  />
                  <DetailField
                    label={t('extensions.manage.source')}
                    value={selectedExtension.source ?? '-'}
                  />
                  <DetailField
                    label={t('extensions.manage.path')}
                    value={selectedExtension.path}
                  />
                  <DetailField
                    label={t('extensions.manage.updateStatus')}
                    value={updateLabel(updateState, t)}
                  />
                  <DetailField
                    label={t('extensions.manage.installType')}
                    value={selectedExtension.installType ?? '-'}
                  />
                  <DetailField
                    label={t('extensions.manage.origin')}
                    value={selectedExtension.originSource ?? '-'}
                  />
                  <DetailField
                    label={t('extensions.manage.settings')}
                    value={(details?.settings ?? []).join(', ') || '-'}
                  />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="commands" className="pt-4">
              <CapabilityList
                items={commands}
                empty={t('extensions.manage.emptyCommands')}
                icon={CommandIcon}
              />
            </TabsContent>
            <TabsContent value="skills" className="pt-4">
              <CapabilityList
                items={skills}
                empty={t('extensions.manage.emptySkills')}
                icon={SparklesIcon}
              />
            </TabsContent>
            <TabsContent value="agents" className="pt-4">
              <CapabilityList
                items={agents}
                empty={t('extensions.manage.emptyAgents')}
                icon={BotIcon}
              />
            </TabsContent>
            <TabsContent value="mcp" className="pt-4">
              <CapabilityList
                items={mcpServers}
                empty={t('extensions.manage.emptyMcpServers')}
                icon={ServerIcon}
              />
            </TabsContent>
            <TabsContent value="context" className="pt-4">
              <CapabilityList
                items={contextFiles}
                empty={t('extensions.manage.emptyContextFiles')}
                icon={FileTextIcon}
              />
            </TabsContent>
          </Tabs>
        </div>

        <AlertDialog
          open={uninstallName === selectedExtension.name}
          onOpenChange={(open) => {
            if (!open) setUninstallName(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader className="place-items-start text-left">
              <AlertDialogTitle>
                {t('extensions.manage.uninstallAction')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('extensions.manage.uninstallConfirm', {
                  name: selectedExtension.name,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (!uninstallName) return;
                  if (
                    runMutation(uninstallName, (clientId) =>
                      actions.uninstallExtension(uninstallName, clientId),
                    )
                  ) {
                    setUninstallName(null);
                  }
                }}
              >
                {t('extensions.manage.uninstallAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ExtensionInteractionDialog
          pendingInteraction={pendingInteraction}
          submitting={submittingInteraction}
          selectedPlugin={selectedPlugin}
          interactionValue={interactionValue}
          setSelectedPlugin={setSelectedPlugin}
          setInteractionValue={setInteractionValue}
          submit={submitInteraction}
          t={t}
        />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-6 pb-8">
      {navigation}
      <div className="flex w-full flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">
              {t('extensions.manage.title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('extensions.manage.count', { count: extensions.length })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" disabled={loading} onClick={refreshList}>
              {loading ? (
                <Spinner />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              {t('common.refresh')}
            </Button>
            <Button
              disabled={
                !operationsRecovered ||
                Boolean(pendingInstall || pendingMutation || busyName)
              }
              onClick={() => setInstallOpen(true)}
            >
              <PlusIcon data-icon="inline-start" />
              {t('extensions.manage.add')}
            </Button>
          </div>
        </div>

        {message || recoveryError ? (
          <Alert>
            <AlertCircleIcon />
            <AlertDescription className="break-words">
              {message ?? recoveryError}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="extension-search"
            aria-label={t('extensions.manage.search')}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('extensions.manage.search')}
            className="pl-9"
          />
        </div>

        {filteredExtensions.length ? (
          <div
            className={styles.extensionGrid}
            data-column-count={Math.min(filteredExtensions.length, 4)}
          >
            {filteredExtensions.map((extension) => {
              const state =
                updateStates[extension.name] ?? extension.updateState;
              const capabilities = extension.capabilities;
              return (
                <Card
                  key={extension.id || extension.name}
                  ref={(node) => {
                    if (node) cardRefs.current.set(extension.name, node);
                    else cardRefs.current.delete(extension.name);
                  }}
                  size="sm"
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer transition-colors hover:bg-accent/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  onClick={() => setSelectedName(extension.name)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedName(extension.name);
                    }
                  }}
                >
                  <CardHeader className="block">
                    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
                      <div className="row-span-2 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <PackageIcon className="size-5" />
                      </div>
                      <CardTitle className="min-w-0 truncate">
                        {extensionTitle(extension)}
                      </CardTitle>
                      <div className="flex shrink-0 flex-wrap justify-end gap-2">
                        <Badge variant="outline">v{extension.version}</Badge>
                        <Badge
                          variant="secondary"
                          className={
                            extension.isActive
                              ? 'bg-[var(--success-bg)] text-[var(--success-color)]'
                              : undefined
                          }
                        >
                          {statusLabel(extension, t)}
                        </Badge>
                        {state === UPDATE_AVAILABLE ? (
                          <Badge>{updateLabel(state, t)}</Badge>
                        ) : null}
                      </div>
                      <CardDescription className="col-span-2 col-start-2 row-start-2 line-clamp-2">
                        {extension.description ||
                          t('extensions.manage.noDescription')}
                      </CardDescription>
                    </div>
                  </CardHeader>
                  <CardFooter className="mt-auto flex flex-wrap justify-end gap-4 border-0 bg-transparent pt-0 text-xs text-muted-foreground tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <CommandIcon className="size-4" />
                      <span className="sr-only">
                        {t('extensions.manage.commands')}
                      </span>
                      {capabilities.commandCount}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <SparklesIcon className="size-4" />
                      <span className="sr-only">
                        {t('extensions.manage.skills')}
                      </span>
                      {capabilities.skillCount}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <BotIcon className="size-4" />
                      <span className="sr-only">
                        {t('extensions.manage.agents')}
                      </span>
                      {capabilities.agentCount}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <ServerIcon className="size-4" />
                      <span className="sr-only">
                        {t('extensions.manage.mcpServers')}
                      </span>
                      {capabilities.mcpServerCount}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <FileTextIcon className="size-4" />
                      <span className="sr-only">
                        {t('extensions.manage.contextFiles')}
                      </span>
                      {capabilities.contextFileCount}
                    </span>
                    {capabilities.hasSettings ? (
                      <span
                        className="inline-flex items-center"
                        aria-label={t('extensions.manage.settings')}
                        title={t('extensions.manage.settings')}
                      >
                        <SettingsIcon className="size-4" />
                      </span>
                    ) : null}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {query ? <SearchIcon /> : <BoxIcon />}
              </EmptyMedia>
              <EmptyTitle>
                {query
                  ? t('extensions.manage.noMatches')
                  : t('extensions.manage.empty')}
              </EmptyTitle>
              {!query ? (
                <EmptyDescription>
                  {t('extensions.manage.emptyDescription')}
                </EmptyDescription>
              ) : null}
            </EmptyHeader>
          </Empty>
        )}
      </div>

      <AlertDialog
        open={installOpen}
        onOpenChange={(open) => {
          if (open || !installing) setInstallOpen(open);
        }}
      >
        <AlertDialogContent size="middle">
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle>{t('extensions.manage.add')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('extensions.manage.installDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            id="extension-source"
            name="extension-source"
            aria-label={t('extensions.manage.installDescription')}
            autoComplete="off"
            value={installSource}
            onChange={(event) => setInstallSource(event.target.value)}
            placeholder={t('extensions.manage.sourcePlaceholder')}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={installing}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <Button
              disabled={
                installing ||
                !operationsRecovered ||
                Boolean(pendingInstall || pendingMutation || busyName) ||
                !installSource.trim()
              }
              onClick={installExtension}
            >
              {installing ? <Spinner /> : null}
              {t('extensions.manage.install')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ExtensionInteractionDialog
        pendingInteraction={pendingInteraction}
        submitting={submittingInteraction}
        selectedPlugin={selectedPlugin}
        interactionValue={interactionValue}
        setSelectedPlugin={setSelectedPlugin}
        setInteractionValue={setInteractionValue}
        submit={submitInteraction}
        t={t}
      />
    </div>
  );
}
