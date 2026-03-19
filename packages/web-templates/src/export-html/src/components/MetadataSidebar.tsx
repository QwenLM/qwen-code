import type { ExportMetadata } from './types.js';
import { MetadataItem } from './MetadataItem.js';
import {
  formatRelativeTime,
  formatExportTime,
  formatTokenLimit,
} from './utils.js';

export type MetadataSidebarProps = {
  metadata: ExportMetadata;
};

export const MetadataSidebar = ({ metadata }: MetadataSidebarProps) => (
  <aside className="metadata-sidebar">
    <div className="metadata-section">
      <h3 className="metadata-section-title">Session Info</h3>
      <MetadataItem
        label="Session created"
        value={formatRelativeTime(metadata.startTime)}
      />
      <MetadataItem
        label="Project"
        value={metadata.cwd}
        valueClass="multiline"
      />
      {metadata.gitRepo && (
        <MetadataItem label="Repository" value={metadata.gitRepo} />
      )}
      {metadata.gitBranch && (
        <MetadataItem label="Branch" value={metadata.gitBranch} />
      )}
      {metadata.model && <MetadataItem label="Model" value={metadata.model} />}
      {metadata.channel && (
        <MetadataItem label="Channel" value={metadata.channel} />
      )}
    </div>

    <div className="metadata-section">
      <h3 className="metadata-section-title">Statistics</h3>
      <MetadataItem label="Prompts" value={metadata.promptCount} />
      {metadata.contextUsagePercent !== undefined &&
        metadata.contextWindowSize !== undefined && (
          <MetadataItem
            label="Context"
            value={`${metadata.contextUsagePercent}% of ${formatTokenLimit(metadata.contextWindowSize)}`}
          />
        )}
      {metadata.totalTokens !== undefined && (
        <MetadataItem
          label="Tokens"
          value={metadata.totalTokens.toLocaleString()}
        />
      )}
    </div>

    <div className="metadata-section">
      <h3 className="metadata-section-title">File Operations</h3>
      {metadata.filesWritten !== undefined && metadata.filesWritten > 0 && (
        <MetadataItem label="Files modified" value={metadata.filesWritten} />
      )}
      {metadata.linesAdded !== undefined && metadata.linesAdded > 0 && (
        <MetadataItem
          label="Added"
          value={`+${metadata.linesAdded}`}
          valueClass="text-green"
        />
      )}
      {metadata.linesRemoved !== undefined && metadata.linesRemoved > 0 && (
        <MetadataItem
          label="Removed"
          value={`-${metadata.linesRemoved}`}
          valueClass="text-red"
        />
      )}
      {(metadata.filesWritten === undefined || metadata.filesWritten === 0) &&
        (metadata.linesAdded === undefined || metadata.linesAdded === 0) &&
        (metadata.linesRemoved === undefined ||
          metadata.linesRemoved === 0) && (
          <p className="metadata-item metadata-item-empty">No file changes</p>
        )}
    </div>

    <div className="metadata-section metadata-section-small">
      <MetadataItem
        label="Session ID"
        value={metadata.sessionId}
        valueClass="font-mono"
      />
      <MetadataItem
        label="Export Time"
        value={formatExportTime(metadata.exportTime)}
      />
    </div>
  </aside>
);
