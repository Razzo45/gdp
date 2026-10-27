import { describe, expect, it } from 'vitest';
import {
  effectiveCaps,
  parseWorkMode,
  seatsForMode,
  usesWorkMode,
  WORK_MODE_COOKIE,
} from '@/domain/workMode';
import { claimableSeat, type Actor } from '@/lib/auth/permissions';

function actor(roles: Actor['roles'] extends ReadonlySet<infer R> ? R[] : never, id = 'x'): Actor {
  return { id, email: `${id}@gdp.local`, displayName: id, roles: new Set(roles), isActive: true };
}

describe('parseWorkMode', () => {
  it('defaults missing or junk values to rubric', () => {
    expect(parseWorkMode(undefined)).toBe('rubric');
    expect(parseWorkMode(null)).toBe('rubric');
    expect(parseWorkMode('')).toBe('rubric');
    expect(parseWorkMode('nope')).toBe('rubric');
  });

  it('accepts rubric and review', () => {
    expect(parseWorkMode('rubric')).toBe('rubric');
    expect(parseWorkMode('review')).toBe('review');
  });

  it('exports the cookie name used by the API and RSC', () => {
    expect(WORK_MODE_COOKIE).toBe('gdp_work_mode');
  });
});

describe('usesWorkMode', () => {
  it('is only for dual non-overseer accounts', () => {
    expect(usesWorkMode(actor(['rubric_creator', 'reviewer']))).toBe(true);
    expect(usesWorkMode(actor(['reviewer']))).toBe(false);
    expect(usesWorkMode(actor(['rubric_creator']))).toBe(false);
    expect(usesWorkMode(actor(['admin']))).toBe(false);
    expect(usesWorkMode(actor(['pm', 'rubric_creator', 'reviewer']))).toBe(false);
  });
});

describe('effectiveCaps', () => {
  it('leaves single-role and overseer caps unchanged', () => {
    expect(effectiveCaps(actor(['reviewer']), 'rubric')).toEqual({ canCreateRubrics: false, canReview: true });
    expect(effectiveCaps(actor(['rubric_creator']), 'review')).toEqual({ canCreateRubrics: true, canReview: false });
    expect(effectiveCaps(actor(['admin']), 'review')).toEqual({ canCreateRubrics: true, canReview: true });
  });

  it('narrows dual accounts to one hat at a time', () => {
    const dual = actor(['rubric_creator', 'reviewer']);
    expect(effectiveCaps(dual, 'rubric')).toEqual({ canCreateRubrics: true, canReview: false });
    expect(effectiveCaps(dual, 'review')).toEqual({ canCreateRubrics: false, canReview: true });
  });
});

describe('seatsForMode', () => {
  const rows = [
    { id: 'r1', rubricAssigneeId: 'sam', reviewerId: null as string | null },
    { id: 'v1', rubricAssigneeId: 'ana', reviewerId: 'sam' },
    { id: 'r2', rubricAssigneeId: 'sam', reviewerId: null },
  ];

  it('shows only rubric seats in rubric mode and counts review seats for the nudge', () => {
    expect(seatsForMode(rows, 'sam', 'rubric')).toEqual({
      visible: [rows[0], rows[2]],
      otherHatCount: 1,
    });
  });

  it('shows only review seats in review mode and counts rubric seats for the nudge', () => {
    expect(seatsForMode(rows, 'sam', 'review')).toEqual({
      visible: [rows[1]],
      otherHatCount: 2,
    });
  });
});

describe('claimableSeat with effective caps', () => {
  const dual = actor(['rubric_creator', 'reviewer'], 'sam');
  const openRubric = { rubricAssigneeId: null as string | null, reviewerId: null as string | null, stage: 'rubric' };
  const openReview = { rubricAssigneeId: 'ana', reviewerId: null as string | null, stage: 'review' };
  const ownReview = { rubricAssigneeId: 'sam', reviewerId: null as string | null, stage: 'review' };

  it('in rubric mode offers only rubric claims', () => {
    const caps = effectiveCaps(dual, 'rubric');
    expect(claimableSeat(dual, openRubric, caps)).toBe('rubric');
    expect(claimableSeat(dual, openReview, caps)).toBeNull();
  });

  it('in review mode offers only review claims, and still blocks own rubric seat', () => {
    const caps = effectiveCaps(dual, 'review');
    expect(claimableSeat(dual, openRubric, caps)).toBeNull();
    expect(claimableSeat(dual, openReview, caps)).toBe('review');
    expect(claimableSeat(dual, ownReview, caps)).toBeNull();
  });
});
