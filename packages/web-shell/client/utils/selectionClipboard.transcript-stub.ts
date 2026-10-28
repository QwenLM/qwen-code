export function getSelectedReplyText(body: HTMLElement): string {
  return (body.textContent ?? '').replace(/^\n+|\n+$/g, '');
}
