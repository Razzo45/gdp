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
  });
});
