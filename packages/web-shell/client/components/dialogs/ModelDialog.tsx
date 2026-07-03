import { useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { dp } from './dialogStyles';
import styles from './ModelDialog.module.css';

export type ModelDialogMode = 'main' | 'fast' | 'voice' | 'vision';

interface ModelDialogProps {
  mode?: ModelDialogMode;
  onSelect: (modelId: string) => void;
  models?: ModelDialogModel[];
  currentModelId?: string;
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

export function ModelDialog({
  mode = 'main',
  onSelect,
  models,
  currentModelId,
}: ModelDialogProps) {
  const connection = useConnection();
  const currentModel = currentModelId ?? connection.currentModel ?? '';
  const availableModels = useMemo(
    () => models ?? ((connection.models ?? []) as ModelDialogModel[]),
    [models, connection.models],
  );
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const isFastMode = mode === 'fast';
  const isVoiceMode = mode === 'voice';
  const isVisionMode = mode === 'vision';
  const currentIdx = availableModels.findIndex((m) => m.id === currentModel);
  const [activeIndex, setActiveIndex] = useState(
    currentIdx >= 0 ? currentIdx : 0,
  );
  // Follow the current model until the user first navigates: models arrive
  // asynchronously, and the current model itself can change while the dialog
  // is open (e.g. another client sharing the session switches models) — the
  // highlight, detail panel and Enter must track it. Once the user has moved
  // the highlight themselves, it is theirs and must not be stolen.
  const userNavigatedRef = useRef(false);
  useEffect(() => {
    if (userNavigatedRef.current || availableModels.length === 0) return;
    setActiveIndex(currentIdx >= 0 ? currentIdx : 0);
  }, [availableModels.length, currentIdx]);

  const moveHighlight = (index: number) => {
    userNavigatedRef.current = true;
    setActiveIndex(index);
  };

  // Keep the highlight in bounds if the model list refreshes/shrinks while open,
  // so aria-activedescendant, the detail panel and Enter all stay in sync.
  useEffect(() => {
    if (activeIndex >= availableModels.length && availableModels.length > 0) {
      setActiveIndex(availableModels.length - 1);
    }
  }, [availableModels.length, activeIndex]);

  const selectedModel = availableModels[activeIndex] ?? availableModels[0];

  const confirm = (index: number) => {
    const model = availableModels[index];
    if (model) onSelect(getModelSelectId(model, isFastMode));
  };

  const { keyboardMode } = useListboxKeyboard({
    itemCount: availableModels.length,
    activeIndex,
    onActiveIndexChange: moveHighlight,
    onConfirm: confirm,
  });

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className={styles.layout}>
      <div
        className={`${styles.list} ${keyboardMode ? styles.keyboardOnly : ''}`}
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-activedescendant={
          availableModels.length > 0 ? `model-opt-${activeIndex}` : undefined
        }
        aria-label={
          isFastMode
            ? t('model.setFast')
            : isVoiceMode
              ? t('model.setVoice')
              : isVisionMode
                ? t('model.setVision')
                : t('model.select')
        }
      >
        {availableModels.length === 0 ? (
          <div className={styles.empty}>{t('model.none')}</div>
        ) : null}
        {availableModels.map((model, index) => {
          const selected = index === activeIndex;
          // Only the first id match is the "current" one. `currentModel` is just
          // an id string, so when two providers expose the same model id we
          // cannot tell them apart here — mark one, consistent with the initial
          // highlight (which also lands on `currentIdx`, the first match).
          const isCurrent = index === currentIdx;
          const authType = getAuthType(model);
          return (
            <div
              key={getModelKey(model)}
              id={`model-opt-${index}`}
              role="option"
              // aria-selected marks the actual current model; the roving
              // keyboard highlight is conveyed by aria-activedescendant + the
              // visual `.selected` class, not by aria-selected.
              aria-selected={isCurrent}
              className={`${styles.row} ${selected ? styles.selected : ''} ${
                isCurrent ? dp('dialog-current') : ''
              }`}
              onClick={() => confirm(index)}
              onMouseMove={() => moveHighlight(index)}
            >
              <span className={styles.number}>{index + 1}.</span>
              {authType ? (
                <span className={styles.provider}>[{authType}]</span>
              ) : null}
              <span className={styles.label}>{getModelName(model)}</span>
              {model.isRuntime ? (
                <span className={styles.badge}>Runtime</span>
              ) : null}
            </div>
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
