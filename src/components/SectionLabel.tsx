import type { ReactNode } from 'react';

/** The small caps label that opens a section, with room for one action on the right. */
export function SectionLabel({
  children,
  action,
  className = '',
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${className}`}>
      <h2 className="text-overline text-muted-foreground uppercase">{children}</h2>
      {action}
    </div>
  );
}
