/** A refusal the UI can show verbatim. Status maps straight to HTTP. */
export class ServiceError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 422 | 502 | 503,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ServiceError(404, `${what} was not found.`);
export const forbidden = (why: string) => new ServiceError(403, why);
export const conflict = (why: string, detail?: Record<string, unknown>) => new ServiceError(409, why, detail);
export const invalid = (why: string, detail?: Record<string, unknown>) => new ServiceError(422, why, detail);
