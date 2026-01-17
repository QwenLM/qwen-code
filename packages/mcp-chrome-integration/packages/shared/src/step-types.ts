// step-types.ts — centralized step type constants for UI + runtime

export const STEP_TYPES = {
  CLICK: 'click',
  DBLCLICK: 'dblclick',
  FILL: 'fill',
  TRIGGER_EVENT: 'triggerEvent',
  SET_ATTRIBUTE: 'setAttribute',
  SCREENSHOT: 'screenshot',
  SWITCH_FRAME: 'switchFrame',
  LOOP_ELEMENTS: 'loopElements',
  KEY: 'key',
  SCROLL: 'scroll',
  DRAG: 'drag',
  WAIT: 'wait',
  ASSERT: 'assert',
  SCRIPT: 'script',
  IF: 'if',
  FOREACH: 'foreach',
  WHILE: 'while',
  NAVIGATE: 'navigate',
  HTTP: 'http',
  EXTRACT: 'extract',
  OPEN_TAB: 'openTab',
  SWITCH_TAB: 'switchTab',
  CLOSE_TAB: 'closeTab',
  HANDLE_DOWNLOAD: 'handleDownload',
  EXECUTE_FLOW: 'executeFlow',
  // UI-only helpers
  TRIGGER: 'trigger',
  DELAY: 'delay',
} as const;

export type StepTypeConst = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];
