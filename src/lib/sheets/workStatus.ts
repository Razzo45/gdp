import 'server-only';

import { inArray } from 'drizzle-orm';
import { SignJWT, importPKCS8 } from 'jose';
import { db } from '@/db/client';
import { profiles, type HandoffStatus, type ReviewStatus, type Stage } from '@/db/schema';
import { env } from '@/lib/env';
import {
  findWorkStatusSheetUpdates,
  shouldPushWorkSheet,
  workStatusSheetLabel,
  workStatusSheetOwner,
  WORK_STATUS_SHEET_LABELS,
} from '@/domain/workStatusSheet';
import { workStateOf, type WorkState } from '@/domain/workState';

const DEFAULT_SPREADSHEET = '1SSfpE01umUWHh-DSqBniopXU4iKyx4Moa1qeFgsQPzc';
const DEFAULT_GID = 1382586053;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export type WorkStatusSnapshot = {
  catalogSubmissionId: string;
  stage: Stage;
  rubricAssigneeId: string | null;
  reviewerId?: string | null;
  reviewStatus: ReviewStatus | null;
  handoffStatus: HandoffStatus | null;
};

export type WorkStatusSheetItem = {
  catalogSubmissionId: string;
  state: WorkState;
  ownerName: string;
};

type ServiceAccount = { client_email: string; private_key: string };

let token: { access: string; until: number } | null = null;
let validationReady = false;

function sheetsEnabled(): boolean {
  return process.env.SHEETS_SYNC === '1';
}

function credentials(): ServiceAccount | null {
  const raw = env().GOOGLE_SHEETS_CREDENTIALS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

function spreadsheetId(): string {
  return env().SHEETS_SPREADSHEET_ID?.trim() || DEFAULT_SPREADSHEET;
}

function sheetGid(): number {
  return env().SHEETS_SHEET_GID ?? DEFAULT_GID;
}

async function accessToken(): Promise<string> {
  if (token && token.until > Date.now() + 60_000) return token.access;
  const creds = credentials();
  if (!creds) throw new Error('GOOGLE_SHEETS_CREDENTIALS is missing or not JSON.');
  const key = await importPKCS8(creds.private_key.replace(/\\n/g, '\n'), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(creds.client_email)
    .setSubject(creds.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const json = (await response.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !json.access_token) throw new Error(json.error || `Google token ${response.status}`);
  token = { access: json.access_token, until: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return token.access;
}

async function sheets<T>(path: string, init: RequestInit = {}): Promise<T> {
  const bearer = await accessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(json.error?.message || `Sheets ${response.status}`);
  return json;
}

function a1Column(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

async function tab(): Promise<{ sheetId: number; title: string }> {
  const meta = await sheets<{ sheets?: { properties?: { sheetId?: number; title?: string } }[] }>('?fields=sheets.properties');
  const gid = sheetGid();
  const found = (meta.sheets ?? []).find((item) => item.properties?.sheetId === gid);
  const title = found?.properties?.title;
  if (!title || found?.properties?.sheetId == null) throw new Error(`Sheet gid ${gid} was not found.`);
  return { sheetId: found.properties.sheetId, title };
}

async function readGrid(title: string): Promise<string[][]> {
  const quoted = `'${title.replace(/'/g, "''")}'`;
  const data = await sheets<{ values?: string[][] }>(`/values/${encodeURIComponent(`${quoted}!A1:Z`)}`);
  return data.values ?? [];
}

async function ensureDropdown(sheetId: number, columnIndex: number): Promise<void> {
  if (validationReady) return;
  await sheets(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: WORK_STATUS_SHEET_LABELS.map((label) => ({ userEnteredValue: label })),
              },
              showCustomUi: true,
              strict: true,
            },
          },
        },
      ],
    }),
  });
  validationReady = true;
}

