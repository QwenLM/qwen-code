/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '../components/ui/button';
import { useI18n } from '../i18n';

export function LiveVoiceMenuItem({
  className,
  onClick,
}: {
  className?: string;
  onClick: () => void;
}) {
  const { t } = useI18n();

  return (
    <Button variant="ghost" className={className} onClick={onClick}>
      {t('live.open')}
    </Button>
  );
}
