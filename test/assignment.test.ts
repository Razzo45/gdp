import { describe, expect, it } from 'vitest';
import { canAssignSeatAt, isEligibleAssignee, seatTeamLabel, seatTeamRole } from '@/domain/assignment';

describe('assignment eligibility', () => {
  it('limits each seat to that team, not admin or PM', () => {
    expect(seatTeamRole('rubric')).toBe('rubric_creator');
    expect(seatTeamRole('review')).toBe('reviewer');
    expect(seatTeamLabel('rubric')).toBe('Rubric Team');
    expect(seatTeamLabel('review')).toBe('Review Team');
    expect(isEligibleAssignee(['rubric_creator'], 'rubric')).toBe(true);
    expect(isEligibleAssignee(['reviewer'], 'review')).toBe(true);
    expect(isEligibleAssignee(['admin', 'pm'], 'rubric')).toBe(false);
    expect(isEligibleAssignee(['admin', 'pm'], 'review')).toBe(false);
    expect(isEligibleAssignee(['pm', 'rubric_creator'], 'rubric')).toBe(true);
    expect(isEligibleAssignee(['reviewer'], 'rubric')).toBe(false);
    expect(isEligibleAssignee(['rubric_creator'], 'review')).toBe(false);
  });

  it('only opens the rubric seat before review and the review seat in review', () => {
    expect(canAssignSeatAt({ stage: 'rubric' }, 'rubric')).toBe(true);
    expect(canAssignSeatAt({ stage: 'rubric' }, 'review')).toBe(false);
    expect(canAssignSeatAt({ stage: 'review' }, 'review')).toBe(true);
    expect(canAssignSeatAt({ stage: 'review' }, 'rubric')).toBe(false);
    expect(canAssignSeatAt({ stage: 'stability' }, 'rubric')).toBe(false);
    expect(canAssignSeatAt({ stage: 'stability' }, 'review')).toBe(false);
  });
});
