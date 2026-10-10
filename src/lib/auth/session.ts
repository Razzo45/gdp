import 'server-only';

import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { supabaseAuthClient } from '@/lib/supabase/server';
import { LOCAL_SESSION_COOKIE } from './local';

/** Ends the current session for whichever identity provider is active. */
export async function clearSession(): Promise<void> {
  if (env().AUTH_MODE === 'local') {
    (await cookies()).delete(LOCAL_SESSION_COOKIE);
    return;
  }
  const supabase = await supabaseAuthClient();
  await supabase.auth.signOut({ scope: 'local' });
}
