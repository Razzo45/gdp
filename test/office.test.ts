import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { officeManifest, officePreviewKind, officeTextDigest } from '@/lib/ai/office';

const slide = (title: string, body: string, extra = '') => `<?xml version="1.0"?>
<p:sld xmlns:p="p" xmlns:a="a"${extra}>
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Inter"/></a:rPr><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

async function pptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
  zip.file('ppt/slides/slide1.xml', slide('Q3 R&amp;D Review', 'Revenue grew 12%.'));
  zip.file('ppt/slides/slide2.xml', slide('Pipeline', 'Three deals &lt;pending&gt;.', ' show="0"').replace('</p:spTree>', '<p:pic/><c:chart xmlns:c="c"/></p:spTree>') + '<p:transition xmlns:p="p"/>');
  zip.file('ppt/slides/slide10.xml', slide('Appendix', 'Sources.'));
  zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes xmlns:p="p" xmlns:a="a"><a:t>Say hello first.</a:t></p:notes>');
  zip.file('ppt/media/image1.png', new Uint8Array([1, 2, 3]));
  zip.file('ppt/media/media1.mp4', new Uint8Array([1]));
  zip.file('ppt/theme/theme1.xml', '<a:theme xmlns:a="a"><a:latin typeface="Calibri"/></a:theme>');
  return zip.generateAsync({ type: 'uint8array' });
}

describe('officePreviewKind', () => {
  it('recognises common Catalog and upload extensions', () => {
    expect(officePreviewKind('deck.pptx', '')).toBe('pptx');
    expect(officePreviewKind('notes.docx', '')).toBe('docx');
    expect(officePreviewKind('old.ppt', 'application/vnd.ms-powerpoint')).toBe('ppt');
    expect(officePreviewKind('clip.mp4', 'video/mp4')).toBeNull();
  });
});

describe('office manifest', () => {
  it('reports deterministic PPTX facts in slide order', async () => {
    const bytes = await pptx();
    const manifest = await officeManifest(bytes, 'pptx');
    expect(manifest).toContain('Slides: 3');
    expect(manifest).toContain('aspect 16:9');
    expect(manifest).toContain('Hidden slides: 1');
    expect(manifest).toContain('Slides with speaker notes: 1');
    expect(manifest).toContain('Slides with pictures: 1; embedded images: 1; videos: 1; audio: 0');
    expect(manifest).toContain('Charts: 1; tables: 0');
    expect(manifest).toContain('Slides with transitions: 1');
    expect(manifest).toContain('Theme fonts: Calibri');
    expect(manifest).toContain('Fonts used on slides: Inter');
    expect(manifest).toMatch(/1\. Q3 R&D Review\n\s+2\. Pipeline\n\s+3\. Appendix/);
  });

  it('digests text with notes and decodes entities', async () => {
    const digest = await officeTextDigest(await pptx(), 'pptx');
    expect(digest).toContain('[Slide 1]');
    expect(digest).toContain('Revenue grew 12%.');
    expect(digest).toContain('[Speaker notes] Say hello first.');
    expect(digest).toContain('Three deals <pending>.');
    expect(digest.indexOf('[Slide 2]')).toBeLessThan(digest.indexOf('[Slide 3]'));
  });

  it('handles docx and xlsx', async () => {
    const doc = new JSZip();
    doc.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p><w:p><w:r><w:t>Body text here.</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:tbl></w:tbl></w:body></w:document>');
    const docx = await doc.generateAsync({ type: 'uint8array' });
    expect(await officeManifest(docx, 'docx')).toContain('Paragraphs: 2; words (approx.): 4; headings: 1');
    expect(await officeManifest(docx, 'docx')).toContain('at least 2 page(s)');
    expect(await officeTextDigest(docx, 'docx')).toBe('Title\nBody text here.');

    const wb = new JSZip();
    wb.file('xl/workbook.xml', '<workbook><sheets><sheet name="Data"/><sheet name="Summary"/></sheets></workbook>');
    wb.file('xl/sharedStrings.xml', '<sst><si><t>Region</t></si><si><t>North</t></si></sst>');
    wb.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c><c><f>A1*2</f><v>84</v></c></row></sheetData></worksheet>');
    const xlsx = await wb.generateAsync({ type: 'uint8array' });
    expect(await officeManifest(xlsx, 'xlsx')).toContain('Sheets (2): Data, Summary');
    expect(await officeTextDigest(xlsx, 'xlsx')).toBe('[Sheet: Data]\nRegion\t42\nNorth\t84');

    const prefixed = new JSZip();
    prefixed.file('xl/workbook.xml', '<x:workbook xmlns:x="x"><x:sheets><x:sheet name="April events"/></x:sheets></x:workbook>');
    prefixed.file('xl/sharedStrings.xml', '<x:sst xmlns:x="x"/>');
    prefixed.file('xl/worksheets/sheet1.xml', '<x:worksheet xmlns:x="x"><x:sheetData><x:row><x:c r="B2" t="str"><x:v>Garden</x:v></x:c></x:row></x:sheetData></x:worksheet>');
    expect(await officeTextDigest(await prefixed.generateAsync({ type: 'uint8array' }), 'xlsx')).toContain('Garden');
    expect(await officeManifest(await prefixed.generateAsync({ type: 'uint8array' }), 'xlsx')).toContain('April events');
  });
});

describe('documentViewHtml', () => {
  it('renders pptx slides, docx text, xlsx sheets and csv tables', async () => {
    const { documentViewHtml, documentViewKind } = await import('@/lib/ai/documentView');
    expect(documentViewKind('deck.pptx', '')).toBe('pptx');
    expect(documentViewKind('notes.csv', 'text/csv')).toBe('csv');

    const deck = await documentViewHtml(await pptx(), 'deck.pptx', '', '/dl');
    expect(deck).toContain('Slide 1');
    expect(deck).toContain('Q3 R&amp;D Review');
    expect(deck).toContain('Revenue grew 12%.');
    expect(deck).toContain('Say hello first.');

    const doc = new JSZip();
    doc.file(
      'word/document.xml',
      '<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p><w:p><w:r><w:t>Body text here.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    );
    const word = await documentViewHtml(await doc.generateAsync({ type: 'uint8array' }), 'brief.docx', '', '/dl');
    expect(word).toContain('Title');
    expect(word).toContain('Body text here.');
    expect(word).toContain('<td>A</td>');

    const wb = new JSZip();
    wb.file('xl/workbook.xml', '<workbook><sheets><sheet name="Data"/></sheets></workbook>');
    wb.file('xl/sharedStrings.xml', '<sst><si><t>Region</t></si></sst>');
    wb.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');
    const sheet = await documentViewHtml(await wb.generateAsync({ type: 'uint8array' }), 'numbers.xlsx', '', '/dl');
    expect(sheet).toContain('Data');
    expect(sheet).toContain('Region');
    expect(sheet).toContain('42');

    const csv = await documentViewHtml(new TextEncoder().encode('name,qty\nCedar,3\n"Quote,d",1\n'), 'items.csv', 'text/csv', '/dl');
    expect(csv).toContain('<th>name</th>');
    expect(csv).toContain('Cedar');
    expect(csv).toContain('Quote,d');
  });

  it('reads Excel files that prefix every tag and store strings in <x:v t=str>', async () => {
    const { documentViewHtml } = await import('@/lib/ai/documentView');
    const wb = new JSZip();
    wb.file('xl/workbook.xml', '<x:workbook xmlns:x="x"><x:sheets><x:sheet name="April events"/></x:sheets></x:workbook>');
    wb.file('xl/sharedStrings.xml', '<x:sst xmlns:x="x"/>');
    wb.file(
      'xl/worksheets/sheet1.xml',
      '<x:worksheet xmlns:x="x"><x:sheetData><x:row r="2"><x:c r="B2" t="str"><x:v>Community Days | April 2027</x:v></x:c></x:row><x:row r="5"><x:c r="B5" t="str"><x:v>Session</x:v></x:c><x:c r="C5" t="str"><x:v>Date</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    );
    const html = await documentViewHtml(await wb.generateAsync({ type: 'uint8array' }), 'cal.xlsx', '', '/dl');
    expect(html).toContain('April events');
    expect(html).toContain('Community Days | April 2027');
    expect(html).toContain('Session');
    expect(html).not.toContain('Empty sheet');
  });
});
