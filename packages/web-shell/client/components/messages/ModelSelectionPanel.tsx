import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DaemonAuthProviderDescriptor } from '@qwen-code/web-shell/daemon-react-sdk';
import { useOptionalDaemonWorkspace } from '../../daemon/workspace/DaemonWorkspaceProvider';
import { useI18n } from '../../i18n';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Spinner } from '../ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  ClockIcon,
  SearchIcon,
  SparklesIcon,
  TagIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import { getDaemonToken, getDaemonBaseUrl } from '../../config/daemon';
import styles from './ModelSelectionPanel.module.css';

export interface ModelCatalogItem {
  id: string;
  name: string;
  type: string;
  maxTokens: number | null;
  quantization: string | null;
  tags: string[];
  isFeatured: boolean;
  hasFlex: boolean;
  hasPriority: boolean;
  hasDiscount: boolean;
  discountPercent: number | null;
  discountEndsAtMs?: number | null;
  centsPerInputToken: number | null;
  centsPerOutputToken: number | null;
  pricePerMillionInput: number | null; // in $/Mt
  pricePerMillionOutput: number | null; // in $/Mt
  description?: string;
}

interface DeepInfraRawModel {
  model_name: string;
  type?: string;
  description?: string;
  tags?: string[];
  featured?: boolean;
  pricing?: {
    cents_per_input_token?: number | null;
    cents_per_output_token?: number | null;
    rate_per_service_tier_flex?: number | null;
    discount?: number | null;
    discount_ends_at?: string | null;
  } | null;
  max_tokens?: number | null;
  quantization?: string | null;
  deprecated?: boolean | number | null;
}

export interface ModelSelectionPanelProps {
  provider: DaemonAuthProviderDescriptor | null;
  value: string;
  onChange: (value: string) => void;
  onModelSpecsChange?: (
    specs: Array<{ id: string; contextWindowSize?: number }>,
  ) => void;
  disabled?: boolean;
  onEnterPress?: () => void;
  defaultModelIds?: string;
  daemonBaseUrl?: string;
  autoFocus?: boolean;
}

export function formatPricePerMillion(
  centsPerToken: number | null | undefined,
): string {
  if (centsPerToken == null) return '—';
  if (centsPerToken === 0) return 'Free';
  const dollarsPerMillion = centsPerToken * 10000;
  if (dollarsPerMillion < 0.01) {
    return `$${dollarsPerMillion.toFixed(4)}/Mt`;
  }
  if (dollarsPerMillion < 1) {
    return `$${dollarsPerMillion.toFixed(2)}/Mt`;
  }
  return `$${dollarsPerMillion.toFixed(2)}/Mt`;
}

