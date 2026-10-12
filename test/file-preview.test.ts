import { describe, expect, it } from 'vitest';
import { prefersDirectAiUpload } from '@/domain/aiUpload';
import { filePreviewActions } from '@/components/FilePreview';

describe('filePreviewActions', () => {
  it('keeps Preview when nothing is rendered inline, and Open window only after it opens', () => {
    expect(filePreviewActions({ canPreview: true, hasInlinePreview: false, previewOpen: false })).toEqual({
      showDownload: true,
      showPreviewToggle: true,
      showOpenWindow: false,
    });
    expect(filePreviewActions({ canPreview: true, hasInlinePreview: false, previewOpen: true })).toEqual({
      showDownload: true,
      showPreviewToggle: true,
      showOpenWindow: true,
    });
  });

  it('uses Open window instead of Preview when a thumbnail is already on the card', () => {
    expect(filePreviewActions({ canPreview: true, hasInlinePreview: true, previewOpen: false })).toEqual({
      showDownload: true,
      showPreviewToggle: false,
      showOpenWindow: true,
    });
  });

  it('still offers Download when the file cannot be previewed', () => {
    expect(filePreviewActions({ canPreview: false, hasInlinePreview: false, previewOpen: false })).toEqual({
      showDownload: true,
      showPreviewToggle: false,
      showOpenWindow: false,
    });
  });
});

describe('prefersDirectAiUpload', () => {
  it('sends files up to 8 MB through the app so the browser is not blocked by storage CORS', () => {
    expect(prefersDirectAiUpload(128_000)).toBe(true);
    expect(prefersDirectAiUpload(8 * 1024 * 1024)).toBe(true);
    expect(prefersDirectAiUpload(8 * 1024 * 1024 + 1)).toBe(false);
    expect(prefersDirectAiUpload(0)).toBe(false);
  });
});
