export function isAutomaticTriggerSource(
  source?: string,
): source is 'cron' | 'loop' {
  return source === 'cron' || source === 'loop';
}

export function isDetailFreeAutomaticEcho(content: string): boolean {
  // Unknown shapes keep their full display text; only echo-only runtime labels are suppressed.
  return /^(Autonomous loop tick|Loop tick — tasks from (project|home) loop\.md|Loop tick — loop\.md temporarily unavailable)$/.test(
    content.trim(),
  );
}
