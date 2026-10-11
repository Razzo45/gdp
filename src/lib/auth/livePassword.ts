/**
 * One-shot check against live Supabase Auth when a Railway profile has no
 * local hash yet. Tokens are discarded (and the live session is signed out).
 * We never write to live Auth or public.wirestock_*.
 */

function liveAuthConfig(): { url: string; key: string } | null {
  const url = (
    process.env['SUPABASE_READ_URL'] ??
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ??
    process.env['SUPABASE_URL'] ??
    ''
  )
    .trim()
    .replace(/\/$/, '');
  const key = (
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ??
    process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] ??
    process.env['SUPABASE_PUBLISHABLE_KEY'] ??
    process.env['SUPABASE_ANON_KEY'] ??
    process.env['SUPABASE_READ_SERVICE_ROLE_KEY'] ??
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ??
    ''
  ).trim();
  if (!url || !key) return null;
  return { url, key };
}

export async function verifyLivePassword(email: string, password: string): Promise<boolean> {
  const config = liveAuthConfig();
  if (!config) return false;
  try {
    const response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
    const access = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!access) return false;
    await fetch(`${config.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: config.key, Authorization: `Bearer ${access}` },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
