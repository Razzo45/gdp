import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDraftPersist } from '@/domain/draftPersist';

describe('createDraftPersist', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the latest grade and evidence, not the value from when save was scheduled', async () => {
    vi.useFakeTimers();
    let draft = { answers: { seat: false }, evidence: { seat: 'Hi this is' } };
    const written: typeof draft[] = [];
    const persist = createDraftPersist(
      () => draft,
      async (next) => {
        written.push(next);
      },
      1200,
    );

    persist.schedule();
    draft = { answers: { seat: true }, evidence: { seat: 'Hi this is me' } };
    await vi.advanceTimersByTimeAsync(1200);

    expect(written).toEqual([{ answers: { seat: true }, evidence: { seat: 'Hi this is me' } }]);
  });

  it('flush writes the latest draft immediately', async () => {
    vi.useFakeTimers();
    let draft = { answers: { seat: false }, evidence: { seat: 'Hi this is' } };
    const written: typeof draft[] = [];
    const persist = createDraftPersist(
      () => draft,
      async (next) => {
        written.push(next);
      },
      1200,
    );

    persist.schedule();
    draft = { answers: { seat: true }, evidence: { seat: 'Hi this is me' } };
    await persist.flush();

    expect(written).toEqual([{ answers: { seat: true }, evidence: { seat: 'Hi this is me' } }]);
  });
});
