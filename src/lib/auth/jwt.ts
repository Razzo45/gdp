import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Local verification of Supabase access tokens.
 *
 * The legacy platform called Supabase Auth over the network on every request
 * (and again on every poll). A signed JWT is verifiable offline: signature,
 * issuer, audience and expiry. Revocation is bounded by the access-token
 * lifetime (1h by default; shorten it in the Supabase dashboard if desired)
 * plus the 60s role cache in identity.ts.
 */
export interface VerifiedClaims {
  sub: string;
  email: string | null;
  exp: number;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function issuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
}

export async function verifyAccessToken(
  token: string,
  options: { supabaseUrl: string; jwtSecret?: string | undefined },
): Promise<VerifiedClaims | null> {
  try {
    let payload: JWTPayload;
    const common = { issuer: issuer(options.supabaseUrl), audience: 'authenticated', clockTolerance: 30 };
    if (options.jwtSecret) {
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(options.jwtSecret), {
        ...common,
        algorithms: ['HS256'],
      }));
    } else {
      jwks ??= createRemoteJWKSet(new URL(`${issuer(options.supabaseUrl)}/.well-known/jwks.json`), {
        cacheMaxAge: 10 * 60_000,
      });
      ({ payload } = await jwtVerify(token, jwks, { ...common, algorithms: ['ES256', 'RS256'] }));
    }
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    const email = typeof payload['email'] === 'string' ? payload['email'] : null;
    return { sub: payload.sub, email, exp: payload.exp };
  } catch {
    return null;
  }
}

/** Decode `exp` without verifying — only to decide whether to refresh early. */
export function tokenExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = JSON.parse(atob(base64));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}
