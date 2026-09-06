export function trimDialogLabel(label: string): string {
  return label.replace(/[：:\s]+$/u, '');
}
