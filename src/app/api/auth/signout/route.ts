import { json } from '@/lib/api';
import { clearSession } from '@/lib/auth/session';

export async function POST(): Promise<Response> {
  await clearSession();
  return json({ ok: true });
}
