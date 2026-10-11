import { afterEach, describe, expect, it } from 'vitest';
import { signLocalSession, verifyLocalSession } from '@/lib/auth/local';
import { supabaseAuthConfig } from '@/lib/auth/supabasePublic';
import { splitStatements } from '@/db/migrate';

describe('local session', () => {
  const secret = 'a-test-secret-of-sufficient-length';
  it('round-trips and rejects other secrets', async () => {
    const token = await signLocalSession({ id: '11111111-1111-4111-8111-111111111111', email: 'a@b.c' }, secret);
    expect(await verifyLocalSession(token, secret)).toEqual({ sub: '11111111-1111-4111-8111-111111111111', email: 'a@b.c' });
    expect(await verifyLocalSession(token, 'another-secret-of-sufficient-length')).toBeNull();
    expect(await verifyLocalSession('garbage', secret)).toBeNull();
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
