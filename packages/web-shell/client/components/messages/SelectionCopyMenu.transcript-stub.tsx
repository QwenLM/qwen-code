import type { SelectionCopyMenuProps } from './SelectionCopyMenu';

export function SelectionCopyMenu({
  children,
  className,
}: SelectionCopyMenuProps) {
  return <div className={className}>{children}</div>;
}
