import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import styles from './ModelMessage.module.css';

export const MODEL_ACTIVE_EVENT = 'web-shell:model-panel-active';

export type ModelInlineMode = 'main' | 'fast';

interface ModelMessageProps {
  mode?: ModelInlineMode;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

interface ModelMessageModel {
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
  modalities: ModelMessageModel['modalities'],
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

function getAuthType(model: ModelMessageModel): string | undefined {
  if (model.authType) return model.authType;
  const match = model.id.match(/\(([^()]+)\)$/);
  return match?.[1];
}

function getModelName(model: ModelMessageModel): string {
  if (model.label) return model.label;
  if (model.baseModelId) return model.baseModelId;
  return model.id.replace(/\([^()]+\)$/, '');
}

function getModelKey(model: ModelMessageModel): string {
  return [
    model.authType ?? '',
    model.id,
    model.baseUrl ?? '',
    model.envKey ?? '',
  ].join('\0');
}

function getModelSelectId(
  model: ModelMessageModel,
  isFastMode: boolean,
): string {
  if (!isFastMode) return model.id;
  return model.baseModelId ?? model.id.replace(/\([^()]+\)$/, '');
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.detailLabel}>{label}:</span>
      <span className={styles.detailValue}>{value}</span>
    </div>
  );
}

export function ModelMessage({
  mode = 'main',
  onSelect,
  onClose,
}: ModelMessageProps) {
  const connection = useConnection();
  const currentModel = connection.currentModel ?? '';
  const availableModels = useMemo(
    () => (connection.models ?? []) as ModelMessageModel[],
    [connection.models],
  );
  const { t } = useI18n();
  const panelIdRef = useRef(`model-${Math.random().toString(36).slice(2)}`);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const isFastMode = mode === 'fast';
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const idx = availableModels.findIndex((m) => m.id === currentModel);
    return idx >= 0 ? idx : 0;
  });
  const selectedModel = availableModels[selectedIdx];

  const emitActive = useCallback((active: boolean) => {
    window.dispatchEvent(
      new CustomEvent(MODEL_ACTIVE_EVENT, {
        detail: { id: panelIdRef.current, active },
      }),
    );
  }, []);

  useEffect(() => {
    emitActive(true);
    return () => emitActive(false);
  }, [emitActive]);

  // Close when the user presses outside the panel. The panel is rendered
  // inline (no modal backdrop), so we listen on the document. The press that
  // opened the panel (e.g. the status-bar model button, which stops
  // propagation on mousedown/touchstart) has finished propagating by the time
  // this effect runs, so it cannot self-close. Touch is covered too.
  useEffect(() => {
    const onPointerOutside = (event: Event) => {
      // Only the primary (left) mouse button dismisses. Middle-click on
      // Linux/X11 pastes, and right-click opens a context menu — neither should
      // close the panel out from under the user. (Touch events have no button.)
      if (event instanceof MouseEvent && event.button !== 0) return;
      // If another handler already consumed the press, leave the panel alone.
      if (event.defaultPrevented) return;
      const panel = panelRef.current;
      const target = event.target;
      if (panel && target instanceof Node && !panel.contains(target)) {
        onCloseRef.current();
      }
    };
    window.addEventListener('mousedown', onPointerOutside);
    window.addEventListener('touchstart', onPointerOutside);
    return () => {
      window.removeEventListener('mousedown', onPointerOutside);
      window.removeEventListener('touchstart', onPointerOutside);
    };
  }, []);

  useEffect(() => {
    if (selectedIdx >= availableModels.length && availableModels.length > 0) {
      setSelectedIdx(availableModels.length - 1);
    }
  }, [availableModels.length, selectedIdx]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleSelect = useCallback(() => {
    const model = availableModels[selectedIdx];
    if (!model) return;
    onSelect(getModelSelectId(model, isFastMode));
    onClose();
  }, [availableModels, isFastMode, onClose, onSelect, selectedIdx]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === 'Escape') {
        claim();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        claim();
        setSelectedIdx((idx) =>
          availableModels.length > 0 ? (idx + 1) % availableModels.length : 0,
        );
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        claim();
        setSelectedIdx((idx) =>
          availableModels.length > 0
            ? (idx - 1 + availableModels.length) % availableModels.length
            : 0,
        );
        return;
      }
      if (e.key === 'Enter') {
        claim();
        handleSelect();
        return;
      }
    },
    [availableModels.length, handleSelect, onClose],
  );

  return (
    <div ref={panelRef} className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          {isFastMode ? t('model.setFast') : t('model.select')}
        </span>
      </div>

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
          const selected = index === selectedIdx;
          const authType = getAuthType(model);
          return (
            <div
              key={getModelKey(model)}
              role="option"
              aria-selected={selected}
              className={`${styles.row} ${selected ? styles.selected : ''}`}
              onClick={() => {
                onSelect(getModelSelectId(model, isFastMode));
                onClose();
              }}
              // Hover feedback is pure CSS (.row:hover) and deliberately does
              // NOT move the selection: arrow keys own the pointer + accent
              // label + detail panel, the mouse only adds a background
              // highlight. This keeps mouse and keyboard from fighting when the
              // list scrolls under a resting cursor.
            >
              <span className={styles.pointer}>{selected ? '›' : ' '}</span>
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
      ) : null}

      <div className={styles.footer}>{t('model.footer')}</div>
    </div>
  );
}
