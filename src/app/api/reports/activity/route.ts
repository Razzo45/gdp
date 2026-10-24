import { route } from '@/lib/api';
import { activityRows, reportRange } from '@/domain/reports';
import { loadReportData } from '@/lib/services/reports';
import { XLSX_TYPE, toXlsx } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

/** Activity workbook: every state change in the window, optionally for one person's tasks. PM / admin / observer. */
export const GET = route({}, async ({ actor, request }) => {
  const query = new URL(request.url).searchParams;
  const range = reportRange({ from: query.get('from'), to: query.get('to') });
  const userId = query.get('user') || null;
  const { tasks, names } = await loadReportData(actor);
  const who = userId ? (names.get(userId) ?? 'person').replace(/[^\w.-]+/g, '-').toLowerCase() : 'everyone';
  return new Response(Buffer.from(await toXlsx(activityRows(tasks, names, range, userId), 'Activity')), {
    status: 200,
    headers: {
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="gdp-activity-${who}-${range.from}-to-${range.to}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
});
