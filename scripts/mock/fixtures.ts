import { buildDocx, buildPptx, buildXlsx } from './office';

/**
 * A fake Catalog project with realistic shape: a form schema (prompt,
 * inputs, golden, rubrics, taskPerformance), a three-status workflow, and
 * submissions whose files are generated OOXML with deliberate differences
 * between the Golden and the "AI" output so the autorater has work to do.
 */

export const PROJECT_ID = 'proj-fixture-deck-qa';
export const WORK_STATUS = 'st-rubric-work';
export const QA_STATUS = 'st-qa';
export const HANDOFF_STATUS = 'st-client';

export const project = {
  projectId: PROJECT_ID,
  name: 'Fixture - Deck QA',
  formSchema: {
    properties: {
      prompt: { title: 'Task prompt', type: 'string' },
      audience: { title: 'Audience', type: 'string' },
      brandNotes: { title: 'Brand notes', type: 'string' },
      inputFiles: { title: 'Input files', type: 'array', items: { type: 'object', properties: { inputFile: { type: 'string', format: 'uploader' } } } },
      goldenOutput: { title: 'Golden output', type: 'array', items: { type: 'object', properties: { goldenFile: { type: 'string', format: 'uploader' } } } },
      rubrics: {
        title: 'Rubric',
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, statement: { type: 'string' }, tag: { type: 'string' }, answer: { type: 'string', enum: ['Yes', 'No'] } } },
      },
      taskPerformance: {
        title: 'Task performance',
        type: 'object',
        properties: { goldenOutput: { type: 'string' }, aiOutputHumanEval: { type: 'string' }, stabilityScores: { type: 'string' } },
        required: ['goldenOutput', 'aiOutputHumanEval', 'stabilityScores'],
      },
      viewTask: { title: 'Internal link', type: 'string' },
    },
  },
  workflow: {
    statuses: [
      { statusId: WORK_STATUS, name: 'Rubric in progress', uiSchema: { viewTask: { 'ui:widget': 'hidden' } } },
      { statusId: QA_STATUS, name: 'QA review' },
      { statusId: HANDOFF_STATUS, name: 'Client visible' },
    ],
    transitions: [
      { from: WORK_STATUS, to: QA_STATUS, trigger: 'submit', displayName: 'Send to QA' },
      { from: QA_STATUS, to: HANDOFF_STATUS, trigger: 'approve', displayName: 'Approve for client', notes: { isRequired: false } },
      { from: QA_STATUS, to: WORK_STATUS, trigger: 'reject', displayName: 'Send back' },
    ],
  },
};

export interface FixtureFile {
  id: string;
  name: string;
  extension: string;
  build: () => Promise<Uint8Array>;
}

export interface FixtureSubmission {
  id: string;
  values: Record<string, unknown>;
  inputs: FixtureFile[];
  golden: FixtureFile[];
  /** Not part of the Catalog payload: the creator uploads these as "AI output". */
  aiOutputs: FixtureFile[];
  author: { displayName: string; email: string };
}

const FOOTER = 'Northwind Retail · Q3 FY26 Regional Review · Confidential';
const FONT = 'Calibri';

const salesRows: (string | number)[][] = [
  ['Region', 'Q2 revenue (k€)', 'Q3 revenue (k€)', 'QoQ %', 'Stores'],
  ['North', 1240, 1388, 11.9, 42],
  ['South', 980, 1061, 8.3, 35],
  ['East', 1510, 1455, -3.6, 51],
  ['West', 1120, 1305, 16.5, 38],
  ['Total', 4850, 5209, 7.4, 166],
];

const regionTable = (rows: (string | number)[][]) => rows.map((r) => r.map(String));

