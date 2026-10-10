import { z } from 'zod';
import { json } from '@/lib/api';
import { env } from '@/lib/env';
import { supabaseAuthClient } from '@/lib/supabase/server';

/** Sets a new password for the session established by an invite/recovery link. */
export async function POST(request: Request): Promise<Response> {
  const parsed = z.object({ password: z.string().min(10).max(200) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Use at least 10 characters.' }, 400);
  if (env().AUTH_MODE === 'local') return json({ error: 'Local auth mode: passwords are fixed by AUTH_LOCAL_PASSWORD.' }, 400);
  const supabase = await supabaseAuthClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return json({ error: 'The link has expired. Request a new one.' }, 401);
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}
