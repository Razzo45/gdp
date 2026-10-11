import { describe, expect, it } from 'vitest';
import { catalogViewTask, withCatalogViewTask } from '@/lib/catalog/export';
import { shareVisibleFields } from '@/domain/sharePack';
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

describe('share visible fields', () => {
  it('drops expert review, acceptance criteria, preview image and notes', () => {
    const kept = shareVisibleFields([
      { key: 'generalInformation', label: 'General Information', text: 'Industry: Corporate Communications' },
      { key: 'expertReview', label: 'Expert Review', text: 'Question 1: Answer: Yes' },
      { key: 'previewImage', label: 'Preview image', text: '[file: shot.png]' },
      { key: 'acceptanceCriteria', label: 'Acceptance criteria', text: 'Does the finished video…' },
      { key: 'notes', label: 'Notes', text: 'These two have a partial redundancy.' },
    ]);
    expect(kept.map((f) => f.key)).toEqual(['generalInformation']);
  });
});