const goldenDeck = () =>
  buildPptx(
    [
      { title: 'Q3 FY26 Regional Sales Review', bullets: ['Prepared for the regional leadership team', 'Source: Finance data warehouse, closed 30 Sep'], footer: FOOTER, notes: 'Open with the headline: +7.4% QoQ, East is the only decline.' },
      { title: 'Executive summary', bullets: ['Total revenue €5.21m, +7.4% quarter on quarter', 'West led growth at +16.5%; East declined 3.6%', 'Store count stable at 166', 'Recommendation: redeploy East promo budget to West'], footer: FOOTER },
      { title: 'Revenue by region', table: regionTable(salesRows), footer: FOOTER },
      { title: 'North', bullets: ['€1.39m, +11.9% QoQ', '42 stores, two openings in September', 'Loyalty programme uplift visible from week 6'], footer: FOOTER },
      { title: 'South', bullets: ['€1.06m, +8.3% QoQ', '35 stores', 'Back-to-school campaign over-delivered by 4%'], footer: FOOTER },
      { title: 'East', bullets: ['€1.46m, −3.6% QoQ', '51 stores, three refurbishments closed for four weeks', 'Decline fully explained by refurbishment downtime'], footer: FOOTER },
      { title: 'West', bullets: ['€1.31m, +16.5% QoQ', '38 stores', 'New flagship store contributed €95k'], footer: FOOTER },
      { title: 'Next steps', bullets: ['Approve West promo reallocation by 15 Oct', 'East refurbishments reopen 20 Oct', 'Q4 forecast review on 3 Nov'], footer: FOOTER, notes: 'Close on the three dated actions.' },
    ],
    { font: FONT },
  );

/** Deliberately flawed: fewer slides, wrong figure, missing footers, hidden leftover, other font, typo. */
const aiDeck = () =>
  buildPptx(
    [
      { title: 'Q3 Regional Sales Reveiw', bullets: ['Prepared for leadership'], footer: FOOTER },
      { title: 'Summary', bullets: ['Total revenue €5.21m, +7.4% QoQ', 'West grew fastest; East declined', 'Recommendation: increase East promo budget'] },
      { title: 'Revenue by region', table: regionTable(salesRows.map((r) => (r[0] === 'East' ? ['East', 1510, 1545, 2.3, 51] : r))), footer: FOOTER },
      { title: 'Regions', bullets: ['North +11.9%', 'South +8.3%', 'East +2.3%', 'West +16.5%'] },
      { title: 'Draft notes', bullets: ['TODO: confirm store counts'], hidden: true },
      { title: 'Next steps', bullets: ['Approve promo changes', 'Q4 forecast review'], footer: 'Northwind Retail', accent: 'D94F4F' },
    ],
    { font: 'Arial' },
  );

const briefDoc = () =>
  buildDocx([
    { text: 'Q3 Regional Review — brief', heading: true },
    { text: 'Produce an 8-slide 16:9 deck for the regional leadership team summarising Q3 FY26 sales by region using the attached workbook.' },
    { text: 'Requirements', heading: true },
    { text: 'Every slide carries the footer "Northwind Retail · Q3 FY26 Regional Review · Confidential".' },
    { text: 'Use Calibri throughout; the accent colour is navy #1F3A5F.' },
    { text: 'Slide 3 must reproduce the regional revenue table exactly as in the workbook.' },
    { text: 'One slide per region, in the order North, South, East, West.' },
    { text: 'Close with dated next steps. No hidden or draft slides may remain in the file.' },
  ]);

const salesBook = () => buildXlsx([{ name: 'Q3 by region', rows: salesRows }, { name: 'Notes', rows: [['Source'], ['Finance data warehouse, period closed 30 Sep']] }]);

const guideGolden = () =>
  buildDocx([
    { text: 'New starter guide — Customer Support', heading: true },
    { text: 'Welcome to the Customer Support team. This guide covers your first two weeks.' },
    { text: 'Week 1', heading: true },
    { text: 'Day 1: accounts, laptop, and a buddy introduction. Day 2–3: product training. Day 4–5: shadow live chats.' },
    { text: 'Week 2', heading: true },
    { text: 'Handle tickets with your buddy reviewing every reply. Target: 10 resolved tickets by Friday.' },
    { text: 'Escalation', heading: true },
    { text: 'Refunds above €200 and any legal mention go to the team lead within one hour.' },
  ]);

