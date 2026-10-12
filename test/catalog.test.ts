import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { catalogAsciiText, catalogRubricItems, catalogTaskPerformance, catalogUploadFilename, taskPerformanceSummaries } from '@/lib/catalog/export';
import { projectDisplayName, readCatalogSubmission, readProjectStatuses } from '@/lib/catalog/read';
import { readSignature, signatureMatches, timestampFresh } from '@/lib/catalog/webhook';

const project = {
  projectId: 'p1',
  name: 'Deck QA',
  formSchema: {
    properties: {
      prompt: { title: 'Prompt', type: 'string' },
      inputFiles: { title: 'Inputs', type: 'array', items: { properties: { inputFile: { type: 'string', format: 'uploader' } } } },
      goldenOutput: { type: 'array', items: { properties: { goldenFile: { type: 'string' } } } },
      rubrics: { type: 'array', items: { properties: { id: { type: 'string' }, statement: { type: 'string' }, tag: { type: 'string' }, answer: { enum: ['Yes', 'No'] } } } },
      taskPerformance: { type: 'object', properties: { goldenOutput: { type: 'string' }, aiOutputHumanEval: { type: 'string' }, stabilityScores: { type: 'string' }, notes: { type: 'string' } }, required: ['goldenOutput', 'aiOutputHumanEval', 'stabilityScores'] },
      secret: { title: 'Secret', type: 'string' },
    },
  },
  workflow: {
    statuses: [
      { statusId: 'st-work', name: 'In progress', uiSchema: { secret: { 'ui:widget': 'hidden' } } },
      { statusId: 'st-review', name: 'Review' },
      { statusId: 'st-done', name: 'Client visible' },
    ],
    transitions: [
      { from: 'st-work', to: 'st-review', trigger: 'submit', displayName: 'Send to review' },
      { from: 'st-review', to: 'st-done', trigger: 'approve', displayName: 'Approve', notes: { isRequired: true } },
    ],
  },
};

const submission = {
  projectId: 'p1',
  projectSubmissionId: 'sub-1',
  submission: {
    prompt: 'Build a 12-slide deck — “Q3 résumé”',
    inputFiles: [{ inputFile: '11111111-2222-3333-4444-555555555555', type: 'Distractor' }],
    goldenOutput: [{ goldenFile: '66666666-7777-8888-9999-000000000000' }],
    secret: 'hidden from the prompt',
  },
  files: [
    { projectSubmissionFileId: '11111111-2222-3333-4444-555555555555', extension: 'xlsx', originalFileName: 'numbers', urls: { download: 'https://s3/numbers?X-Amz-Signature=1' } },
    {
      projectSubmissionFileId: '66666666-7777-8888-9999-000000000000',
      extension: 'pptx',
      originalFileName: 'golden.pptx',
      urls: { download: 'https://s3/golden', thumbnail: 'https://cdn/golden-thumb', preview: 'https://cdn/golden-preview' },
    },
  ],
  user: { displayName: 'Ana' },
  workflowState: { statusId: 'st-work', transitions: [{ destinationSubmissionStatusId: 'st-review' }] },
};

describe('readCatalogSubmission', () => {
  it('reads files, golden/input split, visible fields and transitions', () => {
    const read = readCatalogSubmission(submission, project)!;
    expect(read.id).toBe('sub-1');
    expect(read.projectName).toBe('Deck QA');
    expect(read.statusName).toBe('In progress');
    expect(read.goldenFiles.map((f) => f.name)).toEqual(['golden.pptx']);
    expect(read.goldenFiles[0]!.thumbnailUrl).toBe('https://cdn/golden-thumb');
    expect(read.goldenFiles[0]!.previewUrl).toBe('https://cdn/golden-preview');
    expect(read.inputFiles.map((f) => f.name)).toEqual(['numbers.xlsx']);
    expect(read.inputFiles[0]!.mime).toContain('spreadsheetml');
    expect(read.inputFiles[0]!.role).toBe('Distractor');
    expect(read.fields.map((f) => f.key)).toEqual(['prompt']);
    expect(read.transitions).toEqual([{ to: 'st-review', toName: 'Review', trigger: 'submit', action: 'Send to review', noteRequired: false }]);
    expect(read.author).toBe('Ana');
    expect(read.title).toMatch(/^Build a 12-slide deck/);
  });

  it('tolerates sparse payloads and rejects non-objects', () => {
    expect(readCatalogSubmission({}, null)).not.toBeNull();
    expect(readCatalogSubmission('nope', null)).toBeNull();
  });

  it('reads workflow statuses', () => {
    expect(readProjectStatuses(project)?.statuses.map((s) => s.id)).toEqual(['st-work', 'st-review', 'st-done']);
  });
});

