import { cn } from '../../lib/utils';

const qwenCodeLogo = new URL('../../assets/icon.png', import.meta.url).href;

type QwenCodeBrandProps = {
  className?: string;
  size?: 'sm' | 'md';
  showVersion?: boolean;
  version?: string;
};

export function QwenCodeBrand({
  className,
  size = 'md',
  showVersion = true,
  version = '0.1.0',
}: QwenCodeBrandProps) {
  const textSizeClass = size === 'sm' ? 'text-base' : 'text-lg';
  const versionPadding = size === 'sm' ? 'text-xs' : 'text-sm';
  const logoSize = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex items-center gap-2">
        <img
          src={qwenCodeLogo}
          alt="Qwen Code"
          className={cn(logoSize, 'rounded-lg')}
        />
        <span className={cn(textSizeClass, 'font-semibold text-foreground')}>
          Qwen Code
        </span>
      </div>
      {showVersion && (
        <span
          className={cn('text-muted-foreground font-medium', versionPadding)}
        >
          v{version}
        </span>
      )}
    </div>
  );
}
