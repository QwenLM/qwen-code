/** @sentry/electron/renderer shim — no-op for browser builds. */
export function init(..._args: any[]) {}
export const captureException = () => {}
export const captureMessage = () => {}
export const ErrorBoundary = ({ children }: { children: React.ReactNode; fallback?: React.ReactNode }) => children