describe('export', () => {
  it('converts outbound text to ASCII without touching structure', () => {
    expect(catalogAsciiText('“Q3 résumé” — naïve • 50 €')).toBe('"Q3 resume" - naive - 50 ');
    expect(catalogAsciiText('a\tb\nc')).toBe('a\tb\nc');
  });

  it('shapes rubric rows to the declared fields', () => {
    const r = catalogRubricItems([{ statement: 'The déck has twelve slides.', family: 'format', answer: 'Yes' }], project);
    expect(r).toEqual({ ok: true, items: [{ id: 's001', statement: 'The deck has twelve slides.', tag: 'Format/File', answer: 'Yes' }] });
  });

  it('refuses when the project cannot carry a verdict', () => {
    const bad = { formSchema: { properties: { rubrics: { items: { properties: { statement: {} } } } } } };
    expect(catalogRubricItems([], bad).ok).toBe(false);
  });

  it('writes taskPerformance only when complete, preserving foreign keys', () => {
    const complete = { goldenPercent: 100, calibrationPercent: 42, stabilityScores: [40, 42, 44] };
    const out = catalogTaskPerformance(complete, project, { notes: 'keep me' })!;
    expect(out['notes']).toBe('keep me');
    expect(out['goldenOutput']).toBe('Golden output score: 100%.');
    expect(out['stabilityScores']).toMatch(/Run 1 40%, Run 2 42%, Run 3 44%.*4 percentage points.*within/);
    expect(catalogTaskPerformance({ ...complete, stabilityScores: null }, project, {})).toBeNull();
    expect(taskPerformanceSummaries({ goldenPercent: null, calibrationPercent: 33.33, stabilityScores: [1, 2, 9] }).stabilityScores).toMatch(/outside/);
  });

  it('validates upload file names', () => {
    expect(catalogUploadFilename('résumé.pptx', 'pptx')).toEqual({ ok: true, fileName: 'resume.pptx' });
    expect(catalogUploadFilename('北京.pptx', 'pptx').ok).toBe(false);
    expect(catalogUploadFilename('x.pptx', 'p p').ok).toBe(false);
  });
});

describe('webhook signature', () => {
  const secret = 'super-secret-key';
  const body = '{"eventId":"e1"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  it('parses and verifies', () => {
    const sig = readSignature(`keyId=k1,sha256=${digest.toUpperCase()}`)!;
    expect(sig.keyId).toBe('k1');
    expect(signatureMatches(sig.digest, body, ts, secret)).toBe(true);
    expect(signatureMatches(sig.digest, body + ' ', ts, secret)).toBe(false);
    expect(signatureMatches(sig.digest, body, ts, 'other')).toBe(false);
    expect(signatureMatches(sig.digest, body, ts, '')).toBe(false);
  });

  it('rejects malformed headers and stale timestamps', () => {
    expect(readSignature(null)).toBeNull();
    expect(readSignature('sha256=zz')).toBeNull();
    expect(timestampFresh(ts)).toBe(true);
    expect(timestampFresh(String(Number(ts) - 600))).toBe(false);
    expect(timestampFresh('abc')).toBe(false);
  });

  it('accepts base64-encoded secrets', () => {
    const raw = Buffer.from('0123456789abcdef0123456789abcdef');
    const b64 = raw.toString('base64');
    const d = createHmac('sha256', raw).update(`${ts}.${body}`).digest('hex');
    expect(signatureMatches(d, body, ts, b64)).toBe(true);
  });
});

describe('project display name', () => {
  it('prefers the watch label, then the Catalog project name', () => {
    expect(projectDisplayName({ label: 'GDP Eval', project })).toBe('GDP Eval');
    expect(projectDisplayName({ label: '', project })).toBe('Deck QA');
    expect(projectDisplayName(null)).toBe('Project');
  });
});
