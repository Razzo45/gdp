import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { profiles, ROLES, userRoles, watchedProjects, type Role, type WatchedProject } from '@/db/schema';
import { forgetActor } from '@/lib/auth/identity';
import { canManageProjects, canManageUsers, type Actor } from '@/lib/auth/permissions';
import { fetchProject } from '@/lib/catalog/client';
import { readProjectStatuses } from '@/lib/catalog/read';
import type { CatalogStatus } from '@/lib/catalog/types';
import { env } from '@/lib/env';
import { hasServiceKey, supabaseAdmin } from '@/lib/supabase/server';
import { forbidden, invalid, notFound, ServiceError } from './errors';

/* ─────────────────────────────────────────────── users ── */

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  isActive: boolean;
  roles: Role[];
  createdAt: string;
}

export async function listUsers(actor: Actor): Promise<UserRow[]> {
  if (!canManageUsers(actor) && !actor.roles.has('pm')) throw forbidden('Only admins and PMs can list users.');
  const database = db();
  const people = await database.select().from(profiles).orderBy(profiles.email);
  const grants = await database.select().from(userRoles);
  return people.map((p) => ({ id: p.id, email: p.email, displayName: p.displayName, isActive: p.isActive, roles: grants.filter((g) => g.userId === p.id).map((g) => g.role), createdAt: p.createdAt }));
}

