import { jwtVerify, SignJWT } from 'jose';

/**
 * AUTH_MODE=local — identity lives in app.profiles. Production (Railway)
 * uses per-user password hashes; AUTH_LOCAL_PASSWORD is optional and only
 * for the laptop user picker. The session is an HS256 cookie. Edge-safe.
 */

export const LOCAL_SESSION_COOKIE = 'gdp_session';
const SESSION_TTL_S = 7 * 24 * 3600;

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signLocalSession(user: { id: string; email: string }, secret: string): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('gdp-local')
    .setAudience('gdp')
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_S}s`)
    .sign(key(secret));
}

export async function verifyLocalSession(token: string, secret: string): Promise<{ sub: string; email: string | null } | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: 'gdp-local', audience: 'gdp', algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    return { sub: payload.sub, email: typeof payload['email'] === 'string' ? payload['email'] : null };
  } catch {
    return null;
  }
}

export const localCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure,
  path: '/',
  maxAge: SESSION_TTL_S,
});
