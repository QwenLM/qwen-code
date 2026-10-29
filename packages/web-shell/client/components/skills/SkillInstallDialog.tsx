import { useEffect, useState } from 'react';
import { AlertCircleIcon, UploadIcon } from 'lucide-react';
import type {
  DaemonSkillInstallRequest,
  DaemonSkillScope,
  DaemonSkillArchiveInstallRequest,
  DaemonSkillArchiveInstallResult,
  DaemonSkillInstallAttempt,
  DaemonSkillMutationResult,
  DaemonCapabilities,
} from '@qwen-code/sdk/daemon';
import { DaemonSkillInstallError } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

type InstallSource = 'github' | 'folder' | 'zip';
const MAX_SKILL_ZIP_BYTES = 7_864_071;

function installErrorMessage(
  error: unknown,
  t: ReturnType<typeof useI18n>['t'],
  nativeArchive = false,
): string {
  const body =
    error && typeof error === 'object'
      ? (error as { body?: unknown }).body
      : undefined;
  const code =
    body && typeof body === 'object'
      ? (body as { code?: unknown }).code
      : undefined;
  const detail = extractErrorDetail(error);
  const withDetail = (guidance: string) =>
    detail && detail !== guidance ? `${detail}\n\n${guidance}` : guidance;

  if (code === 'invalid_skill_source')
    return withDetail(t('skills.install.error.invalidSource'));
  if (code === 'invalid_skill_scope')
    return withDetail(t('skills.install.error.invalidScope'));
  if (code === 'invalid_skill_name')
    return withDetail(t('skills.install.error.invalidName'));
  if (code === 'skill_manifest_missing')
    return withDetail(t('skills.install.error.manifestMissing'));
  if (code === 'invalid_skill_manifest') {
    return withDetail(
      t(
        detail ===
          'Failed to parse skill file: Invalid format: missing YAML frontmatter'
          ? 'skills.install.error.frontmatter'
          : 'skills.install.error.invalidManifest',
      ),
    );
  }
  if (code === 'skill_name_mismatch')
    return withDetail(t('skills.install.error.nameMismatch'));
  if (code === 'unsafe_skill_path')
    return withDetail(t('skills.install.error.unsafePath'));
  if (code === 'invalid_skill_package')
    return withDetail(t('skills.install.error.invalidPackage'));
  if (code === 'skill_package_too_large')
    return withDetail(
      t(
        nativeArchive
          ? 'skills.install.error.archivePackageTooLarge'
          : 'skills.install.error.packageTooLarge',
      ),
    );
  if (code === 'skill_too_many_files')
    return withDetail(
      t(
        nativeArchive
          ? 'skills.install.error.archiveEntries'
          : 'skills.install.error.tooManyFiles',
      ),
    );
  if (code === 'invalid_skill_folder')
    return withDetail(t('skills.install.error.invalidFolder'));
  if (code === 'github_api_failed' || code === 'github_skill_download_failed')
    return withDetail(t('skills.install.error.githubFailed'));
  if (code === 'skill_not_found')
    return withDetail(t('skills.install.error.notFound'));
  if (code === 'token_required')
    return withDetail(t('skills.install.error.authentication'));
  if (code === 'untrusted_workspace')
    return withDetail(t('skills.install.error.untrusted'));
  return detail || t('skills.install.failed');
}

interface SkillInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (request: DaemonSkillInstallRequest) => Promise<void>;
  archive?: {
    limits?: DaemonCapabilities['limits'];
    install(
      request: DaemonSkillArchiveInstallRequest,
      scope: DaemonSkillScope,
    ): Promise<DaemonSkillArchiveInstallResult>;
    lookup(
      scope: DaemonSkillScope,
      attemptId: string,
    ): Promise<DaemonSkillInstallAttempt | undefined>;
    committed(result: DaemonSkillMutationResult): Promise<void>;
  };
}

interface PendingInstall {
  attemptId: string;
  lookup(attemptId: string): Promise<DaemonSkillInstallAttempt | undefined>;
  committed(result: DaemonSkillMutationResult): Promise<void>;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function SkillInstallDialog({
  open,
  onOpenChange,
  onInstall,
  archive,
}: SkillInstallDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<DaemonSkillScope>('workspace');
  const [source, setSource] = useState<InstallSource>('github');
  const [githubUrl, setGithubUrl] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [zip, setZip] = useState<File | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultNotice, setResultNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);
  useEffect(() => () => controller?.abort(), [controller]);

