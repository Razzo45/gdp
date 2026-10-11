import type { Metadata } from 'next';
import { ViewTaskPage } from '@/components/share/ViewTaskPage';
import { ServiceError } from '@/lib/services/errors';
import { sharePack } from '@/lib/services/share';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'GDP Evaluation',
  robots: { index: false, follow: false },
};

export default async function SharedTaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const { id } = await params;
  const { t } = await searchParams;
  try {
    const pack = await sharePack(id, t);
    return <ViewTaskPage pack={pack} token={t ?? ''} />;
  } catch (error) {
    const missing = error instanceof ServiceError && error.status === 404;
    return (
      <div className="grid h-dvh place-items-center bg-paper px-6 text-ink">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">{missing ? 'This link is not valid' : 'The page could not be opened'}</h1>
          <p className="mt-2 text-sm text-muted">
            {missing ? 'Ask the operator for a new View task link.' : error instanceof Error ? error.message : 'Try again in a moment.'}
          </p>
        </div>
      </div>
    );
  }
}
