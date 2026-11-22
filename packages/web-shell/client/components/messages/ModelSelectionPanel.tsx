import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { DaemonAuthProviderDescriptor } from '@qwen-code/web-shell/daemon-react-sdk';
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
import { getDaemonAuthHeaders } from '../../config/daemon';
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
  deprecated?: boolean | null;
}

export interface ModelSelectionPanelProps {
  provider: DaemonAuthProviderDescriptor | null;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  onEnterPress?: () => void;
  defaultModelIds?: string;
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
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1024)}k`;
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
let deepinfraCache: ModelCatalogItem[] | null = null;

export function resetDeepinfraCacheForTest(): void {
  deepinfraCache = null;
}

type SortField = 'name' | 'context' | 'quant' | 'priceIn' | 'priceOut';
type SortDirection = 'asc' | 'desc';

export function ModelSelectionPanel({
  provider,
  value,
  onChange,
  disabled = false,
  onEnterPress,
  defaultModelIds = '',
}: ModelSelectionPanelProps): ReactNode {
  const { t } = useI18n();
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
  const [models, setModels] = useState<ModelCatalogItem[]>(() => {
    if (provider?.id === 'deepinfra' && deepinfraCache) {
      return deepinfraCache;
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
    if (
      typeof provider.baseUrl === 'string' &&
      provider.baseUrl.includes('deepinfra.com')
    ) {
      return true;
    }
    return false;
  }, [provider]);

  useEffect(() => {
    if (!isDeepInfra) return;
    if (deepinfraCache) {
      setModels(deepinfraCache);
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    setLoading(true);

    const loadModels = async () => {
      try {
        let rawList: DeepInfraRawModel[] | null = null;
        // 1. Try daemon proxy endpoint first
        try {
          const authHeaders = getDaemonAuthHeaders();
          const res = await fetch('/workspace/auth/deepinfra-models', {
            signal: controller.signal,
            headers: {
              ...(authHeaders ?? {}),
            },
          });
          if (res.ok) {
            rawList = (await res.json()) as DeepInfraRawModel[];
          }
        } catch {
          // Daemon endpoint not reachable or network error, fallback to direct API
        }

        // 2. If daemon endpoint didn't provide a list, try direct API
        if (!rawList || !Array.isArray(rawList)) {
          const res = await fetch(DEEPINFRA_MODELS_URL, {
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          rawList = (await res.json()) as DeepInfraRawModel[];
        }

        if (!isMounted) return;
        const catalog: ModelCatalogItem[] = rawList
          .filter(
            (item) =>
              !item.deprecated &&
              !item.model_name.toLowerCase().startsWith('anthropic/'),
          )
          .map((item) => {
            const tags = Array.isArray(item.tags) ? item.tags : [];
            const isFeatured =
              item.featured === true || tags.includes('featured');
            const hasFlex = tags.includes('flex');
            const hasPriority = tags.includes('priority');
            const discountVal = item.pricing?.discount;
            const hasDiscount =
              (typeof discountVal === 'number' && discountVal > 0) ||
              tags.includes('discount');
            const discountPercent =
              typeof discountVal === 'number' && discountVal > 0
                ? Math.round(discountVal * 100)
                : null;
            const centsIn = item.pricing?.cents_per_input_token ?? null;
            const centsOut = item.pricing?.cents_per_output_token ?? null;
            return {
              id: item.model_name,
              name: item.model_name,
              type: item.type || 'text-generation',
              maxTokens: item.max_tokens ?? null,
              quantization: item.quantization ?? null,
              tags,
              isFeatured,
              hasFlex,
              hasPriority,
              hasDiscount,
              discountPercent,
              centsPerInputToken: centsIn,
              centsPerOutputToken: centsOut,
              pricePerMillionInput: centsIn != null ? centsIn * 10000 : null,
              pricePerMillionOutput: centsOut != null ? centsOut * 10000 : null,
              description: item.description,
            };
          });

        deepinfraCache = catalog;
        setModels(catalog);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        console.warn(
          '[ModelSelectionPanel] Failed to fetch DeepInfra models:',
          err,
        );
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    void loadModels();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [isDeepInfra]);

  const selectedIds = useMemo(() => parseModelIds(value), [value]);

  useEffect(() => {
    if (!isDeepInfra || !value) return;
    const ids = parseModelIds(value);
    const cleaned = ids.filter(
      (id) => !id.toLowerCase().startsWith('anthropic/'),
    );
    if (cleaned.length !== ids.length) {
      onChange(cleaned.join(', '));
    }
  }, [isDeepInfra, value, onChange]);

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
      if (discountOnly && !model.hasDiscount) {
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
            className={styles.searchInput}
            placeholder="Search model name..."
            value={searchQuery}
            disabled={disabled}
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
            <SelectTrigger aria-label="Filter by type">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              {availableTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {type === 'all' ? 'All Types' : type}
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
            <SelectTrigger aria-label="Filter by quantization">
              <SelectValue placeholder="All Quants" />
            </SelectTrigger>
            <SelectContent>
              {availableQuants.map((quant) => (
                <SelectItem key={quant} value={quant}>
                  {quant === 'all' ? 'All Quants' : quant}
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
            <SelectTrigger aria-label="Filter by context window">
              <SelectValue placeholder="All contexts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">All Contexts</SelectItem>
              <SelectItem value="32000">≥ 32k tokens</SelectItem>
              <SelectItem value="64000">≥ 64k tokens</SelectItem>
              <SelectItem value="128000">≥ 128k tokens</SelectItem>
              <SelectItem value="200000">≥ 200k tokens</SelectItem>
              <SelectItem value="1000000">≥ 1024k tokens</SelectItem>
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
            title="Filter featured models"
          >
            <SparklesIcon className={styles.buttonIconFeatured} />
            <span>Featured</span>
          </button>

          <button
            type="button"
            className={`${styles.filterButton} ${discountOnly ? styles.filterButtonActive : ''}`}
            onClick={() => setDiscountOnly((prev) => !prev)}
            disabled={disabled}
            title="Filter discounted models"
          >
            <TagIcon className={styles.buttonIconDiscount} />
            <span>Discount</span>
          </button>

          <button
            type="button"
            className={`${styles.filterButton} ${priorityOnly ? styles.filterButtonActive : ''}`}
            onClick={() => setPriorityOnly((prev) => !prev)}
            disabled={disabled}
            title="Filter models supporting priority service tier"
          >
            <ZapIcon className={styles.buttonIconPriority} />
            <span>Priority</span>
          </button>

          <button
            type="button"
            className={`${styles.filterButton} ${flexOnly ? styles.filterButtonActive : ''}`}
            onClick={() => setFlexOnly((prev) => !prev)}
            disabled={disabled}
            title="Filter models supporting flex service tier"
          >
            <ClockIcon className={styles.buttonIconFlex} />
            <span>Flex</span>
          </button>
        </div>
      </div>

      {/* Model Table List */}
      <div className={styles.tableContainer}>
        {loading ? (
          <div className={styles.loadingNotice}>
            <Spinner />
            <span>Loading models...</span>
          </div>
        ) : sortedModels.length === 0 ? (
          <div className={styles.emptyNotice}>
            <span>No models found matching criteria.</span>
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
                    <span>Model</span>
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
                    <span>Context</span>
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
                    <span>Quant</span>
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
                    title="Sort by input price per million tokens"
                  >
                    <span>In ($/Mt)</span>
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
                    title="Sort by output price per million tokens"
                  >
                    <span>Out ($/Mt)</span>
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
                        aria-label={`Select ${model.name}`}
                      />
                    </td>
                    <td>
                      <div className={styles.modelNameCell}>
                        <div className={styles.modelHeaderRow}>
                          <span className={styles.modelName}>{model.name}</span>
                          {model.isFeatured && (
                            <span
                              title="Featured model"
                              className="inline-flex items-center"
                            >
                              <SparklesIcon
                                className={styles.featuredIcon}
                                aria-label="Featured model"
                              />
                            </span>
                          )}
                          {model.hasDiscount && (
                            <span
                              title={
                                model.discountPercent != null
                                  ? `Discounted (${model.discountPercent}% off)`
                                  : 'Discounted pricing available'
                              }
                              className="inline-flex items-center"
                            >
                              <TagIcon
                                className={styles.discountIcon}
                                aria-label="Discount available"
                              />
                            </span>
                          )}
                          {model.hasPriority && (
                            <span
                              title="Supports Priority Service Tier"
                              className="inline-flex items-center"
                            >
                              <ZapIcon
                                className={styles.priorityIcon}
                                aria-label="Priority tier"
                              />
                            </span>
                          )}
                          {model.hasFlex && (
                            <span
                              title="Supports Flex Service Tier"
                              className="inline-flex items-center"
                            >
                              <ClockIcon
                                className={styles.flexIcon}
                                aria-label="Flex tier"
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
            {selectedIds.length}{' '}
            {selectedIds.length === 1 ? 'model selected' : 'models selected'}
          </span>
          {sortedModels.length > 0 && (
            <button
              type="button"
              className="text-xs text-blue-500 hover:underline cursor-pointer bg-transparent border-0 p-0"
              onClick={handleSelectAllFiltered}
              disabled={disabled}
            >
              Select all visible ({sortedModels.length})
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground hover:underline cursor-pointer bg-transparent border-0 p-0"
              onClick={handleClearSelection}
              disabled={disabled}
            >
              Clear all
            </button>
          )}
        </div>

        {selectedIds.length > 0 && (
          <div className={styles.selectedChips}>
            {selectedIds.map((id) => (
              <span key={id} className={styles.chip}>
                <span>{id}</span>
                <XIcon
                  className={`size-3 ${styles.chipRemove}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeModel(id);
                  }}
                />
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
          Selected Model IDs (comma-separated or type custom model):
        </label>
        <Input
          id="model-ids-input"
          value={value}
          aria-label={t('auth.step.models')}
          disabled={disabled}
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
