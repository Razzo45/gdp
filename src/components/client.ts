'use client';

/** Browser-side fetch helper: JSON in, JSON out, server sentences as errors. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET'),
    headers: {
      ...(init.form ? {} : init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'Cache-Control': 'no-cache',
    },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    credentials: 'same-origin',
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    if (response.status === 401) window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    const { error, ...detail } = data;
    throw new ApiError(response.status, typeof error === 'string' ? error : `Request failed (${response.status}).`, detail);
  }
  return data as T;
}

export const uuid = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export { formatDate, pct, timeAgo } from './format';
