import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { toXlsx } from '@/lib/xlsx';

async function sheetOf(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file('xl/worksheets/sheet1.xml')!.async('string');
}

describe('toXlsx', () => {
  it('sizes each column to its longest value and wraps the ones too long to fit', async () => {
    const long = 'Waiting for a creator 9.5h → Preparing (Ridho) 11.1h → '.repeat(4);
    const sheet = await sheetOf(await toXlsx([['Task', 'Hours', 'Path'], ['19d2f719', 184.6, long]]));
    expect(sheet).toContain('<col min="1" max="1" width="10" customWidth="1" style="3"/>');
    expect(sheet).toContain('<col min="2" max="2" width="7" customWidth="1" style="3"/>');
    expect(sheet).toContain('<col min="3" max="3" width="90" customWidth="1" style="2"/>');
  });

  it('writes numbers as numbers and text as escaped text, with a frozen, filterable header', async () => {
    const sheet = await sheetOf(await toXlsx([['Task', 'Hours'], ['a<b> & "c"', 12.5], ['=SUM(A1)', null]]));
    expect(sheet).toContain('<c r="B2" s="3"><v>12.5</v></c>');
    expect(sheet).toContain('<c r="A2" s="3" t="inlineStr"><is><t xml:space="preserve">a&lt;b&gt; &amp; &quot;c&quot;</t></is></c>');
    expect(sheet).toContain('<c r="A3" s="3" t="inlineStr"><is><t xml:space="preserve">=SUM(A1)</t></is></c>');
    expect(sheet).not.toContain('r="B3"');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:B3"/>');
  });
});
