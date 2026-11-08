import { sanitizeInsertText } from '../../hooks/useAtMentionSources';

export function formatFileName(name: string): string {
  return sanitizeInsertText(
    name.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, ''),
  );
}
