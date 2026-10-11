import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { profiles } from '@/db/schema';
import { json } from '@/lib/api';
import { issueAuthToken } from '@/lib/auth/tokens';
import { env } from '@/lib/env';
import { sendAuthLinkEmail } from '@/lib/mail/authMail';
import { supabaseAuthClient } from '@/lib/supabase/server';

/** Password recovery. Always answers ok so addresses cannot be probed. */
export async function POST(request: Request): Promise<Response> {
  const parsed = z.object({ email: z.string().email() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Enter your email.' }, 400);
  const base = env().PUBLIC_APP_URL ?? new URL(request.url).origin;
  if (env().AUTH_MODE === 'local') {
    const user = (await db().select().from(profiles).where(eq(profiles.email, parsed.data.email.toLowerCase())).limit(1))[0];
    if (user?.isActive) {
      const token = await issueAuthToken(user.id, 'recover', 2 * 60 * 60_000);
      await sendAuthLinkEmail({ recipient: user.email, kind: 'recover', url: `${base.replace(/\/$/, '')}/login?reset=1&token=${token}` }).catch(() => undefined);
    }
    return json({ ok: true });
  }
  const supabase = await supabaseAuthClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${base}/auth/callback?next=/login?reset=1` }).catch(() => undefined);
  return json({ ok: true });
}
