import extensionIconUrl from '../assets/icons/at-extension.svg';
import fileIconUrl from '../assets/icons/at-file.svg';
import mcpIconUrl from '../assets/icons/at-mcp.svg';
import skillIconUrl from '../assets/icons/at-skill.svg';
import type {
  WebShellBuiltinComposerTagKind,
  WebShellComposerTagIconMap,
  WebShellComposerTagKind,
} from '../customization';

const builtinTagIconUrls: Record<WebShellBuiltinComposerTagKind, string> = {
  extension: extensionIconUrl,
  file: fileIconUrl,
  mcp: mcpIconUrl,
  skill: skillIconUrl,
};

function getOwnIconUrl(
  iconUrls: WebShellComposerTagIconMap | undefined,
  kind: string,
): string | undefined {
  if (!iconUrls || !Object.prototype.hasOwnProperty.call(iconUrls, kind)) {
    return undefined;
  }
  const iconUrl = iconUrls[kind];
  return typeof iconUrl === 'string' ? iconUrl : undefined;
}

export function getComposerTagIconUrl(
  kind: WebShellComposerTagKind | undefined,
  customIconUrls?: WebShellComposerTagIconMap,
): string | undefined {
  if (!kind) return undefined;
  return (
    getOwnIconUrl(customIconUrls, kind) ??
    getOwnIconUrl(builtinTagIconUrls, kind)
  );
}
