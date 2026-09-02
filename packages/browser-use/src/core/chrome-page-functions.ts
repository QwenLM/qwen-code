/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Functions serialized into Runtime.callFunctionOn for element-level operations. */
export const HIT_TARGET_FUNCTION = `function (x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return "nothing";
  if (hit === this || this.contains(hit)) return "ok";
  const hitLabel = hit.closest("label");
  if (hitLabel && (hitLabel.control === this || hitLabel.contains(this))) return "ok";
  const ownLabel = this.closest("label");
  if (ownLabel && ownLabel.control === hit) return "ok";
  const classes = typeof hit.className === "string" && hit.className.trim() ? "." + hit.className.trim().split(/\\s+/).slice(0, 3).join(".") : "";
  return hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + classes;
}`;

export const CHECK_STATE_FUNCTION = `function () {
  if (this instanceof HTMLInputElement && (this.type === "checkbox" || this.type === "radio")) return { kind: "checkable", checked: this.checked };
  const aria = this.getAttribute("aria-checked");
  const role = this.getAttribute("role") || "";
  if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role) || aria !== null) return { kind: "checkable", checked: aria === "true" };
  return { kind: "other" };
}`;

export const ELEMENT_KIND_FUNCTION = `function () {
  if (this instanceof HTMLInputElement && this.type === "file") return "file";
  return this.tagName.toLowerCase();
}`;

export const SCROLL_STATE_FUNCTION = `function () {
  /* __qwenBrowserScrollState */
  const positions = [];
  const seen = new Set();
  const record = (element, force) => {
    if (!(element instanceof Element) || seen.has(element)) return;
    const style = getComputedStyle(element);
    const scrollableX = element.scrollWidth > element.clientWidth && /^(auto|scroll|overlay)$/.test(style.overflowX);
    const scrollableY = element.scrollHeight > element.clientHeight && /^(auto|scroll|overlay)$/.test(style.overflowY);
    if (!force && !scrollableX && !scrollableY) return;
    seen.add(element);
    positions.push({
      left: Math.round(element.scrollLeft),
      top: Math.round(element.scrollTop),
      width: element.scrollWidth,
      height: element.scrollHeight,
    });
  };
  for (let current = this instanceof Element ? this : null; current; current = current.parentElement) record(current, false);
  record(document.scrollingElement, true);
  return positions;
}`;

export const SCROLL_FALLBACK_FUNCTION = `function (deltaX, deltaY) {
  /* __qwenBrowserScrollFallback */
  const x = Number(deltaX) || 0;
  const y = Number(deltaY) || 0;
  const supportsRequestedAxis = (element) => {
    const style = getComputedStyle(element);
    const scrollableX = x !== 0 && element.scrollWidth > element.clientWidth && /^(auto|scroll|overlay)$/.test(style.overflowX);
    const scrollableY = y !== 0 && element.scrollHeight > element.clientHeight && /^(auto|scroll|overlay)$/.test(style.overflowY);
    return scrollableX || scrollableY;
  };
  let target = this instanceof Element ? this : null;
  while (target && !supportsRequestedAxis(target)) target = target.parentElement;
  target ||= document.scrollingElement;
  if (!(target instanceof Element)) return false;
  const beforeLeft = target.scrollLeft;
  const beforeTop = target.scrollTop;
  target.scrollLeft = beforeLeft + x;
  target.scrollTop = beforeTop + y;
  return target.scrollLeft !== beforeLeft || target.scrollTop !== beforeTop;
}`;
