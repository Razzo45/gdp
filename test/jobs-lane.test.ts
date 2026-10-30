import { describe, expect, it } from 'vitest';
import {
  archiveMembersStayStaged,
  canReuseStagedUri,
  catalogIdentityMatch,
  conflictingJob,
  isArchiveFile,
  isArchiveJobPayload,
  isFatJobPayload,
  isHeavyJobPayload,
  isHeavyMedia,
  isStatementLane,
  stabilityGradeBatchSize,
  stabilityGradeCalls,
  stabilityGradesInParallel,
  statementIdsOf,
} from '@/domain/jobs';

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

  it('puts a site zip in the archive lane, not the 1 GB video heavy lane', () => {
    expect(isArchiveFile({ mime: 'application/x-zip-compressed', name: 'maison-ai-output.zip' })).toBe(true);
    expect(isHeavyMedia({ mime: 'application/zip', name: 'maison-ai-output.zip', size: 100_899_604 })).toBe(false);
    expect(isHeavyMedia({ mime: 'application/x-zip-compressed', name: 'site.zip', size: 2_000_000 })).toBe(false);
    expect(isHeavyMedia({ mime: '', name: 'bundle.zip', size: 800_000 })).toBe(false);
    expect(isHeavyMedia({ mime: 'video/mp4', name: 'cut.mp4', size: 1_000_000_000 })).toBe(true);
    expect(isHeavyMedia({ mime: 'image/png', name: 'card.png', size: 100 * 1024 * 1024 })).toBe(true);
    expect(isArchiveJobPayload({ archive: true })).toBe(true);
    expect(isArchiveJobPayload({ heavy: true })).toBe(false);
    expect(isFatJobPayload({ archive: true })).toBe(true);
    expect(isFatJobPayload({ heavy: true })).toBe(true);
    expect(isFatJobPayload({})).toBe(false);
  });

  it('stages fat zip members and serialises only archive passes; video still overlaps one-seat calls', () => {
    expect(archiveMembersStayStaged(100_899_604)).toBe(true);
    expect(archiveMembersStayStaged(8 * 1024 * 1024)).toBe(true);
    expect(archiveMembersStayStaged(200_000)).toBe(false);
    expect(stabilityGradesInParallel({ archive: true })).toBe(false);
    expect(stabilityGradesInParallel({ heavy: true })).toBe(true);
    expect(stabilityGradesInParallel({})).toBe(true);
    expect(stabilityGradeBatchSize({ archive: true })).toBeUndefined();
    expect(stabilityGradeBatchSize({ heavy: true })).toBeUndefined();
    expect(stabilityGradeBatchSize({})).toBeUndefined();
    expect(stabilityGradeCalls(50, { archive: true })).toBe(150);
    expect(stabilityGradeCalls(50, { heavy: true })).toBe(150);
    expect(stabilityGradeCalls(50, {})).toBe(150);
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