  function reset() {
    setName('');
    setScope('workspace');
    setSource('github');
    setGithubUrl('');
    setFolderPath('');
    setZip(null);
    setError(null);
    setResultNotice(null);
    setPending(null);
  }

  async function committed(
    result: DaemonSkillMutationResult,
    complete: PendingInstall['committed'],
  ) {
    setController(null);
    setPending(null);
    try {
      await complete(result);
      onOpenChange(false);
      reset();
    } catch (error) {
      setResultNotice(
        t('skills.install.succeeded', { name: result.skillName }),
      );
      setError(
        t('skills.install.activationWarning', {
          detail: extractErrorDetail(error),
        }),
      );
    }
  }

  async function checkResult(attempt: PendingInstall) {
    setInstalling(true);
    setError(null);
    setResultNotice(t('skills.install.checkingResult'));
    try {
      const receipt = await attempt.lookup(attempt.attemptId);
      if (receipt?.state === 'committed' && receipt.result) {
        await committed(receipt.result, attempt.committed);
      } else if (
        receipt?.state === 'not_committed' ||
        receipt?.state === 'recovery_required'
      ) {
        setPending(null);
        setResultNotice(null);
        setError(
          [
            t(
              receipt.state === 'recovery_required'
                ? 'skills.install.recoveryRequired'
                : 'skills.install.notCommitted',
            ),
            receipt.error?.message,
            ...(receipt.error?.retainedPaths ?? []),
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } else {
        setResultNotice(
          t(
            receipt?.state === 'running'
              ? 'skills.install.stillRunning'
              : 'skills.install.resultUnknown',
          ),
        );
      }
    } catch {
      setResultNotice(t('skills.install.resultUnknown'));
    } finally {
      setInstalling(false);
    }
  }

  async function submit() {
    setInstalling(true);
    setError(null);
    setResultNotice(null);
    try {
      if (!name.trim()) throw new Error(t('skills.install.error.nameRequired'));
      let installSource: DaemonSkillInstallRequest['source'];
      if (source === 'github') {
        if (!githubUrl.trim())
          throw new Error(t('skills.install.error.githubRequired'));
        installSource = { type: 'github', url: githubUrl.trim() };
      } else if (source === 'folder') {
        if (!folderPath.trim())
          throw new Error(t('skills.install.error.folderRequired'));
        installSource = { type: 'folder', path: folderPath.trim() };
      } else {
        if (!zip) throw new Error(t('skills.install.selectZip'));
        if (archive) {
          const maxBytes =
            archive.limits?.maxSkillArchiveBytes ?? 50 * 1024 * 1024;
          if (zip.size > maxBytes)
            throw new Error(
              t('skills.install.error.archiveTooLarge', {
                limit: maxBytes / 1024 / 1024,
              }),
            );
          const activeArchive = archive;
          const activeScope = scope;
          const activeController = new AbortController();
          setController(activeController);
          try {
            const result = await activeArchive.install(
              { name: name.trim(), data: zip, signal: activeController.signal },
              activeScope,
            );
            await committed(result, activeArchive.committed);
          } catch (error) {
            setController(null);
            if (
              error instanceof DaemonSkillInstallError &&
              (error.status === undefined ||
                error.status >= 500 ||
                error.status === 408 ||
                error.status === 499)
            ) {
              const attempt: PendingInstall = {
                attemptId: error.attemptId,
                lookup: (id) => activeArchive.lookup(activeScope, id),
                committed: activeArchive.committed,
              };
              setPending(attempt);
              await checkResult(attempt);
            } else throw error;
          }
          return;
        }
        if (zip.size > MAX_SKILL_ZIP_BYTES) {
          throw new Error(t('skills.install.error.zipUpgrade'));
        }
        installSource = {
          type: 'zip',
          contentBase64: await fileToBase64(zip),
        };
      }
      await onInstall({ name: name.trim(), scope, source: installSource });
      onOpenChange(false);
      reset();
    } catch (installError) {
      setError(
        installErrorMessage(installError, t, source === 'zip' && !!archive),
      );
    } finally {
      setInstalling(false);
      setController(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (installing) return;
        onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('skills.install.title')}</DialogTitle>
          <DialogDescription>
            {t('skills.install.description')}
            <span className="mt-2 block">
              {source === 'zip' && archive
                ? t('skills.install.archiveHelp', {
                    compressed:
                      (archive.limits?.maxSkillArchiveBytes ??
                        50 * 1024 * 1024) /
                      1024 /
                      1024,
                    expanded:
                      (archive.limits?.maxSkillArchiveExpandedBytes ??
                        200 * 1024 * 1024) /
                      1024 /
                      1024,
                    entries: archive.limits?.maxSkillArchiveEntries ?? 4096,
                    manifest:
                      (archive.limits?.maxSkillArchiveManifestBytes ??
                        32 * 1024 * 1024) /
                      1024 /
                      1024,
                  })
                : t(
                    source === 'zip'
                      ? 'skills.install.legacyZipHelp'
                      : 'skills.install.legacyHelp',
                  )}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {resultNotice ? (
            <Alert>
              <AlertDescription>{resultNotice}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription className="min-w-0 whitespace-pre-wrap break-words">
                {error}
              </AlertDescription>
            </Alert>
          ) : null}
          <label className="grid gap-2 text-sm font-medium">
            {t('skills.install.name')}
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-skill"
              disabled={installing || pending !== null}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            {t('skills.install.scope')}
            <Select
              value={scope}
              onValueChange={(value) => setScope(value as DaemonSkillScope)}
              disabled={installing || pending !== null}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace">
                  {t('skills.install.scope.workspace')}
                </SelectItem>
                <SelectItem value="global">
                  {t('skills.install.scope.global')}
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
          <Tabs
            value={source}
            onValueChange={(value) => setSource(value as InstallSource)}
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger
                value="github"
                disabled={installing || pending !== null}
              >
                GitHub
              </TabsTrigger>
              <TabsTrigger
                value="folder"
                disabled={installing || pending !== null}
              >
                {t('skills.install.folder')}
              </TabsTrigger>
              <TabsTrigger
                value="zip"
                disabled={installing || pending !== null}
              >
                ZIP
              </TabsTrigger>
            </TabsList>
            <TabsContent value="github" className="pt-3">
              <label className="grid gap-2 text-sm font-medium">
                {t('skills.install.githubUrl')}
                <Input
                  type="url"
                  value={githubUrl}
                  onChange={(event) => setGithubUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo/blob/main/skill/SKILL.md"
                  disabled={installing || pending !== null}
                />
              </label>
            </TabsContent>
            <TabsContent value="folder" className="pt-3">
              <label className="grid gap-2 text-sm font-medium">
                {t('skills.install.folderPath')}
                <Input
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  placeholder="/absolute/path/to/my-skill"
                  disabled={installing || pending !== null}
                />
              </label>
            </TabsContent>
            <TabsContent value="zip" className="pt-3">
              <div className="grid gap-2">
                <Input
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setZip(file);
                    if (file) {
                      setName(
                        (currentName) =>
                          currentName || file.name.replace(/\.zip$/i, ''),
                      );
                    }
                  }}
                  disabled={installing || pending !== null}
                />
                {zip ? (
                  <div className="text-xs text-muted-foreground">
                    {t('skills.install.zipSelected', { name: zip.name })}
                  </div>
                ) : null}
              </div>
            </TabsContent>
          </Tabs>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (controller) {
                controller.abort();
                return;
              }
              onOpenChange(false);
              reset();
            }}
            disabled={installing && !controller}
          >
            {t(
              controller
                ? 'skills.install.cancelRequest'
                : pending
                  ? 'common.close'
                  : 'common.cancel',
            )}
          </Button>
          {pending ? (
            <Button
              onClick={() => void checkResult(pending)}
              disabled={installing}
            >
              {installing ? <Spinner data-icon="inline-start" /> : null}
              {t('skills.install.checkResult')}
            </Button>
          ) : null}
          <Button
            onClick={() => void submit()}
            disabled={installing || pending !== null}
          >
            {installing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UploadIcon data-icon="inline-start" />
            )}
            {t('skills.install.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
