import { useEffect, useState } from 'react';

function readWebviewTheme(): 'light' | 'dark' {
  return document.body.classList.contains('vscode-light') ? 'light' : 'dark';
}

export function useWebviewTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(readWebviewTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readWebviewTheme()));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}
