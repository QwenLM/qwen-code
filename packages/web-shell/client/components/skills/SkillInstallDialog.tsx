import { useState } from 'react';
import { AlertCircleIcon, UploadIcon } from 'lucide-react';
import type {
  DaemonSkillInstallRequest,
  DaemonSkillScope,
} from '@qwen-code/sdk/daemon';
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
const MAX_SKILL_ZIP_BYTES = 6 * 1024 * 1024;

function installErrorMessage(
  error: unknown,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const body =
    error && typeof error === 'object'
      ? (error as { body?: unknown }).body
      : undefined;
  const code =
    body && typeof body === 'object'
      ? (body as { code?: unknown }).code
      : undefined;
  if (code === 'invalid_skill_source')
    return t('skills.install.error.invalidSource');
  if (code === 'invalid_skill_scope')
    return t('skills.install.error.invalidScope');
  if (code === 'invalid_skill_name')
    return t('skills.install.error.invalidName');
  if (code === 'skill_manifest_missing')
    return t('skills.install.error.manifestMissing');
  if (
    code === 'invalid_skill_package' ||
    code === 'invalid_skill_manifest' ||
    code === 'skill_name_mismatch' ||
    code === 'unsafe_skill_path'
  ) {
    return t('skills.install.error.invalidPackage');
  }
  if (code === 'skill_package_too_large')
    return t('skills.install.error.zipTooLarge');
  if (code === 'invalid_skill_folder')
    return t('skills.install.error.invalidFolder');
  if (code === 'github_api_failed' || code === 'github_skill_download_failed')
    return t('skills.install.error.githubFailed');
  if (code === 'skill_not_found') return t('skills.install.error.notFound');
  if (code === 'token_required')
    return t('skills.install.error.authentication');
  if (code === 'untrusted_workspace')
    return t('skills.install.error.untrusted');
  return extractErrorDetail(error) || t('skills.install.failed');
}

interface SkillInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (request: DaemonSkillInstallRequest) => Promise<void>;
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

  function reset() {
    setName('');
    setScope('workspace');
    setSource('github');
    setGithubUrl('');
    setFolderPath('');
    setZip(null);
    setError(null);
  }

  async function submit() {
    setInstalling(true);
    setError(null);
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
        if (zip.size > MAX_SKILL_ZIP_BYTES) {
          throw new Error(t('skills.install.error.zipTooLarge'));
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
      setError(installErrorMessage(installError, t));
    } finally {
      setInstalling(false);
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
        className="sm:max-w-lg"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('skills.install.title')}</DialogTitle>
          <DialogDescription>
            {t('skills.install.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <label className="grid gap-2 text-sm font-medium">
            {t('skills.install.name')}
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-skill"
              disabled={installing}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            {t('skills.install.scope')}
            <Select
              value={scope}
              onValueChange={(value) => setScope(value as DaemonSkillScope)}
              disabled={installing}
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
              <TabsTrigger value="github">GitHub</TabsTrigger>
              <TabsTrigger value="folder">
                {t('skills.install.folder')}
              </TabsTrigger>
              <TabsTrigger value="zip">ZIP</TabsTrigger>
            </TabsList>
            <TabsContent value="github" className="pt-3">
              <label className="grid gap-2 text-sm font-medium">
                {t('skills.install.githubUrl')}
                <Input
                  type="url"
                  value={githubUrl}
                  onChange={(event) => setGithubUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo/blob/main/skill/SKILL.md"
                  disabled={installing}
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
                  disabled={installing}
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
                  disabled={installing}
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
              onOpenChange(false);
              reset();
            }}
            disabled={installing}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={installing}>
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
