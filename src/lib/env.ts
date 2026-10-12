import { z } from 'zod';
import { supabaseAuthConfig } from '@/lib/auth/supabasePublic';

/**
 * Server configuration, validated once. Public (browser) values are the two
 * NEXT_PUBLIC_ Supabase settings only; everything else stays on the server.
 *
 * AUTH_MODE
 *   supabase  Supabase Auth; access tokens verified locally.
 *   local     app.profiles + per-user password hashes (Railway). Shared
 *             AUTH_LOCAL_PASSWORD is optional and laptop-only (user picker).
 */
const Schema = z
  .object({
    AUTH_MODE: z.enum(['supabase', 'local']).default('supabase'),
    AUTH_LOCAL_SECRET: z.string().min(16).default('local-dev-secret-change-me'),
    /** Laptop-only shared password. Leave unset on Railway. */
    AUTH_LOCAL_PASSWORD: z.string().min(4).optional(),

    NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
    /** Either the legacy anon JWT or a new `sb_publishable_…` key. */
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(10).optional(),
    /**
     * Service-role / `sb_secret_…` key. Optional: without it invites and
     * Supabase Storage are unavailable (STORAGE_DRIVER=local still works).
     */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).optional(),
    /** HS256 projects. Leave unset for asymmetric-key projects (JWKS is used). */
    SUPABASE_JWT_SECRET: z.string().min(16).optional(),
    DATABASE_URL: z.string().min(1),

    /** Google AI Studio key (`AIza…`). OpenAI `sk-…` keys are rejected at call time. */
    GEMINI_API_KEY: z.string().trim().min(1).optional(),
    GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
    GEMINI_FACTORY_MODEL: z.string().optional(),
    /**
     * Adaptive controller. Defaults sized for a high-tier key on a FIFO
     * queue (one heavy owner). 429s still halt + halve and climb back
     * every INCREASE_AFTER healthy successes.
     */
    GEMINI_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(96),
    GEMINI_CONCURRENCY_FLOOR: z.coerce.number().int().min(1).max(256).default(16),
    GEMINI_CONCURRENCY_INITIAL: z.coerce.number().int().min(1).max(256).default(96),
    /** Defaults to the global ceiling so the one queued user can saturate. */
    GEMINI_OWNER_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(96),
    GEMINI_FILES_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
    /** Successes required for +1 after a 429. Lower = faster recovery. */
    GEMINI_INCREASE_AFTER: z.coerce.number().int().min(1).max(32).default(4),
    GEMINI_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(180_000),
    /**
     * Dev only. Still sends the real generateContent body. A free-tier 429
     * is treated as “the send landed”; a schema-valid stand-in fills the
     * pipeline so rubric / golden / stability can be walked without output tokens.
     */
    GEMINI_MOCK: z.enum(['0', '1']).default('0'),
    AUTORATE_BATCH_SIZE: z.coerce.number().int().min(1).max(25).default(1),

    WIRESTOCK_API_BASE_URL: z.string().url().default('https://api.wirestock.io/data-program/core'),
    WIRESTOCK_API_TOKEN: z.string().min(1).optional(),
    WIRESTOCK_WEBHOOK_SECRET: z.string().min(8).optional(),

    /** Comma-separated emails granted admin on first sign-in. */
    BOOTSTRAP_ADMIN_EMAILS: z.string().default(''),
    PUBLIC_APP_URL: z.string().url().optional(),
    STORAGE_BUCKET: z.string().default('gdp-private'),
    /** `gcs` on Cloud Run, `s3` on Railway buckets, `supabase` if a service key exists, else `local`. */
    STORAGE_DRIVER: z.enum(['gcs', 'supabase', 's3', 'local']).optional(),
    STORAGE_LOCAL_DIR: z.string().default('tmp/storage'),
    /** Railway / S3-compatible bucket. Separate from SES AWS_* keys. */
    STORAGE_S3_ENDPOINT: z.string().url().optional(),
    STORAGE_S3_BUCKET: z.string().optional(),
    STORAGE_S3_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_S3_REGION: z.string().default('auto'),
    /** Set to "0" on web instances when a dedicated worker process runs the queue. */
    RUN_WORKER: z.string().default('1'),
    LIBREOFFICE_BIN: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.AUTH_MODE === 'supabase') {
      const url = value.NEXT_PUBLIC_SUPABASE_URL ?? process.env['SUPABASE_READ_URL']?.trim();
      const key =
        value.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']?.trim() ??
        process.env['SUPABASE_PUBLISHABLE_KEY']?.trim() ??
        value.SUPABASE_SERVICE_ROLE_KEY ??
        process.env['SUPABASE_READ_SERVICE_ROLE_KEY']?.trim();
      if (!url) ctx.addIssue({ code: 'custom', path: ['NEXT_PUBLIC_SUPABASE_URL'], message: 'required when AUTH_MODE=supabase (or set SUPABASE_READ_URL)' });
      if (!key) ctx.addIssue({ code: 'custom', path: ['NEXT_PUBLIC_SUPABASE_ANON_KEY'], message: 'required when AUTH_MODE=supabase (publishable/anon key, or a service-role key on the server)' });
    }
    if (value.STORAGE_DRIVER === 'supabase' && !value.SUPABASE_SERVICE_ROLE_KEY) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_SERVICE_ROLE_KEY'], message: 'required when STORAGE_DRIVER=supabase' });
    }
    if (value.STORAGE_DRIVER === 'gcs' && !value.STORAGE_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['STORAGE_BUCKET'], message: 'required when STORAGE_DRIVER=gcs' });
    }
    if (value.STORAGE_DRIVER === 's3') {
      if (!value.STORAGE_S3_ENDPOINT) ctx.addIssue({ code: 'custom', path: ['STORAGE_S3_ENDPOINT'], message: 'required when STORAGE_DRIVER=s3' });
      if (!value.STORAGE_S3_BUCKET && !value.STORAGE_BUCKET) ctx.addIssue({ code: 'custom', path: ['STORAGE_S3_BUCKET'], message: 'required when STORAGE_DRIVER=s3' });
      if (!value.STORAGE_S3_ACCESS_KEY_ID || !value.STORAGE_S3_SECRET_ACCESS_KEY) {
        ctx.addIssue({ code: 'custom', path: ['STORAGE_S3_ACCESS_KEY_ID'], message: 'required when STORAGE_DRIVER=s3' });
      }
    }
  });

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // `KEY=` in an env file means "not set", not "empty string".
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid server configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const authMode = () => env().AUTH_MODE;
export const geminiMockEnabled = () => env().GEMINI_MOCK === '1';

export type StorageDriver = 'gcs' | 'supabase' | 's3' | 'local';

export function storageDriver(): StorageDriver {
  const e = env();
  return e.STORAGE_DRIVER ?? (e.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'local');
}

export function publicEnv(): { url: string; anonKey: string } {
  const { url, key } = supabaseAuthConfig();
  return { url, anonKey: key };
}

export function bootstrapAdminEmails(): Set<string> {
  return new Set(
    (process.env['BOOTSTRAP_ADMIN_EMAILS'] ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}
