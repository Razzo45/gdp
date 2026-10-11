export type AssignmentSeat = 'rubric' | 'review';

/** Team role that may hold a seat. Admin and PM are not on the team unless they also have this role. */
export function seatTeamRole(seat: AssignmentSeat): 'rubric_creator' | 'reviewer' {
  return seat === 'rubric' ? 'rubric_creator' : 'reviewer';
}

export function seatTeamLabel(seat: AssignmentSeat): string {
  return seat === 'rubric' ? 'Rubric Team' : 'Review Team';
}

export function isEligibleAssignee(roles: readonly string[], seat: AssignmentSeat): boolean {
  return roles.includes(seatTeamRole(seat));
}

/** Rubric seat while the task is with the creators; review seat only in review. */
export function canAssignSeatAt(row: { stage: string }, seat: AssignmentSeat): boolean {
  if (seat === 'rubric') return row.stage === 'rubric';
  return row.stage === 'review';
}
