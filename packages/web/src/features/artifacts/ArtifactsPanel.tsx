import { useEffect, useMemo, useState } from 'react';
import { ResourceState } from '../common/ResourceState';
import type { WebArtifact, WebArtifactOperation } from './artifactTypes';
import { useWebArtifacts } from './useWebArtifacts';

interface ArtifactsPanelProps {
  initialPath?: string;
  onAddToChat?: (text: string) => void;
  onOpenFile?: (path: string) => void;
  onPathChange?: (path: string) => void;
}

type OperationFilter = WebArtifactOperation | 'all' | 'writes';

const OPERATION_FILTERS: Array<{ label: string; value: OperationFilter }> = [
  { label: 'All activity', value: 'all' },
  { label: 'Writes', value: 'writes' },
  { label: 'Produced', value: 'produced' },
  { label: 'Modified', value: 'modified' },
  { label: 'Read', value: 'read' },
  { label: 'Referenced', value: 'referenced' },
];

export function ArtifactsPanel({
  initialPath,
  onAddToChat,
  onOpenFile,
  onPathChange,
}: ArtifactsPanelProps) {
  const { artifacts, error, loading, reload, source } = useWebArtifacts();
  const [query, setQuery] = useState('');
  const [operation, setOperation] = useState<OperationFilter>('all');
  const [selectedPath, setSelectedPath] = useState(initialPath);

  useEffect(() => {
    setSelectedPath(initialPath);
  }, [initialPath]);

  const filteredArtifacts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return artifacts.filter((artifact) => {
      const matchesQuery = normalizedQuery
        ? `${artifact.path} ${artifact.title ?? ''} ${artifact.toolName ?? ''}`
            .toLowerCase()
            .includes(normalizedQuery)
        : true;
      return matchesQuery && matchesOperation(artifact, operation);
    });
  }, [artifacts, operation, query]);

  const selectedArtifact = useMemo(() => {
    if (selectedPath) {
      return artifacts.find((artifact) => artifact.path === selectedPath);
    }
    return filteredArtifacts[0];
  }, [artifacts, filteredArtifacts, selectedPath]);

  function selectArtifact(path: string) {
    setSelectedPath(path);
    onPathChange?.(path);
  }

  return (
    <div className="web-panel artifacts-panel">
      <div className="web-panel-header">
        <div>
          <h2>Artifacts</h2>
          <p>
            {filteredArtifacts.length} / {artifacts.length} inferred from{' '}
            {source === 'transcript' ? 'transcript tools' : source}
          </p>
        </div>
        <button type="button" onClick={() => void reload()}>
          Refresh
        </button>
      </div>

      <div className="web-filter-bar">
        <input
          aria-label="Search artifacts"
          name="artifact-search"
          placeholder="Search path, tool, or title"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Filter artifact operation"
          value={operation}
          onChange={(event) =>
            setOperation(event.target.value as OperationFilter)
          }
        >
          {OPERATION_FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
      </div>

      <div className="web-action-result">
        当前只从工具转录推断近期文件活动，diff 和完整 artifact index 需要后续
        daemon API。
      </div>

      <ResourceState
        loading={loading}
        error={error}
        empty={filteredArtifacts.length === 0}
        emptyText="No artifacts match the current filters."
      >
        <div className="artifacts-layout">
          <div className="web-list artifacts-list">
            {filteredArtifacts.map((artifact) => (
              <ArtifactCard
                artifact={artifact}
                key={artifact.path}
                selected={artifact.path === selectedArtifact?.path}
                onAddToChat={onAddToChat}
                onOpenFile={onOpenFile}
                onSelect={selectArtifact}
              />
            ))}
          </div>
          <ArtifactDetail
            artifact={selectedArtifact}
            requestedPath={selectedPath}
            onAddToChat={onAddToChat}
            onOpenFile={onOpenFile}
          />
        </div>
      </ResourceState>
    </div>
  );
}