const guideAi = () =>
  buildDocx([
    { text: 'New starter guide', heading: true },
    { text: 'Welcome to Customer Support. This guide covers your first week.' },
    { text: 'Week 1', heading: true },
    { text: 'Day 1: accounts and laptop. Day 2–5: product training and shadowing.' },
    { text: 'Escalation', heading: true },
    { text: 'Refunds above €500 go to the team lead.' },
  ]);

const guideBrief = () =>
  buildDocx([
    { text: 'Brief: onboarding guide', heading: true },
    { text: 'Write a two-week onboarding guide for Customer Support new starters with sections for Week 1, Week 2 and Escalation. Refund escalation threshold is €200; legal mentions escalate within one hour.' },
  ]);

const file = (id: string, name: string, build: () => Promise<Uint8Array>): FixtureFile => ({ id, name, extension: name.split('.').pop()!, build });

export const submissions: FixtureSubmission[] = [
  {
    id: 'sub-q3-regional-deck',
    author: { displayName: 'Ana Torres', email: 'ana@fixture.example' },
    inputs: [file('a1b2c3d4-0001-4000-8000-000000000001', 'q3-sales-by-region.xlsx', salesBook), file('a1b2c3d4-0001-4000-8000-000000000002', 'brief-q3-review.docx', briefDoc)],
    golden: [file('a1b2c3d4-0001-4000-8000-000000000003', 'golden-q3-regional-review.pptx', goldenDeck)],
    aiOutputs: [file('a1b2c3d4-0001-4000-8000-000000000004', 'ai-q3-regional-review.pptx', aiDeck)],
    values: {
      prompt: 'Build an 8-slide 16:9 deck for the regional leadership team summarising Q3 FY26 sales by region from the attached workbook. Follow the brief for footer, font and slide order.',
      audience: 'Regional leadership team (non-technical).',
      brandNotes: 'Navy accent #1F3A5F, Calibri, confidential footer on every slide.',
      viewTask: 'https://catalog.example/tasks/sub-q3-regional-deck',
    },
  },
  {
    id: 'sub-onboarding-guide',
    author: { displayName: 'Ben Okafor', email: 'ben@fixture.example' },
    inputs: [file('a1b2c3d4-0002-4000-8000-000000000001', 'brief-onboarding.docx', guideBrief)],
    golden: [file('a1b2c3d4-0002-4000-8000-000000000002', 'golden-onboarding-guide.docx', guideGolden)],
    aiOutputs: [file('a1b2c3d4-0002-4000-8000-000000000003', 'ai-onboarding-guide.docx', guideAi)],
    values: {
      prompt: 'Write a two-week onboarding guide for Customer Support new starters, following the attached brief.',
      audience: 'New Customer Support hires.',
    },
  },
  {
    id: 'sub-q3-deck-second-pass',
    author: { displayName: 'Chloé Martin', email: 'chloe@fixture.example' },
    inputs: [file('a1b2c3d4-0003-4000-8000-000000000001', 'q3-sales-by-region.xlsx', salesBook), file('a1b2c3d4-0003-4000-8000-000000000002', 'brief-q3-review.docx', briefDoc)],
    golden: [file('a1b2c3d4-0003-4000-8000-000000000003', 'golden-q3-regional-review.pptx', goldenDeck)],
    aiOutputs: [file('a1b2c3d4-0003-4000-8000-000000000004', 'ai-q3-regional-review.pptx', aiDeck)],
    values: {
      prompt: 'Second contributor on the Q3 regional deck task — same brief, used to test two creators holding different tasks.',
      audience: 'Regional leadership team.',
    },
  },
];

export const allFiles = (): FixtureFile[] => submissions.flatMap((s) => [...s.inputs, ...s.golden, ...s.aiOutputs]);

export const MIME: Record<string, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
