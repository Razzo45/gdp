import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { tokenExpiry, verifyAccessToken } from '@/lib/auth/jwt';
import { VERIFIED_EMAIL_HEADER, VERIFIED_USER_HEADER } from '@/lib/auth/headerNames';
import { LOCAL_SESSION_COOKIE, verifyLocalSession } from '@/lib/auth/local';
import { supabaseAuthConfig } from '@/lib/auth/supabasePublic';

/**
 * Request gate. One job: establish who is calling, cheaply.
 *
 *  - Reads the Supabase session cookie (no network).
 *  - Verifies the access token locally (signature/issuer/audience/expiry).
 *  - Refreshes the session over the network ONLY when the token is within
 *    90 seconds of expiry, and writes the rotated cookies back.
 *  - Forwards the verified subject to the app in a header that inbound
 *    requests can never set.
 *
 * It does not consult the database. Roles and seats are resolved by the
 * server from a short-lived cache (see lib/auth/identity.ts).
 */

const PUBLIC_PATHS = ['/login', '/auth/callback', '/auth/signout', '/api/auth/', '/api/hooks/', '/api/health'];

const isPublic = (pathname: string) => PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p));

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Never trust these from the outside.
  const forwarded = new Headers(request.headers);
  forwarded.delete(VERIFIED_USER_HEADER);
  forwarded.delete(VERIFIED_EMAIL_HEADER);

  let response = NextResponse.next({ request: { headers: forwarded } });

  const localCookie = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
  const localMode = (process.env['AUTH_MODE'] ?? '').trim() === 'local';
  if (localMode || localCookie) {
    const session = localCookie ? await verifyLocalSession(localCookie, process.env['AUTH_LOCAL_SECRET'] ?? '') : null;
    if (session) {
      forwarded.set(VERIFIED_USER_HEADER, session.sub);
      if (session.email) forwarded.set(VERIFIED_EMAIL_HEADER, session.email);
      return NextResponse.next({ request: { headers: forwarded } });
    }
    if (localMode) return refuse(request, pathname, response);
  }

  const { url: supabaseUrl, key: supabaseKey } = supabaseAuthConfig();
  const supabase = createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request: { headers: forwarded } });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const { data } = await supabase.auth.getSession();
  let token = data.session?.access_token ?? null;

  if (token) {
    const exp = tokenExpiry(token);
    const msLeft = exp !== null ? exp * 1000 - Date.now() : null;
    if (msLeft !== null && msLeft < 90_000) {
      try {
        const refreshed = await Promise.race([
          supabase.auth.refreshSession(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('refresh-timeout')), 8_000);
          }),
        ]);
        if (refreshed.data.session?.access_token) token = refreshed.data.session.access_token;
      } catch {
        if (msLeft <= 0) token = null;
      }
    }
  }

  const claims = token
    ? await verifyAccessToken(token, {
        supabaseUrl,
        jwtSecret: process.env['SUPABASE_JWT_SECRET'],
      })
    : null;

  if (claims) {
    forwarded.set(VERIFIED_USER_HEADER, claims.sub);
    if (claims.email) forwarded.set(VERIFIED_EMAIL_HEADER, claims.email);
    const next = NextResponse.next({ request: { headers: forwarded } });
    for (const cookie of response.cookies.getAll()) next.cookies.set(cookie);
    return next;
  }

  return refuse(request, pathname, response);
}

function refuse(request: NextRequest, pathname: string, passThrough: NextResponse): NextResponse {
  if (isPublic(pathname)) return passThrough;
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  }
  const login = request.nextUrl.clone();
  login.pathname = '/login';
  login.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|api/local-storage|.*\\.(?:png|svg|jpg|webp|ico)$).*)'],
};
