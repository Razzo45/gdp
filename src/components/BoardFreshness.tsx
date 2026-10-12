'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { BOARD_REFRESH_MS, BOARD_STALE_MS } from '@/domain/freshness';

/**
 * Reloads a server-rendered board once a minute while the tab is visible,
 * and again when you come back to a stale tab. Used on admin / PM surfaces.
 */
export function BoardFreshness() {
  const router = useRouter();
  const last = useRef(Date.now());

  useEffect(() => {
    const reload = () => {
      last.current = Date.now();
      router.refresh();
    };
    const handle = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, BOARD_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last.current >= BOARD_STALE_MS) reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  return null;
}
