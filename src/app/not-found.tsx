import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex h-dvh items-center justify-center bg-paper px-6">
      <div className="max-w-md">
        <p className="page-kicker">Not found</p>
        <h1 className="page-title mt-1">That page is not here</h1>
        <p className="mt-2 text-sm text-muted">The link is wrong, or the task was removed.</p>
        <Link className="btn btn-primary mt-4 inline-flex" href="/">
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
