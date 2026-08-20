import { describe, expect, it } from 'bun:test'
import { mirrorHoverToOpenStateClasses } from '../StyledDropdown'

describe('mirrorHoverToOpenStateClasses', () => {
  it('mirrors supported hover utility classes to open state', () => {
    const result = mirrorHoverToOpenStateClasses('hover:bg-foreground/5 hover:text-foreground')

    expect(result).toContain('hover:bg-foreground/5')
    expect(result).toContain('hover:text-foreground')
    expect(result).toContain('data-[state=open]:bg-foreground/5')
    expect(result).toContain('data-[state=open]:text-foreground')
  })

  it('preserves explicit open-state overrides from the original className', () => {
    const result = mirrorHoverToOpenStateClasses(
      'hover:bg-foreground/5 data-[state=open]:bg-accent'
    )

    // twMerge should keep the explicit open class from input as winner
    expect(result).toContain('data-[state=open]:bg-accent')
    expect(result).not.toContain('data-[state=open]:bg-foreground/5')
  })

  it('does not mirror unsupported hover utilities', () => {
    const result = mirrorHoverToOpenStateClasses('hover:scale-105 hover:shadow-md')

    expect(result).toContain('hover:scale-105')
    expect(result).toContain('hover:shadow-md')
    expect(result).not.toContain('data-[state=open]:scale-105')
    expect(result).not.toContain('data-[state=open]:shadow-md')
  })

  it('returns undefined when className is undefined', () => {
    expect(mirrorHoverToOpenStateClasses(undefined)).toBeUndefined()
  })
})
