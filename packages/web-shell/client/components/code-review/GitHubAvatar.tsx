import { useState } from 'react';
import { UsersIcon } from 'lucide-react';
import styles from './CodeReviewPage.module.css';

export function GitHubAvatar({
  login,
  src,
  team = false,
  className = styles.avatar,
}: {
  login: string;
  src?: string;
  team?: boolean;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const imageSrc = src?.startsWith('https://') ? src : undefined;
  return (
    <span className={className} aria-hidden="true">
      {imageSrc && imageSrc !== failedSrc ? (
        <img
          key={imageSrc}
          src={imageSrc}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(imageSrc)}
        />
      ) : team ? (
        <UsersIcon size={14} />
      ) : (
        (login || '?').slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