async function applyPatches(
  title: string,
  sheetId: number,
  patches: { rowIndex: number; columnIndex: number; value: string }[],
  dropdownColumn?: number,
): Promise<number> {
  if (patches.length === 0) return 0;
  if (dropdownColumn != null) await ensureDropdown(sheetId, dropdownColumn);
  const quoted = `'${title.replace(/'/g, "''")}'`;
  await sheets('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: patches.map((patch) => ({
        range: `${quoted}!${a1Column(patch.columnIndex)}${patch.rowIndex + 1}`,
        values: [[patch.value]],
      })),
    }),
  });
  return patches.length;
}

async function namesById(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await db().select({ id: profiles.id, displayName: profiles.displayName, email: profiles.email }).from(profiles).where(inArray(profiles.id, unique));
  return new Map(rows.map((row) => [row.id, (row.displayName ?? row.email).trim()]));
}

export function ownerNameFor(
  state: WorkState,
  snapshot: Pick<WorkStatusSnapshot, 'rubricAssigneeId' | 'reviewerId'>,
  names: Map<string, string>,
): string {
  return workStatusSheetOwner(state, {
    rubric: snapshot.rubricAssigneeId ? names.get(snapshot.rubricAssigneeId) ?? null : null,
    reviewer: snapshot.reviewerId ? names.get(snapshot.reviewerId) ?? null : null,
  });
}

function ownerIdOf(snapshot: WorkStatusSnapshot, state: WorkState): string | null {
  return state === 'in_review' ? snapshot.reviewerId ?? null : snapshot.rubricAssigneeId;
}

/** Writes Status Rubrics and Assignee when a matching Task ID exists. Never appends a row. */
export async function writeWorkStatusSheet(
  catalogSubmissionId: string,
  state: WorkState,
  ownerName: string,
): Promise<'updated' | 'skipped'> {
  if (!sheetsEnabled() || !credentials()) return 'skipped';
  const { sheetId, title } = await tab();
  const rows = await readGrid(title);
  const patches = findWorkStatusSheetUpdates(rows, catalogSubmissionId, { status: workStatusSheetLabel(state), owner: ownerName });
  if (patches.length === 0) return 'skipped';
  await applyPatches(title, sheetId, patches, patches[0]!.columnIndex);
  return 'updated';
}

/** Post-cutover first write. Only rows that already have a Catalog UUID. */
export async function writeWorkStatusSheetMany(
  items: readonly WorkStatusSheetItem[],
): Promise<{ updated: number; skipped: number }> {
  if (!sheetsEnabled() || !credentials()) return { updated: 0, skipped: items.length };
  const { sheetId, title } = await tab();
  const rows = await readGrid(title);
  const grouped = items.map((item) =>
    findWorkStatusSheetUpdates(rows, item.catalogSubmissionId, { status: workStatusSheetLabel(item.state), owner: item.ownerName }),
  );
  const patches = grouped.flat();
  const updated = grouped.filter((group) => group.length > 0).length;
  await applyPatches(title, sheetId, patches, patches[0]?.columnIndex);
  return { updated, skipped: items.length - updated };
}

/** After a pipeline mutation. Never blocks the request. No-op until SHEETS_SYNC=1. */
export function scheduleWorkStatusSheet(previous: WorkStatusSnapshot | null, next: WorkStatusSnapshot): void {
  if (!sheetsEnabled()) return;
  const before = previous ? workStateOf(previous) : null;
  const after = workStateOf(next);
  const beforeOwner = previous && before ? ownerIdOf(previous, before) : null;
  const afterOwner = ownerIdOf(next, after);
  if (!shouldPushWorkSheet(previous && before ? { state: before, owner: beforeOwner ?? '' } : null, { state: after, owner: afterOwner ?? '' })) {
    return;
  }
  void (async () => {
    const names = await namesById([next.rubricAssigneeId, next.reviewerId]);
    await writeWorkStatusSheet(next.catalogSubmissionId, after, ownerNameFor(after, next, names));
  })().catch((error) => {
    console.warn('[work-status-sheet]', error instanceof Error ? error.message : error);
  });
}
