'use client';

import { useEffect, type ReactNode } from 'react';

export function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={onClose}>
      <div className={`max-h-[90vh] overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-lg ${wide ? 'w-full max-w-3xl' : 'w-full max-w-md'}`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id="modal-title" className="text-base font-semibold">
            {title}
          </h2>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
