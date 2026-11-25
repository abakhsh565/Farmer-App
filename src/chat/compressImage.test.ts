import { describe, expect, it } from 'vitest';
import {
  IMAGE_TARGET_BYTES,
  MAX_EDGE_PX,
  compressImage,
  fitWithin,
  keepsAlpha,
  outputTypeFor,
} from '@/chat/compressImage';

/**
 * The compressor is mostly a policy, and the policy is what these assert: the
 * 400 KB ceiling, that a photo is scaled by its long edge rather than squashed, and
 * that an image already small enough is not re-encoded at all. The canvas work
 * itself is not exercised here — jsdom has no encoder — so what is proven is the
 * arithmetic a photo is put through, not the bytes it produces.
 */
describe('image compression policy', () => {
  it('targets 400 KB', () => {
    expect(IMAGE_TARGET_BYTES).toBe(409_600);
  });

  it('caps the long edge and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024, MAX_EDGE_PX)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, MAX_EDGE_PX)).toEqual({ width: 1200, height: 1600 });
  });

  it('never upscales a small photo', () => {
    expect(fitWithin(640, 480, MAX_EDGE_PX)).toEqual({ width: 640, height: 480 });
  });

  it('survives a nonsense size without dividing by zero', () => {
    expect(fitWithin(0, 0, MAX_EDGE_PX)).toEqual({ width: 0, height: 0 });
  });

  it('keeps a recognised format and falls back to JPEG', () => {
    expect(outputTypeFor('image/png')).toBe('image/png');
    expect(outputTypeFor('image/webp;charset=binary')).toBe('image/webp');
    expect(outputTypeFor('image/gif')).toBe('image/jpeg');
    expect(outputTypeFor(null)).toBe('image/jpeg');
  });

  it('knows which formats carry transparency', () => {
    expect(keepsAlpha('image/png')).toBe(true);
    expect(keepsAlpha('image/jpeg')).toBe(false);
  });

  it('passes an already-small photo through untouched', async () => {
    const small = new Blob([new Uint8Array(1024)], { type: 'image/jpeg' });
    const result = await compressImage(small, { mimeType: 'image/jpeg' });
    expect(result.compressed).toBe(false);
    expect(result.blob).toBe(small);
    expect(result.passes).toBe(0);
    expect(result.originalBytes).toBe(1024);
  });

  it('does not claim a photo was shrunk when it could not encode it', async () => {
    /* 900 KB in a DOM with no canvas encoder: the original comes back, honestly
       labelled as not compressed, so the caller's own size check can refuse it. */
    const large = new Blob([new Uint8Array(900 * 1024)], { type: 'image/jpeg' });
    const result = await compressImage(large, { mimeType: 'image/jpeg' });
    expect(result.compressed).toBe(false);
    expect(result.blob.size).toBe(large.size);
  });
});
