import type { ManagedSideQueryKind } from './managed-side-query-types';

export function managedSideQueryCommand(text: string):
  | {
      kind: ManagedSideQueryKind;
      argument: string;
    }
  | undefined {
  const match = /^\s*\/(btw|recap)(?=\s|$)([\s\S]*)$/i.exec(text);
  if (!match) return undefined;
  return {
    kind: match[1].toLowerCase() as ManagedSideQueryKind,
    argument: match[2].trim(),
  };
}
