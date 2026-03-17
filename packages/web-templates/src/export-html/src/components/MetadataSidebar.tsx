import type { ExportMetadata } from './types.js';
import { MetadataItem } from './MetadataItem.js';
import { CopyButton } from './CopyButton.js';
import {
  formatRelativeTime,
  formatExportTime,
  formatPath,
  formatTokenLimit,
} from './utils.js';

export type MetadataSidebarProps = {
  metadata: ExportMetadata;
};

export const MetadataSidebar = ({ metadata }: MetadataSidebarProps) => {
  const uniqueFilesCount = metadata.uniqueFiles?.length ?? 0;

  return (
    <aside className="metadata-sidebar">
      <div className="metadata-section">
        <h3 className="metadata-section-title">Session Info</h3>
        <MetadataItem
          label="Session created"
          value={formatRelativeTime(metadata.startTime)}
        />
        <MetadataItem label="Project" value={formatPath(metadata.cwd)} />
        {metadata.gitRepo && (
          <MetadataItem label="Repository" value={metadata.gitRepo} />
        )}
        {metadata.gitBranch && (
          <MetadataItem label="Branch" value={metadata.gitBranch} />
        )}
        {metadata.model && (
          <MetadataItem label="Model" value={metadata.model} />
        )}
        {metadata.channel && (
          <MetadataItem label="Channel" value={metadata.channel} />
        )}
      </div>

      <div className="metadata-section">
        <h3 className="metadata-section-title">Statistics</h3>
        <MetadataItem label="Prompts" value={metadata.promptCount} />
        {metadata.contextUsagePercent !== undefined && (
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
        <MetadataItem label="Files" value={uniqueFilesCount} />
      </div>

      <div className="metadata-section">
        <h3 className="metadata-section-title">File Operations</h3>
        {metadata.filesRead !== undefined && metadata.filesRead > 0 && (
          <MetadataItem label="Read" value={metadata.filesRead} />
        )}
        {metadata.filesWritten !== undefined && metadata.filesWritten > 0 && (
          <MetadataItem label="Written" value={metadata.filesWritten} />
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
      </div>

      <div className="metadata-section metadata-section-small">
        {metadata.requestId ? (
          <div className="metadata-item">
            <div className="metadata-content">
              <span className="metadata-label">Request Id</span>
              <div className="metadata-value-with-copy">
                <span className="metadata-value font-mono">
                  {metadata.requestId}
                </span>
                <CopyButton text={metadata.requestId} />
              </div>
            </div>
          </div>
        ) : (
          <MetadataItem
            label="Session ID"
            value={metadata.sessionId}
            valueClass="font-mono"
          />
        )}
        <MetadataItem
          label="Export Time"
          value={formatExportTime(metadata.exportTime)}
        />
      </div>
    </aside>
  );
};
