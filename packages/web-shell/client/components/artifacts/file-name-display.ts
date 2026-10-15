import { sanitizeInsertText } from '../../hooks/useAtMentionSources';

export function formatFileName(name: string): string {
  return sanitizeInsertText(name.replace(/[\p{Cf}\u034f]/gu, ''));
}
