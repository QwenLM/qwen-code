import { useEffect, useState } from 'react';

export function usePanelActive(eventName: string): boolean {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; active?: boolean }>)
        .detail;
      if (!detail?.id && detail?.active === false) {
        setActiveId(null);
        return;
      }
      if (!detail?.id) return;
      if (detail.active) {
        setActiveId(detail.id);
      } else {
        setActiveId((current) => (current === detail.id ? null : current));
      }
    };
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [eventName]);

  return activeId !== null;
}
