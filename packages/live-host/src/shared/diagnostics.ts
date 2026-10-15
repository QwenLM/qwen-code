export function isLiveHostDiagnosticsEnabled(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    environment['QWEN_LIVE_DIAGNOSTICS'] === '1' ||
    argv.includes('--live-debug') ||
    argv.includes('--qwen-live-debug')
  );
}
