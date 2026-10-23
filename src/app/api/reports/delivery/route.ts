import { route } from '@/lib/api';
import { deliveryRows, reportRange } from '@/domain/reports';
import { loadReportData } from '@/lib/services/reports';
import { XLSX_TYPE, toXlsx } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

/** Delivery workbook: one row per task that landed in the window. PM / admin only. */
export const GET = route({}, async ({ actor, request }) => {
  const query = new URL(request.url).searchParams;
  const range = reportRange({ from: query.get('from'), to: query.get('to') });
  const { tasks, names } = await loadReportData(actor);
  return new Response(Buffer.from(await toXlsx(deliveryRows(tasks, names, range), 'Delivery')), {
    status: 200,
    headers: {
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="gdp-delivery-${range.from}-to-${range.to}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
});
