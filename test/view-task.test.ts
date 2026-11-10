import { describe, expect, it } from 'vitest';
import { catalogViewTask, withCatalogViewTask } from '@/lib/catalog/export';
import { briefVisibleFields, shareTaskText, shareVisibleFields } from '@/domain/sharePack';
import { viewTaskHref, viewTaskToken, viewTaskTokenMatches } from '@/domain/viewTask';

describe('viewTask link', () => {
  const secret = 'local-dev-secret-change-me';
  const id = '227841fd-86ea-4e31-bada-12f609950a82';

  it('mints a 32-char token that only matches this task', () => {
    const token = viewTaskToken(secret, id);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(viewTaskTokenMatches(secret, id, token)).toBe(true);
    expect(viewTaskTokenMatches(secret, id, '0'.repeat(32))).toBe(false);
    expect(viewTaskTokenMatches(secret, 'other-id', token)).toBe(false);
    expect(viewTaskTokenMatches('other-secret', id, token)).toBe(false);
  });

  it('builds the Catalog string the View task button opens', () => {
    const token = viewTaskToken(secret, id);
    expect(viewTaskHref('https://gdp.example/', id, token)).toBe(`https://gdp.example/s/${id}?t=${token}`);
    expect(viewTaskHref('http://localhost:3000', id, token)).toBeNull();
    expect(viewTaskHref('', id, token)).toBeNull();
    expect(catalogViewTask('https://gdp.example', id, secret)).toBe(`https://gdp.example/s/${id}?t=${token}`);
    expect(withCatalogViewTask({ rubrics: [] }, 'https://gdp.example/s/x?t=abc')).toEqual({
      rubrics: [],
      viewTask: 'https://gdp.example/s/x?t=abc',
    });
    expect(withCatalogViewTask({ rubrics: [] }, null)).toEqual({ rubrics: [] });
  });
});

describe('share task text', () => {
  it('reads the Catalog task value even when that field is hidden from the prompt list', () => {
    const brief =
      "Hi. I'm a Learning and Development Manager for VitalBridge Health Systems, a large regional healthcare network that provides outpatient care, telehealth services, specialty clinics, and patient support programs across multiple communities.";
    expect(
      shareTaskText(
        {
          values: { task: brief },
          fields: [],
        },
        brief.slice(0, 140),
      ),
    ).toBe(brief);
  });

  it('drops a prepended Expert Reviewer Note and keeps the client brief', () => {
    const brief =
      "Task 1: Trellora Media - Q3 Advertising Health and Q4 Recovery Leadership Briefing\n\nCLIENT BRIEF\n\nI'm the Advertising and Promotions Manager at Trellora Media.";
    expect(
      shareTaskText(
        {
          values: {
            task: `*** Expert Reviewer Note: Task revision reflects/addresses all reviewer feedback, including updated brand/company and added validated findings and proposed actions so the Creator can focus on the presentation rather than the analysis. Thank you! ***\n\n${brief}`,
          },
          fields: [],
        },
        '*** Expert Reviewer Note: Task revision reflects/addresses all reviewer feedback',
      ),
    ).toBe(brief);
  });
});

describe('share visible fields', () => {
  it('drops the task brief (already the page title and Task section), plus expert review, acceptance criteria, preview and notes', () => {
    const kept = shareVisibleFields([
      { key: 'task', label: 'Task', text: 'Deliverable: One editable 18-slide PowerPoint presentation.' },
      { key: 'prompt', label: 'Prompt', text: 'Make a deck.' },
      { key: 'generalInformation', label: 'General Information', text: 'Industry: Corporate Communications' },
      { key: 'expertReview', label: 'Expert Review', text: 'Question 1: Answer: Yes' },
      { key: 'previewImage', label: 'Preview image', text: '[file: shot.png]' },
      { key: 'acceptanceCriteria', label: 'Acceptance criteria', text: 'Does the finished video…' },
      { key: 'notes', label: 'Notes', text: 'These two have a partial redundancy.' },
    ]);
    expect(kept.map((f) => f.key)).toEqual(['generalInformation']);
  });
});

describe('brief visible fields', () => {
  it('drops Expert Review and Preview image, and keeps the task and acceptance criteria', () => {
    const kept = briefVisibleFields([
      { key: 'task', label: 'Task', text: 'Turn the research into a four-ad test.' },
      { key: 'expertQa', label: 'Expert Review', text: 'Question 1: Answer: Yes' },
      { key: 'previewImage', label: 'Preview image', text: '[file: Screenshot 2026-10-05 at 16.49.58.png]' },
      { key: 'acceptanceCriteria', label: 'Acceptance criteria', text: 'Are exactly four ads delivered?' },
    ]);
    expect(kept.map((f) => f.key)).toEqual(['task', 'acceptanceCriteria']);
  });
});
