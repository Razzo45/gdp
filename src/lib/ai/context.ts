import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestClass } from './admission';

/**
 * Who a model call is for. The worker sets it per job (background, owner =
 * the task), API routes set it per request (interactive, owner = the person).
 * The admission controller uses it for fairness and the interactive reserve;
 * nothing in the context is ever sent to the provider.
 */
export interface ModelCallContext {
  ownerId: string;
  requestClass: RequestClass;
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<ModelCallContext>();

export const withModelContext = <T>(context: ModelCallContext, fn: () => Promise<T>): Promise<T> => storage.run(context, fn);

export const modelContext = (): ModelCallContext => storage.getStore() ?? { ownerId: 'anonymous', requestClass: 'interactive' };
