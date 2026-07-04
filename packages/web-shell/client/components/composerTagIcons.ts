import extensionIconUrl from '../assets/icons/at-extension.svg';
import fileIconUrl from '../assets/icons/at-file.svg';
import mcpIconUrl from '../assets/icons/at-mcp.svg';
import skillIconUrl from '../assets/icons/at-skill.svg';
import type { WebShellComposerTagKind } from '../customization';

const tagIconUrls: Record<WebShellComposerTagKind, string> = {
  extension: extensionIconUrl,
  file: fileIconUrl,
  mcp: mcpIconUrl,
  skill: skillIconUrl,
};

export function getComposerTagIconUrl(
  kind: WebShellComposerTagKind | undefined,
): string | undefined {
  return kind ? tagIconUrls[kind] : undefined;
}
