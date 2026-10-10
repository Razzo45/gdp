import JSZip from 'jszip';

/**
 * Small, valid OOXML generators for fixtures. They open in PowerPoint /
 * Excel / Word and render in LibreOffice, and they exercise the manifest
 * reader (titles, notes, hidden slides, fonts, tables).
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};

export interface SlideSpec {
  title: string;
  bullets?: string[];
  footer?: string;
  notes?: string;
  hidden?: boolean;
  table?: string[][];
  /** Hex RGB, e.g. "1F3A5F". */
  accent?: string;
}

const theme = (font: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${NS.a}" name="Fixture">
  <a:themeElements>
    <a:clrScheme name="Fixture">
      <a:dk1><a:srgbClr val="1A1A1A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F3A5F"/></a:dk2><a:lt2><a:srgbClr val="EEF2F7"/></a:lt2>
      <a:accent1><a:srgbClr val="1F3A5F"/></a:accent1><a:accent2><a:srgbClr val="E07A1F"/></a:accent2>
      <a:accent3><a:srgbClr val="4C9F70"/></a:accent3><a:accent4><a:srgbClr val="8E6BBE"/></a:accent4>
      <a:accent5><a:srgbClr val="3F8FD2"/></a:accent5><a:accent6><a:srgbClr val="D94F4F"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Fixture">
      <a:majorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Fixture">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;

const rels = (items: { id: string; type: string; target: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rel}">${items.map((i) => `<Relationship Id="${i.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${i.type}" Target="${i.target}"/>`).join('')}</Relationships>`;

const sp = (id: number, name: string, x: number, y: number, cx: number, cy: number, paragraphs: string, ph?: string, extra = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${extra}</p:spPr><p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;

const para = (text: string, size: number, opts: { bold?: boolean; color?: string; bullet?: boolean; font?: string } = {}) =>
  `<a:p><a:pPr${opts.bullet ? ' marL="342900" indent="-342900"' : ''}>${opts.bullet ? '<a:buChar char="•"/>' : '<a:buNone/>'}</a:pPr><a:r><a:rPr lang="en-US" sz="${size * 100}"${opts.bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${opts.color ?? '1A1A1A'}"/></a:solidFill>${opts.font ? `<a:latin typeface="${opts.font}"/>` : ''}</a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>`;

function tableXml(id: number, rows: string[][]): string {
  const cols = rows[0]?.length ?? 1;
  const width = 10515600;
  const colW = Math.floor(width / cols);
  const cell = (text: string, header: boolean) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(text, 14, { bold: header, color: header ? 'FFFFFF' : '1A1A1A' })}</a:txBody><a:tcPr>${header ? '<a:solidFill><a:srgbClr val="1F3A5F"/></a:solidFill>' : ''}</a:tcPr></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="2200000"/><a:ext cx="${width}" cy="${rows.length * 370840}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join('')}</a:tblGrid>${rows.map((r, i) => `<a:tr h="370840">${r.map((c) => cell(c, i === 0)).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function slideXml(spec: SlideSpec, font: string): string {
  const parts: string[] = [];
  const accent = spec.accent ?? '1F3A5F';
  parts.push(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Accent bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="228600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`);
  parts.push(sp(3, 'Title', 838200, 457200, 10515600, 1143000, para(spec.title, 32, { bold: true, color: accent, font }), 'title'));
  if (spec.bullets?.length) parts.push(sp(4, 'Body', 838200, 1828800, 10515600, 3900000, spec.bullets.map((b) => para(b, 18, { bullet: true, font })).join(''), 'body'));
  if (spec.table) parts.push(tableXml(5, spec.table));
  if (spec.footer) parts.push(sp(6, 'Footer', 838200, 6248400, 10515600, 365125, para(spec.footer, 10, { color: '6B7280', font }), 'ftr'));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}"${spec.hidden ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${parts.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const notesXml = (text: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(2, 'Notes', 685800, 4343400, 5486400, 4114800, para(text, 12), 'body')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;

export async function buildPptx(slides: SlideSpec[], options: { font?: string } = {}): Promise<Uint8Array> {
  const font = options.font ?? 'Calibri';
  const zip = new JSZip();
  const hasNotes = slides.some((s) => s.notes);

  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    ...slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
    ...slides.flatMap((s, i) => (s.notes ? [`<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`] : [])),
    ...(hasNotes ? ['<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>'] : []),
  ];
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`);
  zip.file('_rels/.rels', rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]));

  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('');
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slides.length + 3}"/></p:notesMasterIdLst>` : ''}<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels([
      { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
      { id: 'rId2', type: 'theme', target: 'theme/theme1.xml' },
      ...slides.map((_, i) => ({ id: `rId${i + 3}`, type: 'slide', target: `slides/slide${i + 1}.xml` })),
      ...(hasNotes ? [{ id: `rId${slides.length + 3}`, type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' }] : []),
    ]),
  );

  const clrMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  const emptyTree = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>';
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}">${emptyTree}${clrMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }, { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' }]));
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}" type="obj" preserve="1">${emptyTree}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]));
  zip.file('ppt/theme/theme1.xml', theme(font));

  if (hasNotes) {
    zip.file('ppt/notesMasters/notesMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notesMaster xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}">${emptyTree}${clrMap}</p:notesMaster>`);
    zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([{ id: 'rId1', type: 'theme', target: '../theme/theme1.xml' }]));
  }

  slides.forEach((spec, i) => {
    const n = i + 1;
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(spec, font));
    const slideRels = [{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }];
    if (spec.notes) {
      slideRels.push({ id: 'rId2', type: 'notesSlide', target: `../notesSlides/notesSlide${n}.xml` });
      zip.file(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(spec.notes));
      zip.file(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, rels([{ id: 'rId1', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' }, { id: 'rId2', type: 'slide', target: `../slides/slide${n}.xml` }]));
    }
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, rels(slideRels));
  });

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function buildXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const strings: string[] = [];
  const sIndex = (s: string) => {
    let i = strings.indexOf(s);
    if (i === -1) {
      strings.push(s);
      i = strings.length - 1;
    }
    return i;
  };
  const col = (n: number) => {
    let s = '';
    n += 1;
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const sheetXml = sheets.map(
    (sheet) =>
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows
        .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${sIndex(v)}</v></c>`)).join('')}</row>`)
        .join('')}</sheetData></worksheet>`,
  );
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', rels([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]));
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS.r}"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', rels([...sheets.map((_, i) => ({ id: `rId${i + 1}`, type: 'worksheet', target: `worksheets/sheet${i + 1}.xml` })), { id: `rId${sheets.length + 1}`, type: 'sharedStrings', target: 'sharedStrings.xml' }]));
  sheetXml.forEach((xml, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, xml));
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function buildDocx(paragraphs: { text: string; heading?: boolean }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', rels([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]));
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${w}"><w:body>${paragraphs
      .map((p) => `<w:p>${p.heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''}<w:r>${p.heading ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(p.text)}</w:t></w:r></w:p>`)
      .join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