export function formatContextTokens(tokens: number | null | undefined): string {
  if (tokens == null || tokens <= 0) return '—';
  if (tokens === 1048576) return '1024k';
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens % 1000 === 0) {
    return `${tokens / 1000}k`;
  }
  if (tokens % 1024 === 0) {
    return `${tokens / 1024}k`;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${tokens}`;
}

function parseModelIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

const DEEPINFRA_MODELS_URL = 'https://api.deepinfra.com/models/list';
const DEEPINFRA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedCatalog {
  timestamp: number;
  data: ModelCatalogItem[];
}

let deepinfraCache: CachedCatalog | null = null;

export function resetDeepinfraCacheForTest(): void {
  deepinfraCache = null;
}

function parseRawCatalog(rawList: unknown[]): ModelCatalogItem[] {
  const now = Date.now();
  const catalog: ModelCatalogItem[] = [];

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as DeepInfraRawModel;
    if (typeof item.model_name !== 'string' || !item.model_name.trim()) {
      continue;
    }
    const modelName = item.model_name.trim();
    if (modelName.toLowerCase().startsWith('anthropic/')) {
      continue;
    }
    const itemType =
      (typeof item.type === 'string' ? item.type.trim() : '') ||
      'text-generation';
    if (itemType !== 'text-generation') {
      continue;
    }
    if (item.deprecated === true) {
      continue;
    }
    if (typeof item.deprecated === 'number') {
      const tsMs =
        item.deprecated < 1e11 ? item.deprecated * 1000 : item.deprecated;
      if (tsMs <= now) {
        continue;
      }
    }

    const tags = Array.isArray(item.tags)
      ? item.tags.filter((t): t is string => typeof t === 'string')
      : [];
    const isFeatured = item.featured === true || tags.includes('featured');
    const hasFlex = tags.includes('flex');
    const hasPriority = tags.includes('priority');

    let discountEndsAtMs: number | null = null;
    const endsAt = item.pricing?.discount_ends_at;
    if (endsAt) {
      const parsed = Date.parse(endsAt);
      if (!isNaN(parsed)) {
        discountEndsAtMs = parsed;
      }
    }

    const isExpired = discountEndsAtMs !== null && discountEndsAtMs <= now;

    let isDiscountActive = false;
    const discountVal = item.pricing?.discount;
    if (!isExpired) {
      if (typeof discountVal === 'number' && discountVal > 0) {
        isDiscountActive = true;
      } else if (tags.includes('discount')) {
        isDiscountActive = true;
      }
    }

    const hasDiscount = isDiscountActive;
    const discountPercent =
      isDiscountActive && typeof discountVal === 'number' && discountVal > 0
        ? Number((discountVal * 100).toFixed(1))
        : null;

    const centsIn =
      typeof item.pricing?.cents_per_input_token === 'number'
        ? item.pricing.cents_per_input_token
        : null;
    const centsOut =
      typeof item.pricing?.cents_per_output_token === 'number'
        ? item.pricing.cents_per_output_token
        : null;
    const maxTokens =
      typeof item.max_tokens === 'number' && item.max_tokens > 0
        ? item.max_tokens
        : null;
    const quantization =
      typeof item.quantization === 'string' && item.quantization.trim()
        ? item.quantization.trim()
        : null;
    const description =
      typeof item.description === 'string' ? item.description : undefined;

    catalog.push({
      id: modelName,
      name: modelName,
      type: itemType,
      maxTokens,
      quantization,
      tags,
      isFeatured,
      hasFlex,
      hasPriority,
      hasDiscount,
      discountPercent,
      discountEndsAtMs,
      centsPerInputToken: centsIn,
      centsPerOutputToken: centsOut,
      pricePerMillionInput: centsIn != null ? centsIn * 10000 : null,
      pricePerMillionOutput: centsOut != null ? centsOut * 10000 : null,
      description,
    });
  }

  return catalog;
}

export function isItemDiscountActive(
  item: ModelCatalogItem,
  currentTimeMs: number = Date.now(),
): boolean {
  if (item.discountEndsAtMs != null && item.discountEndsAtMs <= currentTimeMs) {
    return false;
  }
  return item.hasDiscount;
}

type SortField = 'name' | 'context' | 'quant' | 'priceIn' | 'priceOut';
type SortDirection = 'asc' | 'desc';

export function ModelSelectionPanel({
  provider,
  value,
  onChange,
  onModelSpecsChange,
  disabled = false,
  onEnterPress,
  defaultModelIds = '',
  daemonBaseUrl,
  autoFocus = false,
}: ModelSelectionPanelProps): ReactNode {
  const { t } = useI18n();
  const optionalWorkspace = useOptionalDaemonWorkspace();
  const effectiveDaemonBaseUrl =
    daemonBaseUrl ?? optionalWorkspace?.baseUrl ?? getDaemonBaseUrl() ?? '';

  const searchInputRef = useRef<HTMLInputElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState('all');
  const [selectedQuant, setSelectedQuant] = useState('all');
  const [minContext, setMinContext] = useState<number>(0);
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [discountOnly, setDiscountOnly] = useState(false);
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [flexOnly, setFlexOnly] = useState(false);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const [models, setModels] = useState<ModelCatalogItem[]>(() => {
    if (
      provider?.id === 'deepinfra' &&
      deepinfraCache &&
      Date.now() - deepinfraCache.timestamp < DEEPINFRA_CACHE_TTL_MS
    ) {
      return deepinfraCache.data;
    }
    return (provider?.models ?? [])
      .filter((m) => !m.id.toLowerCase().startsWith('anthropic/'))
      .map((m) => ({
        id: m.id,
        name: m.id,
        type: m.modalities?.image ? 'multimodal' : 'text-generation',
        maxTokens: m.contextWindowSize ?? null,
        quantization: null,
        tags: [],
        isFeatured: false,
        hasFlex: false,
        hasPriority: false,
        hasDiscount: false,
        discountPercent: null,
        centsPerInputToken: null,
        centsPerOutputToken: null,
        pricePerMillionInput: null,
        pricePerMillionOutput: null,
        description: m.description,
      }));
  });

  const isDeepInfra = useMemo(() => {
    if (!provider) return false;
    if (provider.id === 'deepinfra') return true;
    if (typeof provider.baseUrl === 'string' && provider.baseUrl.trim()) {
      try {
        const host = new URL(provider.baseUrl).hostname.toLowerCase();
        return (
          host === 'api.deepinfra.com' ||
          host === 'deepinfra.com' ||
          host.endsWith('.deepinfra.com')
        );
      } catch {
        return false;
      }
    }
    return false;
  }, [provider]);

  useEffect(() => {
    if (autoFocus) {
      if (isDeepInfra) {
        searchInputRef.current?.focus();
      } else {
        manualInputRef.current?.focus();
      }
    }
  }, [autoFocus, isDeepInfra]);

  useEffect(() => {
    if (!isDeepInfra) return;

    if (
      deepinfraCache &&
      Date.now() - deepinfraCache.timestamp < DEEPINFRA_CACHE_TTL_MS
    ) {
      setModels(deepinfraCache.data);
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    setLoading(true);
    setFetchError(null);

    const loadModels = async () => {
      try {
        let rawList: unknown[] | null = null;
        // 1. Try daemon proxy endpoint first
        try {
          const daemonUrl = effectiveDaemonBaseUrl
            ? `${effectiveDaemonBaseUrl.replace(/\/+$/, '')}/workspace/auth/deepinfra-models`
            : '/workspace/auth/deepinfra-models';
          const effectiveToken =
            optionalWorkspace?.token ??
            getDaemonToken(effectiveDaemonBaseUrl || undefined);
          const authHeaders = effectiveToken
            ? { Authorization: `Bearer ${effectiveToken}` }
            : undefined;
          const res = await fetch(daemonUrl, {
            signal: controller.signal,
            headers: {
              ...(authHeaders ?? {}),
            },
          });
          if (res.ok) {
            const json = await res.json();
            if (Array.isArray(json)) {
              rawList = json;
            }
          }
        } catch {
          if (controller.signal.aborted) return;
          // Daemon endpoint not reachable or network error, fallback to direct API
        }

        // 2. If daemon endpoint didn't provide a list, try direct API
        if (!rawList || !Array.isArray(rawList)) {
          const res = await fetch(DEEPINFRA_MODELS_URL, {
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          if (Array.isArray(json)) {
            rawList = json;
          } else {
            throw new Error('Invalid JSON response format');
          }
        }

        if (!isMounted) return;
        const catalog = parseRawCatalog(rawList);
        deepinfraCache = { timestamp: Date.now(), data: catalog };
        setModels(catalog);
        setFetchError(null);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        console.warn(
          '[ModelSelectionPanel] Failed to fetch DeepInfra models:',
          err,
        );
        if (isMounted) {
          setFetchError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    void loadModels();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [
    isDeepInfra,
    effectiveDaemonBaseUrl,
    optionalWorkspace?.token,
    retryCount,
  ]);

  const selectedIds = useMemo(() => parseModelIds(value), [value]);

  const selectedModelSpecs = useMemo(() => {
    const ids = parseModelIds(value);
    const modelMap = new Map<string, ModelCatalogItem>();
    for (const m of models) {
      modelMap.set(m.id, m);
    }
    return ids
      .map((id) => {
        const m = modelMap.get(id);
        const cw = m?.maxTokens && m.maxTokens > 0 ? m.maxTokens : undefined;
        return cw !== undefined ? { id, contextWindowSize: cw } : null;
      })
      .filter(
        (s): s is { id: string; contextWindowSize: number } => s !== null,
      );
  }, [models, value]);

  useEffect(() => {
    onModelSpecsChange?.(selectedModelSpecs);
  }, [onModelSpecsChange, selectedModelSpecs]);

  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    for (const m of models) {
      if (m.type) types.add(m.type);
    }
    return ['all', ...Array.from(types).sort()];
  }, [models]);

  const availableQuants = useMemo(() => {
    const quants = new Set<string>();
    for (const m of models) {
      if (m.quantization) quants.add(m.quantization);
    }
    return ['all', ...Array.from(quants).sort()];
  }, [models]);

  const filteredModels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return models.filter((model) => {
      if (selectedType !== 'all' && model.type !== selectedType) {
        return false;
      }
      if (selectedQuant !== 'all' && model.quantization !== selectedQuant) {
        return false;
      }
      if (featuredOnly && !model.isFeatured) {
        return false;
      }
      if (discountOnly && !isItemDiscountActive(model)) {
        return false;
      }
      if (priorityOnly && !model.hasPriority) {
        return false;
      }
      if (flexOnly && !model.hasFlex) {
        return false;
      }
      if (
        minContext > 0 &&
        (model.maxTokens == null || model.maxTokens < minContext)
      ) {
        return false;
      }
      if (query.length > 0) {
        const matchName = model.name.toLowerCase().includes(query);
        const matchId = model.id.toLowerCase().includes(query);
        const matchDesc = model.description?.toLowerCase().includes(query);
        if (!matchName && !matchId && !matchDesc) {
          return false;
        }
      }
      return true;
    });
  }, [
    models,
    searchQuery,
    selectedType,
    selectedQuant,
    featuredOnly,
    discountOnly,
    priorityOnly,
    flexOnly,
    minContext,
  ]);

  const sortedModels = useMemo(() => {
    const list = [...filteredModels];
    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortField === 'context') {
        const aVal = a.maxTokens;
        const bVal = b.maxTokens;
        if (aVal == null && bVal == null) cmp = 0;
        else if (aVal == null) return 1;
        else if (bVal == null) return -1;
        else cmp = aVal - bVal;
      } else if (sortField === 'quant') {
        const aVal = a.quantization ?? '';
        const bVal = b.quantization ?? '';
        if (!aVal && bVal) return 1;
        else if (aVal && !bVal) return -1;
        else cmp = aVal.localeCompare(bVal);
      } else if (sortField === 'priceIn') {
        const aVal = a.centsPerInputToken;
        const bVal = b.centsPerInputToken;
        if (aVal == null && bVal == null) cmp = 0;
        else if (aVal == null) return 1;
        else if (bVal == null) return -1;
        else cmp = aVal - bVal;
      } else if (sortField === 'priceOut') {
        const aVal = a.centsPerOutputToken;
        const bVal = b.centsPerOutputToken;
        if (aVal == null && bVal == null) cmp = 0;
        else if (aVal == null) return 1;
        else if (bVal == null) return -1;
        else cmp = aVal - bVal;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [filteredModels, sortField, sortDirection]);

  const handleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
    },
    [sortField],
  );

  const toggleModel = useCallback(
    (modelId: string) => {
      if (disabled) return;
      const current = parseModelIds(value);
      const next = current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId];
      onChange(next.join(', '));
    },
    [disabled, onChange, value],
  );

  const removeModel = useCallback(
    (modelId: string) => {
      if (disabled) return;
      const current = parseModelIds(value);
      onChange(current.filter((id) => id !== modelId).join(', '));
    },
    [disabled, onChange, value],
  );

  const handleSelectAllFiltered = useCallback(() => {
    if (disabled) return;
    const current = parseModelIds(value);
    const combined = [
      ...new Set([...current, ...sortedModels.map((m) => m.id)]),
    ];
    onChange(combined.join(', '));
  }, [disabled, sortedModels, onChange, value]);

  const handleClearSelection = useCallback(() => {
    if (disabled) return;
    onChange('');
  }, [disabled, onChange]);

  return (
    <div className={styles.container}>
      {/* Filter and Search Bar */}
      <div className={styles.filterBar}>
        <div className={styles.searchWrapper}>
          <SearchIcon className={styles.searchIcon} />
          <Input
            ref={searchInputRef}
            className={styles.searchInput}
            placeholder={t('auth.modelSelection.searchPlaceholder')}
            value={searchQuery}
            disabled={disabled}
            autoFocus={autoFocus && isDeepInfra}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Type Filter */}
        <div className={styles.selectWrapper}>
          <Select
            value={selectedType}
            disabled={disabled}
            onValueChange={setSelectedType}
          >
            <SelectTrigger aria-label={t('auth.modelSelection.filterByType')}>
              <SelectValue placeholder={t('auth.modelSelection.allTypes')} />
            </SelectTrigger>
            <SelectContent>
              {availableTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {type === 'all'
                    ? t('auth.modelSelection.allTypes')
                    : type === 'text-generation'
                      ? t('auth.modelSelection.textGeneration')
                      : type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Quantization Filter */}
        <div className={styles.selectWrapper}>
          <Select
            value={selectedQuant}
            disabled={disabled}
            onValueChange={setSelectedQuant}
          >
            <SelectTrigger aria-label={t('auth.modelSelection.filterByQuant')}>
              <SelectValue placeholder={t('auth.modelSelection.allQuant')} />
            </SelectTrigger>
            <SelectContent>
              {availableQuants.map((quant) => (
                <SelectItem key={quant} value={quant}>
                  {quant === 'all' ? t('auth.modelSelection.allQuant') : quant}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Context Filter */}
        <div className={styles.selectWrapper}>
          <Select
            value={String(minContext)}
            disabled={disabled}
            onValueChange={(val) => setMinContext(Number(val))}
          >
            <SelectTrigger
              aria-label={t('auth.modelSelection.filterByContext')}
            >
              <SelectValue placeholder={t('auth.modelSelection.anyContext')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">
                {t('auth.modelSelection.anyContext')}
              </SelectItem>
              <SelectItem value="32000">
                {t('auth.modelSelection.minContextTokens', { tokens: '32k' })}
              </SelectItem>
              <SelectItem value="64000">
                {t('auth.modelSelection.minContextTokens', { tokens: '64k' })}
              </SelectItem>
              <SelectItem value="128000">
                {t('auth.modelSelection.minContextTokens', { tokens: '128k' })}
              </SelectItem>
              <SelectItem value="200000">
                {t('auth.modelSelection.minContextTokens', { tokens: '200k' })}
              </SelectItem>
              <SelectItem value="1048576">
                {t('auth.modelSelection.minContextTokens', { tokens: '1024k' })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Toggle Buttons Group: Featured / Discount / Priority / Flex */}
        <div className={styles.toggleButtonsGroup}>
          <button
            type="button"
            className={`${styles.filterButton} ${featuredOnly ? styles.filterButtonActive : ''}`}
            onClick={() => setFeaturedOnly((prev) => !prev)}
            disabled={disabled}
            aria-pressed={featuredOnly}
            title={t('auth.modelSelection.filterFeaturedTitle')}
          >
            <SparklesIcon className={styles.buttonIconFeatured} />
            <span>{t('auth.modelSelection.featured')}</span>
          </button>

          <button
            type="button"
            className={`${styles.filterButton} ${discountOnly ? styles.filterButtonActive : ''}`}
            onClick={() => setDiscountOnly((prev) => !prev)}
            disabled={disabled}
            aria-pressed={discountOnly}
            title={t('auth.modelSelection.filterDiscountTitle')}
          >
            <TagIcon className={styles.buttonIconDiscount} />
            <span>{t('auth.modelSelection.discount')}</span>
          </button>

          <button
            type="button"
            className={`${styles.filterButton} ${priorityOnly ? styles.filterButtonActive : ''}`}
            onClick={() => setPriorityOnly((prev) => !prev)}
            disabled={disabled}
            aria-pressed={priorityOnly}
            title={t('auth.modelSelection.filterPriorityTitle')}
          >
            <ZapIcon className={styles.buttonIconPriority} />
            <span>{t('auth.modelSelection.priority')}</span>
          </button>

          <button
            type="button"
            className={`${styles.filterButton} ${flexOnly ? styles.filterButtonActive : ''}`}
            onClick={() => setFlexOnly((prev) => !prev)}
            disabled={disabled}
            aria-pressed={flexOnly}
            title={t('auth.modelSelection.filterFlexTitle')}
          >
            <ClockIcon className={styles.buttonIconFlex} />
            <span>{t('auth.modelSelection.flex')}</span>
          </button>
        </div>
      </div>

      {fetchError && (
        <div className={styles.errorNotice} role="alert">
          <span>{t('auth.modelSelection.failed', { error: fetchError })}</span>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => setRetryCount((c) => c + 1)}
          >
            {t('auth.modelSelection.retry')}
          </button>
        </div>
      )}

      {/* Model Table List */}
      <div className={styles.tableContainer}>
        {loading ? (
          <div className={styles.loadingNotice}>
            <Spinner />
            <span>{t('auth.modelSelection.loading')}</span>
          </div>
        ) : sortedModels.length === 0 ? (
          <div className={styles.emptyNotice}>
            <span>{t('auth.modelSelection.noMatches')}</span>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th
                  aria-sort={
                    sortField === 'name'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className={styles.sortableHeader}
                    onClick={() => handleSort('name')}
                  >
                    <span>{t('auth.modelSelection.thName')}</span>
                    {sortField === 'name' ? (
                      <span className={styles.sortArrow}>
                        {sortDirection === 'asc' ? '↑' : '↓'}
                      </span>
                    ) : (
                      <span className={styles.sortArrowMuted}>↕</span>
                    )}
                  </button>
                </th>
                <th
                  aria-sort={
                    sortField === 'context'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className={styles.sortableHeader}
                    onClick={() => handleSort('context')}
                  >
                    <span>{t('auth.modelSelection.thContext')}</span>
                    {sortField === 'context' ? (
                      <span className={styles.sortArrow}>
                        {sortDirection === 'asc' ? '↑' : '↓'}
                      </span>
                    ) : (
                      <span className={styles.sortArrowMuted}>↕</span>
                    )}
                  </button>
                </th>
                <th
                  aria-sort={
                    sortField === 'quant'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className={styles.sortableHeader}
                    onClick={() => handleSort('quant')}
                  >
                    <span>{t('auth.modelSelection.thQuant')}</span>
                    {sortField === 'quant' ? (
                      <span className={styles.sortArrow}>
                        {sortDirection === 'asc' ? '↑' : '↓'}
                      </span>
                    ) : (
                      <span className={styles.sortArrowMuted}>↕</span>
                    )}
                  </button>
                </th>
                <th
                  aria-sort={
                    sortField === 'priceIn'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className={styles.sortableHeader}
                    onClick={() => handleSort('priceIn')}
                    title={t('auth.modelSelection.sortInPriceTitle')}
                  >
                    <span>{t('auth.modelSelection.thInPrice')}</span>
                    {sortField === 'priceIn' ? (
                      <span className={styles.sortArrow}>
                        {sortDirection === 'asc' ? '↑' : '↓'}
                      </span>
                    ) : (
                      <span className={styles.sortArrowMuted}>↕</span>
                    )}
                  </button>
                </th>
                <th
                  aria-sort={
                    sortField === 'priceOut'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className={styles.sortableHeader}
                    onClick={() => handleSort('priceOut')}
                    title={t('auth.modelSelection.sortOutPriceTitle')}
                  >
                    <span>{t('auth.modelSelection.thOutPrice')}</span>
                    {sortField === 'priceOut' ? (
                      <span className={styles.sortArrow}>
                        {sortDirection === 'asc' ? '↑' : '↓'}
                      </span>
                    ) : (
                      <span className={styles.sortArrowMuted}>↕</span>
                    )}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedModels.map((model) => {
                const isSelected = selectedIds.includes(model.id);
                return (
                  <tr
                    key={model.id}
                    className={`${styles.tableRow} ${isSelected ? styles.tableRowSelected : ''}`}
                    onClick={() => toggleModel(model.id)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        disabled={disabled}
                        onCheckedChange={() => toggleModel(model.id)}
                        aria-label={t('auth.modelSelection.selectModel', {
                          name: model.name,
                        })}
                      />
                    </td>
                    <td>
                      <div className={styles.modelNameCell}>
                        <div className={styles.modelHeaderRow}>
                          <span className={styles.modelName}>{model.name}</span>
                          {model.isFeatured && (
                            <span
                              title={t('auth.modelSelection.featuredBadge')}
                              className="inline-flex items-center"
                            >
                              <SparklesIcon
                                className={styles.featuredIcon}
                                aria-label={t(
                                  'auth.modelSelection.featuredBadge',
                                )}
                              />
                            </span>
                          )}
                          {isItemDiscountActive(model) && (
                            <span
                              title={
                                model.discountPercent != null
                                  ? t(
                                      'auth.modelSelection.discountedPercentTitle',
                                      { percent: model.discountPercent },
                                    )
                                  : t(
                                      'auth.modelSelection.discountedPricingTitle',
                                    )
                              }
                              className="inline-flex items-center"
                            >
                              <TagIcon
                                className={styles.discountIcon}
                                aria-label={t(
                                  'auth.modelSelection.discountAvailable',
                                )}
                              />
                            </span>
                          )}
                          {model.hasPriority && (
                            <span
                              title={t('auth.modelSelection.priorityTitle')}
                              className="inline-flex items-center"
                            >
                              <ZapIcon
                                className={styles.priorityIcon}
                                aria-label={t(
                                  'auth.modelSelection.priorityBadge',
                                )}
                              />
                            </span>
                          )}
                          {model.hasFlex && (
                            <span
                              title={t('auth.modelSelection.flexTitle')}
                              className="inline-flex items-center"
                            >
                              <ClockIcon
                                className={styles.flexIcon}
                                aria-label={t('auth.modelSelection.flexBadge')}
                              />
                            </span>
                          )}
                        </div>
                        <div className={styles.modelMeta}>
                          <span>{model.type}</span>
                        </div>
                      </div>
                    </td>
                    <td>{formatContextTokens(model.maxTokens)}</td>
                    <td>
                      {model.quantization ? (
                        <span className={styles.badgeQuant}>
                          {model.quantization}
                        </span>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </td>
                    <td>
                      {model.centsPerInputToken != null ? (
                        <span className={styles.pricingIn}>
                          {formatPricePerMillion(model.centsPerInputToken)}
                        </span>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </td>
                    <td>
                      {model.centsPerOutputToken != null ? (
                        <span className={styles.pricingOut}>
                          {formatPricePerMillion(model.centsPerOutputToken)}
                        </span>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Selection Summary and Batch Actions */}
      <div className={styles.selectionSummary}>
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">
            {t('auth.modelSelection.selectedCount', {
              count: selectedIds.length,
            })}
          </span>
          {sortedModels.length > 0 && (
            <button
              type="button"
              className="text-xs text-blue-500 hover:underline cursor-pointer bg-transparent border-0 p-0"
              onClick={handleSelectAllFiltered}
              disabled={disabled}
            >
              {t('auth.modelSelection.selectAll')} ({sortedModels.length})
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground hover:underline cursor-pointer bg-transparent border-0 p-0"
              onClick={handleClearSelection}
              disabled={disabled}
            >
              {t('auth.modelSelection.deselectAll')}
            </button>
          )}
        </div>

        {selectedIds.length > 0 && (
          <div className={styles.selectedChips}>
            {selectedIds.map((id) => (
              <span key={id} className={styles.chip}>
                <span className={styles.chipText} title={id}>
                  {id}
                </span>
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={t('auth.modelSelection.removeModel', { id })}
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeModel(id);
                  }}
                >
                  <XIcon className="size-3" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Manual Input Field (Maintains full backward compatibility & custom models) */}
      <div className={styles.manualInputSection}>
        {defaultModelIds && (
          <div className={styles.manualPromptText}>
            {t('auth.modelsPrompt', { modelIds: defaultModelIds })}
          </div>
        )}
        <label htmlFor="model-ids-input" className={styles.manualInputLabel}>
          {t('auth.modelSelection.customPrompt')}
        </label>
        <Input
          ref={manualInputRef}
          id="model-ids-input"
          value={value}
          aria-label={t('auth.step.models')}
          disabled={disabled}
          autoFocus={autoFocus && !isDeepInfra}
          placeholder={defaultModelIds || t('auth.modelsPlaceholder')}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              onEnterPress?.();
            }
          }}
        />
      </div>
    </div>
  );
}