/** Creates the Auth user (invite email) and the profile with roles, in that order. */
export async function inviteUser(actor: Actor, input: { email: string; roles: Role[]; displayName?: string }, origin: string): Promise<UserRow & { inviteUrl?: string }> {
  if (!canManageUsers(actor)) throw forbidden('Only admins can invite users.');
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('Enter a valid email address.');
  const roles = [...new Set(input.roles)].filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  const base = (env().PUBLIC_APP_URL ?? origin).replace(/\/$/, '');
  const database = db();

  let userId: string | undefined;
  let inviteUrl: string | undefined;
  if (env().AUTH_MODE === 'local') {
    userId = (await database.select({ id: profiles.id }).from(profiles).where(eq(profiles.email, email)).limit(1))[0]?.id ?? crypto.randomUUID();
  } else {
    const admin = supabaseAdmin();
    const invited = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${base}/auth/callback?next=/login?reset=1` });
    userId = invited.data.user?.id;
    if (invited.error) {
      // Already registered in Auth: find them and just set up the profile.
      const page = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      userId = page.data.users.find((u) => u.email?.toLowerCase() === email)?.id;
      if (!userId) throw new ServiceError(502, `Could not invite ${email}: ${invited.error.message}`);
    }
  }
  if (!userId) throw new ServiceError(502, 'The invite did not return a user id.');

  await database.transaction(async (tx) => {
    await tx.insert(profiles).values({ id: userId!, email, displayName: input.displayName?.trim() || null }).onConflictDoUpdate({ target: profiles.id, set: { email, isActive: true } });
    await tx.delete(userRoles).where(eq(userRoles.userId, userId!));
    if (roles.length) await tx.insert(userRoles).values(roles.map((role) => ({ userId: userId!, role, grantedBy: actor.id })));
  });
  forgetActor(userId);
  if (env().AUTH_MODE === 'local') {
    const { issueAuthToken } = await import('@/lib/auth/tokens');
    const { sendAuthLinkEmail } = await import('@/lib/mail/authMail');
    const token = await issueAuthToken(userId, 'invite');
    inviteUrl = `${base}/login?reset=1&token=${token}`;
    await sendAuthLinkEmail({ recipient: email, kind: 'invite', url: inviteUrl }).catch(() => undefined);
  }
  const row = (await listUsers(actor)).find((u) => u.id === userId);
  if (!row) throw notFound('The user');
  return inviteUrl ? { ...row, inviteUrl } : row;
}

export async function setUserRoles(actor: Actor, userId: string, roles: Role[]): Promise<void> {
  if (!canManageUsers(actor)) throw forbidden('Only admins can change roles.');
  const clean = [...new Set(roles)].filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  const database = db();
  await database.transaction(async (tx) => {
    const target = (await tx.select().from(profiles).where(eq(profiles.id, userId)).limit(1))[0];
    if (!target) throw notFound('The user');
    if (userId === actor.id && !clean.includes('admin')) throw invalid('You cannot remove your own admin role.');
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    if (clean.length) await tx.insert(userRoles).values(clean.map((role) => ({ userId, role, grantedBy: actor.id })));
  });
  forgetActor(userId);
}

export async function setUserActive(actor: Actor, userId: string, isActive: boolean): Promise<void> {
  if (!canManageUsers(actor)) throw forbidden('Only admins can deactivate users.');
  if (userId === actor.id && !isActive) throw invalid('You cannot deactivate yourself.');
  const updated = await db().update(profiles).set({ isActive }).where(eq(profiles.id, userId)).returning({ id: profiles.id });
  if (updated.length === 0) throw notFound('The user');
  forgetActor(userId);
  if (!isActive && env().AUTH_MODE === 'supabase' && hasServiceKey()) await supabaseAdmin().auth.admin.signOut(userId).catch(() => undefined);
}

/* ─────────────────────────────────────────── projects ── */

export interface WatchedProjectView extends WatchedProject {
  name: string;
  statuses: CatalogStatus[];
}

function viewOf(row: WatchedProject): WatchedProjectView {
  const read = readProjectStatuses(row.project);
  return { ...row, name: read?.name ?? row.label, statuses: read?.statuses ?? [] };
}

export async function listWatchedProjects(actor: Actor): Promise<WatchedProjectView[]> {
  if (!canManageProjects(actor)) throw forbidden('Only PMs and admins can see watched projects.');
  return (await db().select().from(watchedProjects).orderBy(watchedProjects.createdAt)).map(viewOf);
}

export async function addWatchedProject(actor: Actor, projectId: string): Promise<WatchedProjectView> {
  if (!canManageProjects(actor)) throw forbidden('Only PMs and admins can watch projects.');
  const id = projectId.trim();
  if (!id) throw invalid('Enter the Catalog project id.');
  const fetched = await fetchProject(id);
  if (!fetched.ok) throw new ServiceError(fetched.status === 404 ? 404 : 502, fetched.error);
  const read = readProjectStatuses(fetched.project);
  const [row] = await db()
    .insert(watchedProjects)
    .values({ projectId: id, label: read?.name ?? id, project: fetched.project, projectFetchedAt: new Date().toISOString(), addedBy: actor.id })
    .onConflictDoUpdate({ target: watchedProjects.projectId, set: { project: fetched.project, projectFetchedAt: new Date().toISOString(), label: read?.name ?? id } })
    .returning();
  return viewOf(row!);
}

export async function updateWatchedProject(actor: Actor, projectId: string, patch: { workStatusId?: string; handoffStatusId?: string; label?: string }): Promise<WatchedProjectView> {
  if (!canManageProjects(actor)) throw forbidden('Only PMs and admins can configure projects.');
  const existing = (await db().select().from(watchedProjects).where(eq(watchedProjects.projectId, projectId)).limit(1))[0];
  if (!existing) throw notFound('The project');
  const known = new Set((readProjectStatuses(existing.project)?.statuses ?? []).map((s) => s.id));
  for (const value of [patch.workStatusId, patch.handoffStatusId]) {
    if (value && known.size && !known.has(value)) throw invalid('That status is not part of the project workflow.');
  }
  const [row] = await db()
    .update(watchedProjects)
    .set({ ...(patch.workStatusId !== undefined ? { workStatusId: patch.workStatusId } : {}), ...(patch.handoffStatusId !== undefined ? { handoffStatusId: patch.handoffStatusId } : {}), ...(patch.label !== undefined ? { label: patch.label.trim() } : {}) })
    .where(eq(watchedProjects.projectId, projectId))
    .returning();
  return viewOf(row!);
}

export async function removeWatchedProject(actor: Actor, projectId: string): Promise<void> {
  if (!canManageProjects(actor)) throw forbidden('Only PMs and admins can configure projects.');
  await db().delete(watchedProjects).where(and(eq(watchedProjects.projectId, projectId)));
}
