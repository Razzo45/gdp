import { describe, expect, it } from 'vitest';
import { signLocalSession, verifyLocalSession } from '@/lib/auth/local';
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