function ArtifactCard({
  artifact,
  onAddToChat,
  onOpenFile,
  onSelect,
  selected,
}: {
  artifact: WebArtifact;
  onAddToChat: ((text: string) => void) | undefined;
  onOpenFile: ((path: string) => void) | undefined;
  onSelect: (path: string) => void;
  selected: boolean;
}) {
  return (
    <article
      className={
        selected ? 'web-card current artifact-card' : 'web-card artifact-card'
      }
    >
      <div className="web-card-main">
        <div className="artifact-title-row">
          <span className={`artifact-op artifact-op-${artifact.operation}`}>
            {operationLabel(artifact.operation)}
          </span>
          <h3>{artifact.path}</h3>
        </div>
        <p>
          {artifact.title ?? artifact.toolName ?? 'Transcript tool activity'}
        </p>
        <div className="web-meta">
          <span>{formatArtifactTime(artifact.updatedAt)}</span>
          {artifact.toolName ? <span>{artifact.toolName}</span> : null}
          {artifact.readCount ? <span>{artifact.readCount} reads</span> : null}
          {artifact.writeCount ? (
            <span>{artifact.writeCount} writes</span>
          ) : null}
        </div>
      </div>
      <div className="web-card-actions">
        <button type="button" onClick={() => onSelect(artifact.path)}>
          Details
        </button>
        {onOpenFile ? (
          <button type="button" onClick={() => onOpenFile(artifact.path)}>
            Open file
          </button>
        ) : null}
        {onAddToChat ? (
          <button
            type="button"
            onClick={() => onAddToChat(`@${artifact.path} `)}
          >
            Add to chat
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ArtifactDetail({
  artifact,
  onAddToChat,
  onOpenFile,
  requestedPath,
}: {
  artifact: WebArtifact | undefined;
  onAddToChat: ((text: string) => void) | undefined;
  onOpenFile: ((path: string) => void) | undefined;
  requestedPath: string | undefined;
}) {
  if (!artifact) {
    return (
      <aside className="artifact-detail web-card">
        <div className="web-card-main">
          <h3>
            {requestedPath ? 'Artifact not found' : 'No artifact selected'}
          </h3>
          <p>
            {requestedPath
              ? `No transcript-inferred artifact matches ${requestedPath}.`
              : 'Select a file activity item to inspect it.'}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="artifact-detail web-card">
      <div className="web-card-main">
        <div className="artifact-title-row">
          <span className={`artifact-op artifact-op-${artifact.operation}`}>
            {operationLabel(artifact.operation)}
          </span>
          <h3>{artifact.path}</h3>
        </div>
        <p>{artifact.title ?? 'Inferred from transcript tool output.'}</p>
        <dl className="web-detail-grid">
          <div>
            <dt>Path</dt>
            <dd>{artifact.path}</dd>
          </div>
          <div>
            <dt>Operation</dt>
            <dd>{operationLabel(artifact.operation)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatArtifactTime(artifact.updatedAt)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{artifact.source}</dd>
          </div>
          <div>
            <dt>Tool</dt>
            <dd>{artifact.toolName ?? 'unknown'}</dd>
          </div>
          <div>
            <dt>Activity</dt>
            <dd>
              {artifact.readCount ?? 0} reads / {artifact.writeCount ?? 0}{' '}
              writes
            </dd>
          </div>
        </dl>
        <div className="artifact-detail-actions">
          {onOpenFile ? (
            <button type="button" onClick={() => onOpenFile(artifact.path)}>
              Open in Files
            </button>
          ) : null}
          {onAddToChat ? (
            <>
              <button
                type="button"
                onClick={() => onAddToChat(`@${artifact.path} `)}
              >
                Add to Chat
              </button>
              <button
                type="button"
                onClick={() => onAddToChat(`解释 @${artifact.path} `)}
              >
                Explain
              </button>
            </>
          ) : null}
        </div>
        <div className="artifact-diff-placeholder">
          <strong>Diff placeholder</strong>
          <p>
            当前 Web-only 版本没有 daemon 结构化 diff；这里只展示文件活动线索。
          </p>
        </div>
      </div>
    </aside>
  );
}

function matchesOperation(
  artifact: WebArtifact,
  operation: OperationFilter,
): boolean {
  if (operation === 'all') return true;
  if (operation === 'writes') {
    return (
      artifact.operation === 'modified' || artifact.operation === 'produced'
    );
  }
  return artifact.operation === operation;
}

function operationLabel(operation: WebArtifactOperation) {
  switch (operation) {
    case 'produced':
      return 'Produced';
    case 'modified':
      return 'Modified';
    case 'read':
      return 'Read';
    case 'referenced':
      return 'Referenced';
    default:
      return 'Unknown';
  }
}

function formatArtifactTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}
