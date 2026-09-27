import type { CropVariant, FrameDocument, Ratio } from './model';

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));

export function normalizeCrop(crop: CropVariant): CropVariant {
  const width = clamp(crop.width, 0.12, 1);
  const height = clamp(crop.height, 0.12, 1);
  return {
    ...crop,
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
  };
}

export function cropForRatio(ratio: Ratio, imageRatio: number, current: CropVariant): CropVariant {
  if (ratio === 'free') return { ...current, ratio };
  const [w, h] = ratio.split(':').map(Number);
  const target = w / h;
  let width = 1;
  let height = 1;
  if (target > imageRatio) height = Math.min(1, imageRatio / target);
  else width = Math.min(1, target / imageRatio);
  return normalizeCrop({
    ...current,
    ratio,
    width,
    height,
    x: (1 - width) / 2,
    y: (1 - height) / 2,
  });
}

export function moveCrop(crop: CropVariant, dx: number, dy: number): CropVariant {
  return normalizeCrop({ ...crop, x: crop.x + dx, y: crop.y + dy });
}

export function resizeCrop(crop: CropVariant, width: number, height: number): CropVariant {
  const nextWidth = width;
  let nextHeight = height;
  if (crop.ratio !== 'free') {
    const [w, h] = crop.ratio.split(':').map(Number);
    nextHeight = nextWidth / (w / h);
  }
  return normalizeCrop({ ...crop, width: nextWidth, height: nextHeight });
}

export function makeVariant(crop: CropVariant, id: string): CropVariant {
  return { ...normalizeCrop(crop), id };
}

function cropsEqual(a: CropVariant, b: CropVariant): boolean {
  return a.id === b.id && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.ratio === b.ratio;
}

export function documentsEqual(a: FrameDocument, b: FrameDocument): boolean {
  if (a.image !== b.image) return false;
  if (!cropsEqual(a.crop, b.crop)) return false;
  if (a.guides.thirds !== b.guides.thirds || a.guides.center !== b.guides.center || a.guides.diagonal !== b.guides.diagonal || a.guides.golden !== b.guides.golden) return false;
  if ((a.subject === null) !== (b.subject === null)) return false;
  if (a.subject && b.subject && (a.subject.x !== b.subject.x || a.subject.y !== b.subject.y)) return false;
  if (a.variants.length !== b.variants.length) return false;
  return a.variants.every((variant, index) => cropsEqual(variant, b.variants[index]));
}

export function isFrameDocument(value: unknown): value is FrameDocument {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FrameDocument>;
  return candidate.version === 1 && typeof candidate.guides === 'object' && candidate.crop !== undefined && Array.isArray(candidate.variants);
}
