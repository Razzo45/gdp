import 'server-only';

import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { AuthError, requireActor } from '@/lib/auth/identity';
import type { Actor } from '@/lib/auth/permissions';
import { ServiceError } from '@/lib/services/errors';
import { GeminiError } from '@/lib/ai/gemini';
import { withModelContext } from '@/lib/ai/context';

/**
 * Route handler wrapper: identity, validated body, uniform error shape.
 * Every refusal is a sentence a person can act on; stack traces stay here.
 */

type Params = Record<string, string>;

export interface Ctx<B> {
  actor: Actor;
  body: B;
  params: Params;
  request: Request;
}

export function route<B = undefined>(
  options: { body?: z.ZodType<B>; maxBodyBytes?: number },
  handler: (ctx: Ctx<B>) => Promise<Response | object>,
) {
  return async (request: Request, context: { params: Promise<Params> }): Promise<Response> => {
    try {
      const actor = await requireActor();
      const params = await context.params;
      let body = undefined as B;
      if (options.body) {
        const text = await request.text();
        if (text.length > (options.maxBodyBytes ?? 1_000_000)) return json({ error: 'The request body is too large.' }, 413);
        let raw: unknown;
        try {
          raw = text ? JSON.parse(text) : {};
        } catch {
          return json({ error: 'The request body is not valid JSON.' }, 400);
        }
        const parsed = options.body.safeParse(raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return json({ error: `Invalid request: ${issue ? `${issue.path.join('.') || 'body'} ${issue.message}` : 'malformed body'}.` }, 400);
        }
        body = parsed.data;
      }
      // Model calls made while answering a request are interactive: a person
      // is waiting. They get the reserved slot and stop when the client leaves.
      const result = await withModelContext(
        { ownerId: `user:${actor.id}`, requestClass: 'interactive', signal: request.signal },
        () => handler({ actor, body, params, request }),
      );
      return result instanceof Response ? result : json(result, 200);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function json(value: unknown, status = 200): Response {
  return NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AuthError) return json({ error: error.message }, error.status);
  if (error instanceof ServiceError) return json({ error: error.message, ...(error.detail ?? {}) }, error.status);
  if (error instanceof GeminiError) return json({ error: error.message }, error.kind === 'not_configured' ? 503 : 502);
  console.error('[api] unhandled', error);
  return json({ error: 'Something went wrong on the server. The problem has been logged.' }, 500);
}
