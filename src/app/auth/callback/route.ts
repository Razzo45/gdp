import { NextResponse } from 'next/server';
import { supabaseAuthClient } from '@/lib/supabase/server';

/**
 * Invite, magic-link and recovery links land here with a `code`; exchanging
 * it sets the session cookies. Recovery continues to /login?reset=1 where
 * the user picks a password.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'));
  if (code) {
    const supabase = await supabaseAuthClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL('/login?error=link', url.origin));
  }
  return NextResponse.redirect(new URL(next, url.origin));
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
