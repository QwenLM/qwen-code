import { MoonIcon, SunIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';

type Theme = 'light' | 'dark' | 'system';

type ThemeToggleProps = {
  className?: string;
  theme: Theme;
  onToggle: () => void;
};

export function ThemeToggle({ className, theme, onToggle }: ThemeToggleProps) {
  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <Button
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'h-9 w-9 p-0 text-foreground hover:text-foreground hover:bg-accent/50',
        'cursor-pointer',
        className,
      )}
      onClick={onToggle}
      size="icon"
      variant="ghost"
    >
      {isDark ? (
        <SunIcon className="h-4 w-4" />
      ) : (
        <MoonIcon className="h-4 w-4" />
      )}
    </Button>
  );
}
