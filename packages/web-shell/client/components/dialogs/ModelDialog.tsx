import { useEffect, useMemo, useRef } from 'react';
import { useConnection } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import styles from './ModelDialog.module.css';

export type ModelDialogMode = 'main' | 'fast';

interface ModelDialogProps {
  mode?: ModelDialogMode;
  onSelect: (modelId: string) => void;
}

interface ModelDialogModel {
  id: string;
  baseModelId?: string;
  label?: string;
  authType?: string;
  contextWindow?: number;
  modalities?: {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
  };
  baseUrl?: string;
  envKey?: string;
  isRuntime?: boolean;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function formatContextWindow(size: number | undefined, t: T): string {
  return size
    ? `${size.toLocaleString()} ${t('contextUsage.tokens')}`
    : t('model.contextWindow.unknown');
}

function formatModalities(
  modalities: ModelDialogModel['modalities'],
  t: T,
): string {
  if (!modalities) return t('model.modality.textOnly');
  const parts: string[] = [];
  if (modalities.image) parts.push(t('model.modality.image'));
  if (modalities.pdf) parts.push(t('model.modality.pdf'));
  if (modalities.audio) parts.push(t('model.modality.audio'));
  if (modalities.video) parts.push(t('model.modality.video'));
  if (parts.length === 0) return t('model.modality.textOnly');
  return `${t('model.modality.text')} · ${parts.join(' · ')}`;
}

function getAuthType(model: ModelDialogModel): string | undefined {
  if (model.authType) return model.authType;
  const match = model.id.match(/\(([^()]+)\)$/);
  return match?.[1];
}

function getModelName(model: ModelDialogModel): string {
  if (model.label) return model.label;
  if (model.baseModelId) return model.baseModelId;
  return model.id.replace(/\([^()]+\)$/, '');
}

function getModelKey(model: ModelDialogModel): string {
  return [
    model.authType ?? '',
    model.id,
    model.baseUrl ?? '',
    model.envKey ?? '',
  ].join('\0');
}

function getModelSelectId(
  model: ModelDialogModel,
  isFastMode: boolean,
): string {
  if (!isFastMode) return model.id;
  return model.baseModelId ?? model.id.replace(/\([^()]+\)$/, '');
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue}>{value}</span>
    </div>
  );
}

export function ModelDialog({ mode = 'main', onSelect }: ModelDialogProps) {
  const connection = useConnection();
  const currentModel = connection.currentModel ?? '';
  const availableModels = useMemo(
    () => (connection.models ?? []) as ModelDialogModel[],
    [connection.models],
  );
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const isFastMode = mode === 'fast';
  const selectedIdx = availableModels.findIndex((m) => m.id === currentModel);
  const selectedModel =
    selectedIdx >= 0 ? availableModels[selectedIdx] : availableModels[0];

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  return (
    <div className={styles.layout}>
      <div
        className={styles.list}
        ref={listRef}
        role="listbox"
        aria-label={isFastMode ? t('model.setFast') : t('model.select')}
      >
        {availableModels.length === 0 ? (
          <div className={styles.empty}>{t('model.none')}</div>
        ) : null}
        {availableModels.map((model, index) => {
          const selected = model.id === currentModel;
          const authType = getAuthType(model);
          return (
            <button
              key={getModelKey(model)}
              type="button"
              role="option"
              aria-selected={selected}
              className={`${styles.row} ${selected ? styles.selected : ''}`}
              onClick={() => onSelect(getModelSelectId(model, isFastMode))}
            >
              <span className={styles.number}>{index + 1}.</span>
              {authType ? (
                <span className={styles.provider}>[{authType}]</span>
              ) : null}
              <span className={styles.label}>{getModelName(model)}</span>
              {model.isRuntime ? (
                <span className={styles.badge}>Runtime</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {selectedModel ? (
        <>
          <div className={styles.divider} />
          <div className={styles.detail}>
            <DetailRow
              label={t('model.modality')}
              value={formatModalities(selectedModel.modalities, t)}
            />
            <DetailRow
              label={t('model.contextWindow')}
              value={formatContextWindow(selectedModel.contextWindow, t)}
            />
            {getAuthType(selectedModel) !== 'qwen-oauth' ? (
              <>
                <DetailRow
                  label={t('model.baseUrl')}
                  value={selectedModel.baseUrl ?? t('model.default')}
                />
                <DetailRow
                  label={t('model.apiKey')}
                  value={selectedModel.envKey ?? t('model.notSet')}
                />
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
