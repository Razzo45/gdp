import 'server-only';

import { inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { geminiFiles, geminiFileUses, jobs, submissions } from '@/db/schema';
import { reapableShas } from '@/domain/reaper';
import { dropGeminiFile } from './gemini';

/**
 * Cull staged Files API objects that no live task still needs, and rows
 * whose 47-hour handle is about to expire. Safe to call after handoff or
 * on the worker sweep — a sha shared by another preparing task is kept.
 */
export async function reapGeminiFiles(): Promise<{ culled: number }> {
  const database = db();
  const [files, uses, stages, busy] = await Promise.all([
    database.select({ sha256: geminiFiles.sha256, uri: geminiFiles.uri, expiresAt: geminiFiles.expiresAt }).from(geminiFiles),
    database.select({ sha256: geminiFileUses.sha256, submissionId: geminiFileUses.submissionId }).from(geminiFileUses),
    database.select({ id: submissions.id, stage: submissions.stage }).from(submissions),
    database.select({ submissionId: jobs.submissionId }).from(jobs).where(inArray(jobs.status, ['queued', 'running'])),
  ]);
  if (files.length === 0) return { culled: 0 };

  const doomed = new Set(
    reapableShas({
      files,
      uses,
      stages,
      busySubmissionIds: busy.map((row) => row.submissionId),
      nowMs: Date.now(),
    }),
  );
  if (doomed.size === 0) return { culled: 0 };

  let culled = 0;
  for (const row of files) {
    if (!doomed.has(row.sha256)) continue;
    try {
      await dropGeminiFile(row.uri);
      await database.delete(geminiFileUses).where(inArray(geminiFileUses.sha256, [row.sha256]));
      await database.delete(geminiFiles).where(inArray(geminiFiles.sha256, [row.sha256]));
      culled += 1;
    } catch (error) {
      console.warn('[reaper] could not drop staged file', row.sha256, error instanceof Error ? error.message : error);
    }
  }
  return { culled };
}

export function scheduleReap(): void {
  void reapGeminiFiles().catch((error) => {
    console.warn('[reaper]', error instanceof Error ? error.message : error);
  });
}
