import { describe, expect, it } from 'vitest';
import { canChangeAiOutputs, canOversee, canRunStability, canSeeSubmission, claimableSeat, holdsReviewSeat, holdsRubricSeat, isController, taskLens, type Actor } from '@/lib/auth/permissions';

const seat = { rubricAssigneeId: 'ana', reviewerId: null as string | null, stage: 'rubric' };

function actor(roles: Actor['roles'] extends ReadonlySet<infer R> ? R[] : never, id = 'x'): Actor {
  return { id, email: `${id}@gdp.local`, displayName: id, roles: new Set(roles), isActive: true };
}

describe('taskLens', () => {
  it('gives admin and PM the controller lens', () => {
    expect(taskLens(actor(['admin'], 'a'), seat)).toBe('controller');
    expect(taskLens(actor(['pm'], 'p'), seat)).toBe('controller');
  });

  it('gives the rubric assignee the rubric lens', () => {
    expect(taskLens(actor(['rubric_creator'], 'ana'), seat)).toBe('rubric');
  });

  it('gives a reviewer-only user the reviewer lens even before they claim', () => {
    expect(taskLens(actor(['reviewer'], 'rita'), seat)).toBe('reviewer');
  });

  it('hides unclaimed work from the group and only offers a blind claim', () => {
    const open = { rubricAssigneeId: null, reviewerId: null, stage: 'rubric' };
    expect(canSeeSubmission(actor(['rubric_creator'], 'ana'), open)).toBe(false);
    expect(claimableSeat(actor(['rubric_creator'], 'ana'), open)).toBe('rubric');
    expect(claimableSeat(actor(['reviewer'], 'rita'), open)).toBeNull();
    expect(canSeeSubmission(actor(['rubric_creator'], 'ana'), seat)).toBe(true);
    expect(canSeeSubmission(actor(['rubric_creator'], 'other'), seat)).toBe(false);
    expect(claimableSeat(actor(['reviewer'], 'rita'), { rubricAssigneeId: 'ana', reviewerId: null, stage: 'review' })).toBe('review');
  });

  it('lets admin attach AI output on an unassigned rubric task', () => {
    const open = { rubricAssigneeId: null, reviewerId: null, stage: 'rubric' };
    expect(canChangeAiOutputs(actor(['admin'], 'a'), open)).toBe(true);
    expect(canChangeAiOutputs(actor(['pm'], 'p'), open)).toBe(true);
    expect(canChangeAiOutputs(actor(['rubric_creator'], 'ana'), open)).toBe(false);
    expect(canChangeAiOutputs(actor(['admin'], 'a'), { ...open, stage: 'review' })).toBe(false);
  });

  it('lets admin and the seated rubric creator run Stability at any stage', () => {
    expect(canRunStability(actor(['admin'], 'a'), seat)).toBe(true);
    expect(canRunStability(actor(['rubric_creator'], 'ana'), seat)).toBe(true);
    expect(canRunStability(actor(['rubric_creator'], 'other'), seat)).toBe(false);
    expect(canRunStability(actor(['reviewer'], 'rita'), seat)).toBe(false);
    expect(canRunStability(actor(['admin'], 'a'), { ...seat, stage: 'review' })).toBe(true);
    expect(canRunStability(actor(['admin'], 'a'), { ...seat, stage: 'stability' })).toBe(true);
    expect(canRunStability(actor(['admin'], 'a'), { ...seat, stage: 'handoff' })).toBe(true);
    expect(canRunStability(actor(['admin'], 'a'), { ...seat, stage: 'done' })).toBe(true);
    expect(canRunStability(actor(['rubric_creator'], 'ana'), { ...seat, stage: 'review' })).toBe(true);
  });

  it('lets an observer see every task the way a PM does, without touching seats or the workflow', () => {
    const overseer = actor(['observer'], 'pat');
    const open = { rubricAssigneeId: null, reviewerId: null, stage: 'rubric' };
    expect(canOversee(overseer)).toBe(true);
    expect(isController(overseer)).toBe(false);
    expect(taskLens(overseer, seat)).toBe('controller');
    expect(canSeeSubmission(overseer, open)).toBe(true);
    expect(canSeeSubmission(overseer, seat)).toBe(true);
    expect(holdsRubricSeat(overseer, seat)).toBe(false);
    expect(holdsRubricSeat(overseer, open)).toBe(false);
    expect(holdsReviewSeat(overseer, { rubricAssigneeId: 'ana', reviewerId: null, stage: 'review' })).toBe(false);
    expect(claimableSeat(overseer, open)).toBeNull();
    expect(canChangeAiOutputs(overseer, open)).toBe(false);
    expect(canRunStability(overseer, seat)).toBe(false);
  });

  it('follows the review seat when someone holds both hats', () => {
    const both = actor(['rubric_creator', 'reviewer'], 'sam');
    expect(taskLens(both, { rubricAssigneeId: 'ana', reviewerId: 'sam', stage: 'review' })).toBe('reviewer');
    expect(taskLens(both, { rubricAssigneeId: 'sam', reviewerId: null, stage: 'rubric' })).toBe('rubric');
  });

  it('blocks dual-role users from claiming review on a task whose rubric seat they hold', () => {
    const both = actor(['rubric_creator', 'reviewer'], 'sam');
    const ownInReview = { rubricAssigneeId: 'sam', reviewerId: null as string | null, stage: 'review' };
    const otherInReview = { rubricAssigneeId: 'ana', reviewerId: null as string | null, stage: 'review' };
    expect(claimableSeat(both, ownInReview)).toBeNull();
    expect(claimableSeat(both, otherInReview)).toBe('review');
    expect(taskLens(both, ownInReview)).toBe('rubric');
  });
});
