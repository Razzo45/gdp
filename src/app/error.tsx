'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex h-dvh items-center justify-center bg-paper px-6">
      <div className="max-w-md">
        <p className="page-kicker">Error</p>
        <h1 className="page-title mt-1">This page failed to load</h1>
        <p className="mt-2 text-sm text-muted">{error.message || 'Try again. If it keeps failing, the server log has the digest.'}</p>
        <button className="btn btn-primary mt-4" type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
