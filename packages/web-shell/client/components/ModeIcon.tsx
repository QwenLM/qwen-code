import type { CSSProperties } from 'react';

import autoIconUrl from '../assets/icons/auto.svg';
import defaultIconUrl from '../assets/icons/default.svg';
import editIconUrl from '../assets/icons/edit.svg';
import planIconUrl from '../assets/icons/plan.svg';
import yoloIconUrl from '../assets/icons/yolo.svg';
import styles from './ModeIcon.module.css';

const modeIconUrls: Record<string, string> = {
  auto: autoIconUrl,
  'auto-edit': editIconUrl,
  default: defaultIconUrl,
  plan: planIconUrl,
  yolo: yoloIconUrl,
};

type ModeIconMaskStyle = CSSProperties & {
  '--mode-icon-url': string;
};

function modeIconMaskStyle(iconUrl: string): ModeIconMaskStyle {
  return {
    '--mode-icon-url': `url("${iconUrl}")`,
  } as ModeIconMaskStyle;
}

export function ModeIcon({ mode }: { mode: string }) {
  const iconUrl = modeIconUrls[mode];

  if (iconUrl) {
    return (
      <span
        className={styles.icon}
        style={modeIconMaskStyle(iconUrl)}
        aria-hidden="true"
      />
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 18c.7-2.7 2.2-4 4.5-4H12M7 6h10M7 10h7M17.5 14.5l2 2-2 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
