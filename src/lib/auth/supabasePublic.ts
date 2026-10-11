/**
 * Live Supabase Auth project coordinates. Safe to import from the edge
 * proxy — no database, no service-only helpers.
 *
 * Prefer the publishable / anon key. The service-role key is a last-resort
 * server fallback so this checkout can sign in against the same project as
 * SUPABASE_READ_* without putting that secret in NEXT_PUBLIC_*.
 */
export function supabaseAuthConfig(): { url: string; key: string } {
  const url = first('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'SUPABASE_READ_URL');
  const key = first(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_READ_SERVICE_ROLE_KEY',
  );
  if (!url || !key) {
    throw new Error('Supabase Auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and a publishable/anon key (or SUPABASE_READ_URL plus a service-role key).');
  }
  return { url, key };
}

function first(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
