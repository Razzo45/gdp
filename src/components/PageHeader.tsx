import type { ReactNode } from 'react';

export function PageHeader({
  kicker = 'Wirestock · GDP',
  title,
  children,
  actions,
}: {
  kicker?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="page-kicker">{kicker}</p>
        <h1 className="page-title mt-1">{title}</h1>
        {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
