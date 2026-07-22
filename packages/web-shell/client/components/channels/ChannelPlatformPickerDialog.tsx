/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { SearchIcon } from 'lucide-react';
import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import styles from './ChannelsManagerPage.module.css';
import { isChannelPlatformAvailable } from './channel-platform';

interface ChannelPlatformPickerDialogProps {
  open: boolean;
  catalog: readonly DaemonChannelTypeDescriptor[];
  onOpenChange: (open: boolean) => void;
  onSelect: (descriptor: DaemonChannelTypeDescriptor) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function platformMark(descriptor: DaemonChannelTypeDescriptor): string {
  return descriptor.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function ChannelPlatformPickerDialog({
  open,
  catalog,
  onOpenChange,
  onSelect,
  returnFocusRef,
}: ChannelPlatformPickerDialogProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const platforms = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return catalog
      .filter(isChannelPlatformAvailable)
      .filter(
        (descriptor) =>
          !normalized ||
          descriptor.displayName.toLocaleLowerCase().includes(normalized) ||
          descriptor.type.toLocaleLowerCase().includes(normalized),
      );
  }, [catalog, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('channels.platformPicker.title')}</DialogTitle>
          <DialogDescription>
            {t('channels.platformPicker.description')}
          </DialogDescription>
        </DialogHeader>
        <label className={styles.platformSearch}>
          <SearchIcon aria-hidden="true" />
          <span className="sr-only">{t('channels.platformPicker.search')}</span>
          <Input
            value={query}
            placeholder={t('channels.platformPicker.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {platforms.length > 0 ? (
          <div className={styles.platformGrid}>
            {platforms.map((descriptor) => (
              <button
                key={descriptor.type}
                type="button"
                className={styles.platformCard}
                aria-label={descriptor.displayName}
                onClick={() => onSelect(descriptor)}
              >
                <span className={styles.platformMark} aria-hidden="true">
                  {platformMark(descriptor)}
                </span>
                <span className={styles.platformName}>
                  {descriptor.displayName}
                </span>
                <span className={styles.platformAuth}>
                  {descriptor.auth.includes('qr') &&
                  descriptor.auth.includes('credentials')
                    ? t('channels.platformPicker.auth.qrOrCredentials')
                    : descriptor.auth.includes('qr')
                      ? t('channels.platformPicker.auth.qr')
                      : t('channels.platformPicker.auth.credentials')}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('channels.platformPicker.empty')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
