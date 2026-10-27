import 'server-only';

import { cookies } from 'next/headers';
import {
  effectiveCaps,
  parseWorkMode,
  usesWorkMode,
  WORK_MODE_COOKIE,
  type SeatCaps,
  type WorkMode,
} from '@/domain/workMode';
import type { Actor } from '@/lib/auth/permissions';

export async function workModeFor(actor: Actor): Promise<WorkMode> {
  if (!usesWorkMode(actor)) return 'rubric';
  return parseWorkMode((await cookies()).get(WORK_MODE_COOKIE)?.value);
}

export async function capsFor(actor: Actor): Promise<SeatCaps> {
  return effectiveCaps(actor, await workModeFor(actor));
}
