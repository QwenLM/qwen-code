/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo, useCallback, useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  Search,
  X,
  RefreshCw,
  PanelLeftOpen,
  PanelLeftClose,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { QwenCodeBrand } from './ui/qwen-code-brand';
import { ThemeToggle } from './ui/theme-toggle';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from './ui/tooltip';
import type { Session } from '../../shared/types';

type Theme = 'light' | 'dark' | 'system';

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  version: string;
}

function formatRelativeTime(date: string | Date): string {
  const now = new Date();
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString();
}

export const Sidebar = memo(({
  sessions,
  currentSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onRefresh,
  isLoading: _isLoading,
  collapsed,
  onToggleCollapse,
  theme,
  onToggleTheme,
  version,
}: SidebarProps) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const query = searchQuery.toLowerCase();
    return sessions.filter((s) => s.title.toLowerCase().includes(query));
  }, [sessions, searchQuery]);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await Promise.resolve(onRefresh());
    } finally {
      setTimeout(() => setIsRefreshing(false), 500);
    }
  }, [onRefresh, isRefreshing]);

  const handleDeleteSession = useCallback(
    (sessionId: string, sessionTitle: string) => {
      const confirmed = window.confirm(
        `Delete session "${sessionTitle || 'Untitled'}"?`,
      );
      if (confirmed) {
        onDeleteSession(sessionId);
      }
    },
    [onDeleteSession],
  );

  // Collapsed sidebar
  if (collapsed) {
    return (
      <TooltipProvider>
        <aside className="flex h-full w-12 flex-col items-center border-r border-border bg-background py-3">
          {/* Logo */}
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600">
            <span className="text-white font-bold text-sm">Q</span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Footer actions */}
          <div className="flex flex-col items-center gap-2">
            <ThemeToggle
              theme={theme}
              onToggle={onToggleTheme}
              className="h-8 w-8"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Expand sidebar"
                  className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                  onClick={onToggleCollapse}
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          </div>
        </aside>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <aside className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          {/* Brand */}
          <div className="flex items-center justify-between px-4 pt-4">
            <QwenCodeBrand size="sm" showVersion={true} version={version} />
          </div>

          {/* Sessions header */}
          <div className="flex items-center justify-between px-3 pt-3">
            <h4 className="text-sm font-medium text-muted-foreground">
              Sessions
            </h4>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label="Refresh sessions"
                    className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    type="button"
                  >
                    <RefreshCw
                      className={cn(
                        'h-3.5 w-3.5',
                        isRefreshing && 'animate-spin',
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Refresh sessions</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label="New Session"
                    className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={onCreateSession}
                    type="button"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>New session</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Search */}
          <div className="px-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search sessions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto px-2 pb-4">
            {filteredSessions.length === 0 ? (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                {searchQuery ? 'No matching sessions' : 'No sessions yet'}
              </div>
            ) : (
              <ul className="space-y-1">
                {filteredSessions.map((session) => {
                  const isActive = session.id === currentSessionId;

                  return (
                    <li key={session.id} className="group relative">
                      <button
                        className={cn(
                          'w-full cursor-pointer text-left rounded-lg px-3 py-2.5 transition-colors',
                          isActive ? 'bg-secondary' : 'hover:bg-secondary/60',
                        )}
                        onClick={() => onSelectSession(session.id)}
                        type="button"
                      >
                        <p className="text-sm font-medium text-foreground truncate pr-6">
                          {session.title || 'Untitled'}
                        </p>
                        <span className="text-[10px] text-muted-foreground mt-0.5 block">
                          {formatRelativeTime(session.lastUpdated)}
                        </span>
                      </button>
                      {/* Delete button */}
                      <button
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md transition-all text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSession(session.id, session.title);
                        }}
                        title="Delete session"
                        type="button"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <span className="text-xs text-muted-foreground">
              {sessions.length} session{sessions.length !== 1 ? 's' : ''}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Collapse sidebar"
                className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                onClick={onToggleCollapse}
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Collapse sidebar</TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
});

Sidebar.displayName = 'Sidebar';
