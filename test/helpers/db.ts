import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { setDbForTests } from '@/db/client';
import { migrate } from '@/db/migrate';
import * as schema from '@/db/schema';
import type { Db } from '@/db/types';
import type { Actor } from '@/lib/auth/permissions';
import type { Role } from '@/db/schema';

/** Fresh in-memory Postgres with the real migrations applied and injected into `db()`. */
export async function testDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema }) as unknown as Db;
  await migrate(db);
  setDbForTests(db);
  return {
    db,
    close: async () => {
      setDbForTests(null);
      await pg.close();
    },
  };
}

export async function makeUser(db: Db, email: string, roles: Role[]): Promise<Actor> {
  const id = crypto.randomUUID();
  await db.insert(schema.profiles).values({ id, email, displayName: email.split('@')[0]! });
  if (roles.length) await db.insert(schema.userRoles).values(roles.map((role) => ({ userId: id, role })));
  return { id, email, displayName: email.split('@')[0]!, roles: new Set(roles), isActive: true };
}

/** 5 Format / 15 Content / 30 Visual — unique enough to pass local lint. */
export function seatedRubricInputs() {
  const upserts: Array<{
    tag: 'Format/File' | 'Content - Semantics' | 'Visual - Layout';
    statement: string;
    notes: string;
    scope: 'output';
    inputFileIds: string[];
    outputFile: null;
  }> = [];
  for (let i = 0; i < 5; i += 1) {
    upserts.push({
      tag: 'Format/File',
      statement: `The delivered presentation uses a 16:9 page size on format seat ${i}.`,
      notes: '',
      scope: 'output',
      inputFileIds: [],
      outputFile: null,
    });
  }
  for (let i = 0; i < 15; i += 1) {
    upserts.push({
      tag: 'Content - Semantics',
      statement: `The deck names unique content claim ${i} for the client review.`,
      notes: '',
      scope: 'output',
      inputFileIds: [],
      outputFile: null,
    });
  }
  for (let i = 0; i < 30; i += 1) {
    upserts.push({
      tag: 'Visual - Layout',
      statement: `The title sits in the lower third on visual seat ${i}.`,
      notes: '',
      scope: 'output',
      inputFileIds: [],
      outputFile: null,
    });
  }
  return upserts;
}

export function yesAnswers(ids: string[], yesCount: number): Record<string, boolean> {
  return Object.fromEntries(ids.map((id, index) => [id, index < yesCount]));
}

export async function makeSubmission(db: Db, overrides: Partial<typeof schema.submissions.$inferInsert> = {}) {
  const source = {
    projectId: 'p1',
    projectSubmissionId: `cat-${crypto.randomUUID().slice(0, 8)}`,
    submission: { prompt: 'Make a deck.' },
    files: [],
  };
  const [row] = await db
    .insert(schema.submissions)
    .values({ catalogSubmissionId: source.projectSubmissionId, projectId: 'p1', title: 'Deck', source, sourceFingerprint: 'fp', ...overrides })
    .returning();
  return row!;
}
