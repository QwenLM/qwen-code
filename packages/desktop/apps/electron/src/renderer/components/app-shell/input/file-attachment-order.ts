const FILE_ORDER_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function sortFilesForAttachmentInput(files: File[]): File[] {
  return [...files].sort(
    (a, b) =>
      FILE_ORDER_COLLATOR.compare(a.name, b.name) ||
      a.lastModified - b.lastModified,
  );
}
