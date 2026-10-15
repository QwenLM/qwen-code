export interface PrependSkillTransaction {
  changes: { from: 0; to: 0; insert: string };
  selection: { anchor: number };
  scrollIntoView: true;
}

export function computePrependSkillTransaction(
  currentDoc: string,
  invocation: string,
): PrependSkillTransaction | null {
  const insert = `${invocation} `;
  if (currentDoc === invocation || currentDoc.startsWith(insert)) {
    return null;
  }
  return {
    changes: { from: 0, to: 0, insert },
    selection: { anchor: insert.length },
    scrollIntoView: true,
  };
}
