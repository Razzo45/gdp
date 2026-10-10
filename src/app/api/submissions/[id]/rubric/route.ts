import { route } from '@/lib/api';
import { SaveRequest, saveStatements } from '@/lib/services/rubric';

/** Autosave endpoint. Carries the revision last seen; 409 returns the current state to merge. */
export const PUT = route({ body: SaveRequest }, async ({ actor, body, params }) => saveStatements(actor, params['id']!, body));
