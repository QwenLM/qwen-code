import { useEffect, useState } from 'react';
import {
  ArrowUpRightIcon,
  GlobeIcon,
  MonitorIcon,
  RotateCwIcon,
  SmartphoneIcon,
} from 'lucide-react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  parseWebPreviewUrl,
  webPreviewDocument,
  type WebPreviewState,
} from './web-preview';

export function WebPreviewPanel({
  state,
  onChange,
}: {
  state: WebPreviewState;
  onChange: (state: WebPreviewState) => void;
}) {
  const { t } = useI18n();
  const { baseUrl } = useWorkspace();
  const openExternal = useExternalLinkOpener();
  const [address, setAddress] = useState(state.url);
  const [invalid, setInvalid] = useState(false);
  const [revision, setRevision] = useState(0);
  const url = parseWebPreviewUrl(state.url, window.location.href, baseUrl);
  useEffect(() => {
    setAddress(state.url);
    setInvalid(false);
  }, [state.url]);

  return (
    <section
      className="flex h-full min-h-0 flex-col gap-3 bg-background text-foreground"
      data-web-shell-web-preview
      aria-label={t('webPreview.title')}
    >
      <form
        className="flex shrink-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = parseWebPreviewUrl(
            address,
            window.location.href,
            baseUrl,
          );
          setInvalid(!next);
          if (!next) return;
          setAddress(next.href);
          setRevision((value) => value + 1);
          onChange({ ...state, url: next.href });
        }}
      >
        <Input
          aria-label={t('webPreview.address')}
          aria-invalid={invalid || (!!state.url && !url)}
          placeholder="http://localhost:3000"
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setInvalid(false);
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit">{t('webPreview.open')}</Button>
      </form>
      {invalid || (state.url && !url) ? (
        <p role="alert" className="text-sm text-destructive">
          {t('webPreview.invalidUrl')}
        </p>
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!url}
          title={t('webPreview.refresh')}
          aria-label={t('webPreview.refresh')}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RotateCwIcon />
        </Button>
        {(['desktop', 'mobile'] as const).map((viewport) => (
          <Button
            key={viewport}
            type="button"
            variant={state.viewport === viewport ? 'secondary' : 'ghost'}
            size="icon"
            aria-pressed={state.viewport === viewport}
            title={t(`webPreview.${viewport}`)}
            aria-label={t(`webPreview.${viewport}`)}
            onClick={() => onChange({ ...state, viewport })}
          >
            {viewport === 'desktop' ? <MonitorIcon /> : <SmartphoneIcon />}
          </Button>
        ))}
        {url && (
          <Button asChild variant="ghost" size="sm" className="ml-auto">
            <a
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => openExternal(event, url.href)}
            >
              <ArrowUpRightIcon />
              {t('webPreview.external')}
            </a>
          </Button>
        )}
      </div>
      {url ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted">
          <iframe
            key={`${url.href}:${revision}`}
            title={t('webPreview.frame')}
            className="mx-auto block h-full border-0 bg-white"
            style={{ width: state.viewport === 'mobile' ? 390 : '100%' }}
            referrerPolicy="no-referrer"
            srcDoc={webPreviewDocument(url, t('webPreview.page'))}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          <GlobeIcon className="size-8" />
          <p>{t('webPreview.empty')}</p>
        </div>
      )}
      {url && (
        <p className="shrink-0 text-xs text-muted-foreground">
          {t('webPreview.live')}
        </p>
      )}
      <p className="shrink-0 text-xs text-muted-foreground">
        {t(url ? 'webPreview.fallback' : 'webPreview.reachable')}
      </p>
    </section>
  );
}
