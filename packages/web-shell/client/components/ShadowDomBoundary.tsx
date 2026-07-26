import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { installWebShellShadowStyles } from '../shadowDom';

interface ShadowDomBoundaryProps {
  children: ReactNode;
  enabled: boolean;
  language: string;
  themeClassName: string;
  styles?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function ShadowDomBoundary({
  children,
  enabled,
  language,
  themeClassName,
  styles,
  initialFocusRef,
}: ShadowDomBoundaryProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !hostRef.current) return;
    hostRef.current.style.setProperty('all', 'initial', 'important');
    hostRef.current.style.setProperty('display', 'block', 'important');
    hostRef.current.style.setProperty('min-width', '0', 'important');
    hostRef.current.style.setProperty('width', '100%', 'important');
    const root =
      hostRef.current.shadowRoot ??
      hostRef.current.attachShadow({ mode: 'open' });
    const nextMount = root.ownerDocument.createElement('div');
    nextMount.dataset.webShellRoot = '';
    nextMount.dataset.webShellShadcn = '';
    nextMount.dataset.webShellShadowRoot = 'plugins';
    const removeStyles = installWebShellShadowStyles(root, styles);
    root.appendChild(nextMount);
    setMount(nextMount);
    return () => {
      nextMount.remove();
      removeStyles();
      setMount(null);
    };
  }, [enabled, styles]);

  useLayoutEffect(() => {
    if (!mount) return;
    mount.className = themeClassName;
    mount.lang = language;
  }, [language, mount, themeClassName]);

  useLayoutEffect(() => {
    if (mount) initialFocusRef?.current?.focus();
  }, [initialFocusRef, mount]);

  if (!enabled) return children;

  return (
    <div ref={hostRef} data-web-shell-shadow-host="plugins">
      {mount ? createPortal(children, mount) : null}
    </div>
  );
}
