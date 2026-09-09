import { memo, useMemo } from 'react';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { splitTextByUrls } from '../../utils/linkify';
import { isSafeHref } from './Markdown';
import styles from './UserMessage.module.css';

/**
 * Plain-text renderer that turns explicit http(s) URLs into anchors. Mirrors
 * MarkdownLink's safety (`isSafeHref`) and desktop-shell routing
 * (`useExternalLinkOpener`); text without URLs passes through untouched.
 */
export const LinkifiedText = memo(function LinkifiedText({
  text,
}: {
  text: string;
}) {
  const openExternalLink = useExternalLinkOpener();
  const segments = useMemo(() => splitTextByUrls(text), [text]);
  if (segments.every((segment) => segment.type === 'text')) {
    return text;
  }
  return segments.map((segment, index) => {
    if (segment.type === 'text') return segment.value;
    const safeHref = isSafeHref(segment.value) ? segment.value : undefined;
    return (
      <a
        key={index}
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.link}
        onClick={(event) => openExternalLink(event, safeHref)}
      >
        {segment.value}
      </a>
    );
  });
});
