import { BRAND } from '@craft-agent/shared/branding'

const brandSymbols = import.meta.glob(
  '../../../../resources/brands/*/{symbol.png,icon.svg}',
  {
    eager: true,
    import: 'default',
  },
) as Record<string, string>

interface CraftAgentsSymbolProps {
  className?: string
}

export function CraftAgentsSymbol({ className }: CraftAgentsSymbolProps) {
  return (
    <img
      src={brandSymbols[`../../../../${BRAND.assets.rendererSymbol}`]}
      alt={BRAND.appName}
      className={className}
      draggable={false}
    />
  )
}
