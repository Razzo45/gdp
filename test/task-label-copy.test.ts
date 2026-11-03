import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskLabel } from '@/components/TaskLabel';

describe('TaskLabel copy control', () => {
  it('adds a Copy id button beside the heading id', () => {
    const html = renderToStaticMarkup(
      createElement(TaskLabel, { catalogId: '9a44a52b-ffff-ffff-ffff-ffffffffffff', hero: 'Slide decks', heading: true }),
    );
    expect(html).toContain('>9a44a52b<');
    expect(html).toContain('Copy id');
    expect(html).toContain('title="Copy short id"');
  });

  it('does not show Copy id on board-sized labels', () => {
    const html = renderToStaticMarkup(
      createElement(TaskLabel, { catalogId: '9a44a52b-ffff-ffff-ffff-ffffffffffff', hero: 'Slide decks' }),
    );
    expect(html).toContain('>9a44a52b<');
    expect(html).not.toContain('Copy id');
  });
});
