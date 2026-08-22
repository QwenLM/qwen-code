import { isTrustedRendererFrameUrl } from './voice/frame-trust';

export interface DefaultSessionClipboardRequest {
  permission: string;
  isMainFrame: boolean;
  isWorkspaceWindow: boolean;
  requestingUrl: string | undefined;
  devServerUrl: string | undefined;
}

export function canUseDefaultSessionClipboard({
  permission,
  isMainFrame,
  isWorkspaceWindow,
  requestingUrl,
  devServerUrl,
}: DefaultSessionClipboardRequest): boolean {
  return (
    permission === 'clipboard-sanitized-write' &&
    isMainFrame &&
    isWorkspaceWindow &&
    isTrustedRendererFrameUrl(requestingUrl, devServerUrl)
  );
}
