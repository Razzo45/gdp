import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { rows } from './rows';
import type { DbOrTx } from './types';

/**
 * Minimal forward-only migration runner shared by the CLI (hosted Postgres)
 * and the test suite (pglite). Each file in drizzle/*.sql is applied once, in
 * lexical order, inside its own transaction.
 */
export async function migrate(db: DbOrTx, dir = path.join(process.cwd(), 'drizzle')): Promise<string[]> {
  await db.execute(sql`create schema if not exists app`);
  await db.execute(sql`
    create table if not exists app.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  const applied = new Set(
    rows<{ name: string }>(await db.execute(sql`select name from app.schema_migrations`)).map((row) => row.name),
  );
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const body = await readFile(path.join(dir, name), 'utf8');
    await db.transaction(async (tx) => {
      // Drivers using the extended protocol reject multi-statement strings,
      // so each statement is sent on its own.
      for (const statement of splitStatements(body)) await tx.execute(sql.raw(statement));
      await tx.execute(sql`insert into app.schema_migrations (name) values (${name})`);
    });
    ran.push(name);
  }
  return ran;
}

/**
 * Splits SQL on top-level semicolons, honouring single quotes, double
 * quotes, dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`), and `--` /
 * block comments. Comments are kept with their statement; empty chunks are
 * dropped.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  let dollar: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (dollar) {
      if (text.startsWith(dollar, i)) {
        current += dollar;
        i += dollar.length;
        dollar = null;
      } else {
        current += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      current += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      current += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const tag = text.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (tag) {
        dollar = tag[0];
        current += dollar;
        i += dollar.length;
        continue;
      }
    }
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed && !/^(--[^\n]*\n?\s*)*$/.test(trimmed)) out.push(trimmed);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail && !/^(--[^\n]*\n?\s*)*$/.test(tail)) out.push(tail);
  return out;
}
