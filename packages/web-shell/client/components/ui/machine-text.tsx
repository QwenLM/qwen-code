import type { ReactNode } from 'react';

export function MachineText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <bdi className={className} dir="ltr">
      {children}
    </bdi>
  );
}
