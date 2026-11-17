import type { LiveHostApi } from '../shared/host-api.ts';

export function makeOverlayDraggable(
  element: HTMLElement,
  api: Pick<LiveHostApi, 'dragOverlay'>,
): void {
  element.dataset.liveDrag = '';
  let start: { x: number; y: number; id: number } | undefined;
  let last = { x: 0, y: 0 };
  let dragging = false;
  element.addEventListener('pointerdown', (event) => {
    const target =
      event.target instanceof element.ownerDocument.defaultView!.Element
        ? event.target.closest(
            'button, input, select, textarea, a, [contenteditable]',
          )
        : null;
    if (event.button !== 0) return;
    if (target && target !== element) {
      dragging = false;
      return;
    }
    start = { x: event.screenX, y: event.screenY, id: event.pointerId };
    last = { x: event.screenX, y: event.screenY };
    dragging = false;
    element.setPointerCapture?.(event.pointerId);
  });
  element.addEventListener('pointermove', (event) => {
    if (!start || event.pointerId !== start.id) return;
    last = { x: event.screenX, y: event.screenY };
    if (
      !dragging &&
      Math.hypot(event.screenX - start.x, event.screenY - start.y) < 5
    )
      return;
    if (!dragging) {
      dragging = true;
      api.dragOverlay('start', start.x, start.y);
    }
    api.dragOverlay('move', event.screenX, event.screenY);
  });
  const end = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.id) return;
    start = undefined;
    if (dragging) {
      const position =
        event.type === 'pointerup'
          ? { x: event.screenX, y: event.screenY }
          : last;
      api.dragOverlay('end', position.x, position.y);
    }
    if (element.hasPointerCapture?.(event.pointerId))
      element.releasePointerCapture(event.pointerId);
  };
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
  element.addEventListener('lostpointercapture', end);
  element.addEventListener(
    'click',
    (event) => {
      if (dragging) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dragging = false;
      }
    },
    true,
  );
}
