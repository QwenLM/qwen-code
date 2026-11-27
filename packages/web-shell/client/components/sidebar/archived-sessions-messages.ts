/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { plural, ruPlural } from '../../utils/plural.js';

type MessageEntry =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const ARCHIVED_SESSIONS_MESSAGES_EN: Record<string, MessageEntry> = {
  'sidebar.archiveFilterAndSort': 'Filter and sort archived conversations',
  'sidebar.archiveType': 'Type',
  'sidebar.archiveTypeAll': 'All conversations',
  'sidebar.archiveTypeLocal': 'Local',
  'sidebar.archiveTypeCloud': 'Cloud',
  'sidebar.archivedSearchPlaceholder': 'Search archived conversations',
  'sidebar.clearSearch': 'Clear search',
  'sidebar.sortUpdated': 'Updated',
  'sidebar.sortCreated': 'Created',
  'sidebar.sortAlphabetical': 'Alphabetical',
  'sidebar.allWorkspaces': 'All workspaces',
  'sidebar.archivedCount': (v) => plural(v?.['count'], 'conversation'),
  'sidebar.archivedCountMore': (v) => `${v?.['count'] ?? 0}+ conversations`,
  'sidebar.archivedLoadMore': 'Load more',
  'sidebar.archivedFilteredEmpty': 'No matching archived conversations.',
  'sidebar.archivedWorkspaceEmpty':
    'No archived conversations in this workspace.',
  'sidebar.clearFilters': 'Clear filters',
  'sidebar.showAllWorkspaces': 'Show all workspaces',
  'sidebar.archivedPaginationHint':
    'Sorting applies to loaded conversations in each workspace. Load more to include older items.',
};

export const ARCHIVED_SESSIONS_MESSAGES_ZH: Record<string, MessageEntry> = {
  'sidebar.archiveFilterAndSort': '筛选与排序已归档对话',
  'sidebar.archiveType': '类型',
  'sidebar.archiveTypeAll': '全部对话',
  'sidebar.archiveTypeLocal': '本地',
  'sidebar.archiveTypeCloud': '云端',
  'sidebar.archivedSearchPlaceholder': '搜索已归档对话',
  'sidebar.clearSearch': '清除搜索',
  'sidebar.sortUpdated': '更新时间',
  'sidebar.sortCreated': '创建时间',
  'sidebar.sortAlphabetical': '按名称排序',
  'sidebar.allWorkspaces': '全部工作区',
  'sidebar.archivedCount': (v) => `${v?.['count'] ?? 0} 个会话`,
  'sidebar.archivedCountMore': (v) => `${v?.['count'] ?? 0}+ 个会话`,
  'sidebar.archivedLoadMore': '加载更多',
  'sidebar.archivedFilteredEmpty': '没有匹配的已归档对话。',
  'sidebar.archivedWorkspaceEmpty': '该工作区没有已归档对话。',
  'sidebar.clearFilters': '清除筛选',
  'sidebar.showAllWorkspaces': '显示全部工作区',
  'sidebar.archivedPaginationHint':
    '排序仅应用于各工作区当前已加载的对话，点击“加载更多”以包含更早的条目。',
};

export const ARCHIVED_SESSIONS_MESSAGES_RU: Record<string, MessageEntry> = {
  'sidebar.archiveFilterAndSort': 'Фильтрация и сортировка архивных диалогов',
  'sidebar.archiveType': 'Тип',
  'sidebar.archiveTypeAll': 'Все диалоги',
  'sidebar.archiveTypeLocal': 'Локальные',
  'sidebar.archiveTypeCloud': 'Облачные',
  'sidebar.archivedSearchPlaceholder': 'Поиск в архивных диалогах',
  'sidebar.clearSearch': 'Очистить поиск',
  'sidebar.sortUpdated': 'По обновлению',
  'sidebar.sortCreated': 'По дате создания',
  'sidebar.sortAlphabetical': 'По алфавиту',
  'sidebar.allWorkspaces': 'Все рабочие области',
  'sidebar.archivedCount': (v) =>
    ruPlural(v?.['count'], 'диалог', 'диалога', 'диалогов'),
  'sidebar.archivedCountMore': (v) => `${v?.['count'] ?? 0}+ диалогов`,
  'sidebar.archivedLoadMore': 'Загрузить ещё',
  'sidebar.archivedFilteredEmpty': 'Подходящих архивных диалогов не найдено.',
  'sidebar.archivedWorkspaceEmpty':
    'В этой рабочей области нет архивных диалогов.',
  'sidebar.clearFilters': 'Сбросить фильтры',
  'sidebar.showAllWorkspaces': 'Показать все рабочие области',
  'sidebar.archivedPaginationHint':
    'Сортировка применяется к загруженным диалогам в каждой рабочей области. Загрузите ещё, чтобы включить более ранние.',
};
