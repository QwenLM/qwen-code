/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ComponentType } from 'react';
import {
  BlocksIcon,
  FileTextIcon,
  PlugIcon,
  RadioTowerIcon,
  SparklesIcon,
  WebhookIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  isOverviewFacetKnown,
  overviewFacetHasIssue,
  type WorkspaceOverviewItem,
  type WorkspaceOverviewSnapshot,
} from './workspaceOverviewModel';
import styles from './WorkspaceOverview.module.css';

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const ICONS: Record<WorkspaceOverviewItem, ComponentType<{ size?: number }>> = {
  mcp: PlugIcon,
  skills: SparklesIcon,
  extensions: BlocksIcon,
  channels: RadioTowerIcon,
  context: FileTextIcon,
  hooks: WebhookIcon,
};

/** The short value printed on a chip, or `undefined` while the facet is unknown. */
export function formatOverviewValue(
  snapshot: WorkspaceOverviewSnapshot | undefined,
  item: WorkspaceOverviewItem,
): string | undefined {
  if (!isOverviewFacetKnown(snapshot, item) || !snapshot) return undefined;
  switch (item) {
    case 'mcp': {
      const mcp = snapshot.mcp!;
      const enabled = mcp.configured - mcp.disabled;
      return enabled === 0 ? '0' : `${mcp.connected}/${enabled}`;
    }
    case 'skills':
      return String(snapshot.skills!.enabled);
    case 'extensions': {
      const ext = snapshot.extensions!;
      return ext.active === ext.total
        ? String(ext.total)
        : `${ext.active}/${ext.total}`;
    }
    case 'channels': {
      const ch = snapshot.channels!;
      return ch.configured === 0 ? '0' : `${ch.connected}/${ch.configured}`;
    }
    case 'context':
      return String(snapshot.context!.fileCount);
    case 'hooks':
      return String(snapshot.hooks!.count);
    default:
      return undefined;
  }
}

interface WorkspaceOverviewProps {
  overview: WorkspaceOverviewSnapshot | undefined;
  items: readonly WorkspaceOverviewItem[];
  /** Narrow sidebar: icons and values only, no text labels. */
  compact?: boolean;
}

/**
 * Facet chips are read-only: the management entries live in the workspace
 * menu, which knows whether a page can be bound to this workspace. Keeping
 * chips out of the button role also keeps their accessible names from
 * colliding with the navigation buttons that share the same facet words.
 */
export function WorkspaceOverview({
  overview,
  items,
  compact = false,
}: WorkspaceOverviewProps) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div
      className={cx(styles.chips, compact && styles.chipsCompact)}
      role="list"
      aria-label={t('sidebar.overview.label')}
    >
      {items.map((item) => {
        const Icon = ICONS[item];
        const label = t(`sidebar.overview.${item}`);
        const value = formatOverviewValue(overview, item);
        const known = value !== undefined;
        const issue = overviewFacetHasIssue(overview, item);
        const detail = known
          ? overviewDetail(t, overview!, item)
          : t('sidebar.overview.unknown');
        const title = `${label}: ${detail}`;
        return (
          <div key={item} role="listitem" className={styles.chipItem}>
            <span
              className={cx(
                styles.chip,
                !known && styles.chipUnknown,
                issue && styles.chipIssue,
              )}
              title={title}
              aria-label={title}
              data-web-shell-workspace-overview={item}
            >
              <Icon size={12} aria-hidden="true" />
              {!compact && <span className={styles.chipLabel}>{label}</span>}
              <span className={styles.chipValue}>{value ?? '—'}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function overviewDetail(
  t: (key: string, vars?: Record<string, string | number>) => string,
  snapshot: WorkspaceOverviewSnapshot,
  item: WorkspaceOverviewItem,
): string {
  switch (item) {
    case 'mcp': {
      const mcp = snapshot.mcp!;
      return t('sidebar.overview.mcpDetail', {
        configured: mcp.configured,
        connected: mcp.connected,
        failed: mcp.failed,
        disabled: mcp.disabled,
      });
    }
    case 'skills': {
      const skills = snapshot.skills!;
      return t('sidebar.overview.skillsDetail', {
        total: skills.total,
        enabled: skills.enabled,
      });
    }
    case 'extensions': {
      const ext = snapshot.extensions!;
      return t('sidebar.overview.extensionsDetail', {
        total: ext.total,
        active: ext.active,
      });
    }
    case 'channels': {
      const ch = snapshot.channels!;
      return t('sidebar.overview.channelsDetail', {
        configured: ch.configured,
        connected: ch.connected,
        failed: ch.failed,
      });
    }
    case 'context': {
      const ctx = snapshot.context!;
      return t('sidebar.overview.contextDetail', {
        files: ctx.fileCount,
        rules: ctx.ruleCount,
      });
    }
    case 'hooks': {
      const hooks = snapshot.hooks!;
      return hooks.disabled
        ? t('sidebar.overview.hooksDisabled', { count: hooks.count })
        : t('sidebar.overview.hooksDetail', { count: hooks.count });
    }
    default:
      return '';
  }
}
