import { z } from 'zod';
import { json } from '@/lib/api';
import { env } from '@/lib/env';
import { supabaseAuthClient } from '@/lib/supabase/server';

/** Password recovery email. Always answers ok so addresses cannot be probed. */
export async function POST(request: Request): Promise<Response> {
  const parsed = z.object({ email: z.string().email() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Enter your email.' }, 400);
  if (env().AUTH_MODE === 'local') return json({ error: 'Local auth mode: use the shared development password.' }, 400);
  const base = env().PUBLIC_APP_URL ?? new URL(request.url).origin;
  const supabase = await supabaseAuthClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${base}/auth/callback?next=/login?reset=1` }).catch(() => undefined);
  return json({ ok: true });
}
