import { describe, expect, it } from 'vitest';
import { cropForRatio, documentsEqual, moveCrop, resizeCrop } from '../domain';
import { DEFAULT_CROP, EMPTY_DOCUMENT, type FrameDocument } from '../model';

describe('crop domain rules', () => {
  it('fits a 1:1 crop inside a wide image and centers it', () => {
    const crop = cropForRatio('1:1', 1.5, DEFAULT_CROP);
    expect(crop.width).toBeCloseTo(2 / 3);
    expect(crop.height).toBe(1);
    expect(crop.x).toBeCloseTo(1 / 6);
  });

  it('clamps movement to the image boundary', () => {
    const crop = moveCrop({ ...DEFAULT_CROP, width: 0.5, height: 0.5 }, 0.9, -0.9);
    expect(crop.x).toBe(0.5);
    expect(crop.y).toBe(0);
  });

  it('keeps a selected ratio while resizing', () => {
    const crop = resizeCrop({ ...DEFAULT_CROP, ratio: '16:9', width: 0.5, height: 0.28125 }, 0.8, 0.8);
    expect(crop.width).toBe(0.8);
    expect(crop.height).toBeCloseTo(0.45);
  });

  it('compares documents by content, sharing the image by reference', () => {
    const image = { src: 'data:image/svg+xml,x', width: 100, height: 80, name: 'x.svg' };
    const base: FrameDocument = { ...structuredClone(EMPTY_DOCUMENT), image };
    const same: FrameDocument = { ...base, guides: { ...base.guides }, crop: { ...base.crop }, variants: [] };
    expect(documentsEqual(base, same)).toBe(true);
    expect(documentsEqual(base, { ...same, subject: { x: 0.1, y: 0.2 } })).toBe(false);
    expect(documentsEqual(base, { ...same, guides: { ...same.guides, center: true } })).toBe(false);
    expect(documentsEqual(base, { ...same, crop: { ...same.crop, x: 0.2 } })).toBe(false);
    expect(documentsEqual(base, { ...same, variants: [{ ...same.crop, id: 'variant-1' }] })).toBe(false);
  });
});
