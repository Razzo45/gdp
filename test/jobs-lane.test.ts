import { describe, expect, it } from 'vitest';
import { canReuseStagedUri, catalogIdentityMatch, conflictingJob, isHeavyJobPayload, isHeavyMedia, isStatementLane, statementIdsOf } from '@/domain/jobs';

describe('statement lane', () => {
  it('treats 1–8 statement ids as the fast lane', () => {
    expect(isStatementLane({ statementIds: ['a'] })).toBe(true);
    expect(isStatementLane({ statementIds: ['a', 'b'] })).toBe(true);
    expect(isStatementLane({})).toBe(false);
    expect(isStatementLane({ statementIds: Array.from({ length: 9 }, (_, i) => String(i)) })).toBe(false);
    expect(statementIdsOf({ statementIds: ['a', 1, ''] })).toEqual(['a']);
  });

  it('lets two different one-statement reassessments share the queue', () => {
    expect(conflictingJob('golden_autorate', { statementIds: ['b'] }, [{ kind: 'golden_autorate', payload: { statementIds: ['a'] } }])).toBeUndefined();
  });

  it('blocks a reassess of a seat that is already running, and any reassess during a full Golden', () => {
    expect(conflictingJob('golden_autorate', { statementIds: ['a'] }, [{ kind: 'golden_autorate', payload: { statementIds: ['a'] } }])).toBeTruthy();
    expect(conflictingJob('golden_autorate', { statementIds: ['a'] }, [{ kind: 'golden_autorate', payload: {} }])).toBeTruthy();
    expect(conflictingJob('golden_autorate', {}, [{ kind: 'golden_autorate', payload: { statementIds: ['a'] } }])).toBeTruthy();
  });
});

describe('heavy media jobs', () => {
  it('treats video, audio, and 100 MB+ files as heavy, not a small image', () => {
    expect(isHeavyMedia({ mime: 'video/mp4', name: 'golden.mp4', size: 12_000 })).toBe(true);
    expect(isHeavyMedia({ mime: 'audio/mpeg', name: 'voice.mp3' })).toBe(true);
    expect(isHeavyMedia({ mime: '', name: 'take.mov' })).toBe(true);
    expect(isHeavyMedia({ mime: 'image/png', name: 'card.png', size: 100 * 1024 * 1024 })).toBe(true);
    expect(isHeavyMedia({ mime: 'image/png', name: 'card.png', size: 50 * 1024 * 1024 })).toBe(false);
    expect(isHeavyJobPayload({ heavy: true })).toBe(true);
    expect(isHeavyJobPayload({})).toBe(false);
  });
});

describe('catalog identity + URI reuse', () => {
  it('reuses when size and etag match, and refuses a size change', () => {
    expect(catalogIdentityMatch({ size: 2_000_000_000, etag: '"v1"' }, { size: 2_000_000_000, etag: '"v1"' })).toBe(true);
    expect(catalogIdentityMatch({ size: 2_000_000_000, etag: '"v1"' }, { size: 2_000_000_000, etag: '"v2"' })).toBe(false);
    expect(catalogIdentityMatch({ size: 100, etag: null }, { size: 200, etag: null })).toBe(false);
    expect(catalogIdentityMatch({ size: 100, etag: null }, { size: 100, etag: '"x"' })).toBe(true);
  });

  it('reuses a live URI for video and PDF, not for Office', () => {
    expect(canReuseStagedUri('video/mp4', 'golden.mp4')).toBe(true);
    expect(canReuseStagedUri('application/pdf', 'brief.pdf')).toBe(true);
    expect(canReuseStagedUri('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx')).toBe(false);
  });
});
