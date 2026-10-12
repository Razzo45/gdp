import { afterEach, describe, expect, it, vi } from 'vitest';
import { signLocalSession, verifyLocalSession } from '@/lib/auth/local';
import { loginRedirectUrl } from '@/lib/auth/urls';
import { verifyLivePassword } from '@/lib/auth/livePassword';
import { hashPassword, verifyPassword } from '@/lib/auth/passwords';
import { hashAuthToken } from '@/lib/auth/tokens';
import { supabaseAuthConfig } from '@/lib/auth/supabasePublic';
import { splitStatements } from '@/db/migrate';

describe('logout redirect', () => {
  it('sends production logouts to the live login page, and keeps localhost on itself', () => {
    expect(loginRedirectUrl('https://gdp-production-83d5.up.railway.app/auth/signout')).toBe('https://gdp.wirestock.io/login');
    expect(loginRedirectUrl('https://gdp.wirestock.io/auth/signout')).toBe('https://gdp.wirestock.io/login');
    expect(loginRedirectUrl('http://localhost:3000/auth/signout')).toBe('http://localhost:3000/login');
    expect(loginRedirectUrl('http://127.0.0.1:3000/auth/signout')).toBe('http://127.0.0.1:3000/login');
  });
});

describe('local session', () => {
  const secret = 'a-test-secret-of-sufficient-length';
  it('round-trips and rejects other secrets', async () => {
    const token = await signLocalSession({ id: '11111111-1111-4111-8111-111111111111', email: 'a@b.c' }, secret);
    expect(await verifyLocalSession(token, secret)).toEqual({ sub: '11111111-1111-4111-8111-111111111111', email: 'a@b.c' });
    expect(await verifyLocalSession(token, 'another-secret-of-sufficient-length')).toBeNull();
    expect(await verifyLocalSession('garbage', secret)).toBeNull();
  });
});

describe('passwords', () => {
  it('hashes and verifies, and rejects the wrong secret', async () => {
    const stored = await hashPassword('a-long-enough-password');
    expect(stored.startsWith('scrypt:')).toBe(true);
    expect(await verifyPassword('a-long-enough-password', stored)).toBe(true);
    expect(await verifyPassword('wrong-password-xx', stored)).toBe(false);
    expect(await verifyPassword('a-long-enough-password', null)).toBe(false);
  });

  it('hashes invite tokens one-way', () => {
    expect(hashAuthToken('abc')).toHaveLength(64);
    expect(hashAuthToken('abc')).toBe(hashAuthToken('abc'));
    expect(hashAuthToken('abc')).not.toBe(hashAuthToken('abd'));
  });
});

describe('live password check', () => {
  const keys = ['SUPABASE_READ_URL', 'SUPABASE_READ_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it('accepts a live password grant and signs the live session out', async () => {
    for (const key of keys) delete process.env[key];
    process.env['SUPABASE_READ_URL'] = 'https://example.supabase.co';
    process.env['SUPABASE_READ_SERVICE_ROLE_KEY'] = 'sb_secret_test';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/token')) {
        expect(init?.body).toContain('person@example.com');
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      expect(url).toContain('/logout');
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyLivePassword('person@example.com', 'their-old-password')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a failed live grant', async () => {
    for (const key of keys) delete process.env[key];
    process.env['SUPABASE_READ_URL'] = 'https://example.supabase.co';
    process.env['SUPABASE_READ_SERVICE_ROLE_KEY'] = 'sb_secret_test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })));
    expect(await verifyLivePassword('person@example.com', 'wrong')).toBe(false);
  });
});

describe('supabase auth config', () => {
  const keys = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_READ_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_READ_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it('accepts the live read URL plus a server service-role key', () => {
    for (const key of keys) delete process.env[key];
    process.env['SUPABASE_READ_URL'] = 'https://example.supabase.co';
    process.env['SUPABASE_READ_SERVICE_ROLE_KEY'] = 'sb_secret_test';
    expect(supabaseAuthConfig()).toEqual({ url: 'https://example.supabase.co', key: 'sb_secret_test' });
  });
});

describe('splitStatements', () => {
  it('respects dollar quotes, strings and comments', () => {
    const sql = `
      -- leading comment; with semicolon
      create table t (a text default 'x;y');
      create function f() returns trigger language plpgsql as $$ begin new.x := 1; return new; end $$;
      /* block; comment */ insert into t values ('a');
    `;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(3);
    expect(parts[1]).toContain('return new; end $$');
    expect(parts[2]).toMatch(/insert into t/);
  });
});
