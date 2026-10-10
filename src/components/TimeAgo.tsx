'use client';

import { useEffect, useState } from 'react';
import { formatDate, timeAgo } from './format';

/**
 * Relative time that must not be SSR'd — Date.now() on the server and the
 * browser disagree across a minute boundary and Next then refetches the page
 * in a compile loop.
 */
export function TimeAgo({ iso, prefix = '', suffix = '' }: { iso: string | null | undefined; prefix?: string; suffix?: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setLabel(timeAgo(iso));
    tick();
    const handle = setInterval(tick, 30_000);
    return () => clearInterval(handle);
  }, [iso]);
  if (!iso) return <>—</>;
  return (
    <span title={formatDate(iso)} suppressHydrationWarning>
      {label === null ? '' : `${prefix}${label}${suffix}`}
    </span>
  );
}
