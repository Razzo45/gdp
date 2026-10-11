import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { env, publicEnv } from '@/lib/env';
import { ServiceError } from '@/lib/services/errors';

/**
 * Cookie-bound Supabase Auth client. Used ONLY for login, logout, password
 * recovery and reading the session cookie. Application data never flows
 * through Supabase's data API — the server owns the database connection.
 */
export async function supabaseAuthClient() {
  const store = await cookies();
  const { url, anonKey } = publicEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Components cannot write cookies; the proxy refreshes them.
        }
      },
    },
  });
}

export const hasServiceKey = () => Boolean(env().SUPABASE_SERVICE_ROLE_KEY ?? process.env['SUPABASE_READ_SERVICE_ROLE_KEY']?.trim());

/** Service-role client for Auth admin (invites) and Storage. Server only. */
export function supabaseAdmin() {
  const { url } = publicEnv();
  const key = env().SUPABASE_SERVICE_ROLE_KEY ?? process.env['SUPABASE_READ_SERVICE_ROLE_KEY']?.trim();
  if (!key) {
    throw new ServiceError(503, 'This action needs a Supabase service-role key, which is not configured on this server.');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
