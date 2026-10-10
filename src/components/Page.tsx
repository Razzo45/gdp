import type { ReactNode } from 'react';

/** List pages scroll. The task workspace fills the window and splits its own panes. */
export function Page({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  if (fill) {
    return (
      <div className="h-full overflow-y-auto px-4 py-4 sm:px-6 lg:overflow-hidden lg:py-4">
        <div className="flex min-h-full flex-col lg:h-full lg:min-h-0">{children}</div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto w-full max-w-[1600px]">{children}</div>
    </div>
  );
}
