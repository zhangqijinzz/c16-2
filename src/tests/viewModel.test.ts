import { beforeEach, describe, expect, it } from 'vitest';
import { FrameSenseViewModel } from '../viewModel';
import { EMPTY_DOCUMENT, type FrameDocument, type ImageAsset } from '../model';
import type { FrameRepository } from '../repository';
import type { ImageService } from '../service';

class MemoryRepository implements FrameRepository {
  document: FrameDocument = structuredClone(EMPTY_DOCUMENT);
  fail = false;
  load() { return structuredClone(this.document); }
  save(document: FrameDocument) { if (this.fail) throw new Error('no storage'); this.document = structuredClone(document); }
}

class FakeImageService implements ImageService {
  asset: ImageAsset = { src: 'data:image/svg+xml,test', width: 1200, height: 800, name: 'test.svg' };
  readFile() { return Promise.resolve(this.asset); }
  demo() { return this.asset; }
}

describe('FrameSenseViewModel', () => {
  let repository: MemoryRepository;
  let vm: FrameSenseViewModel;
  beforeEach(() => { repository = new MemoryRepository(); vm = new FrameSenseViewModel(repository, new FakeImageService()); });

  it('initializes empty and loads a demo image', async () => {
    await vm.initialize();
    expect(vm.getSnapshot().phase).toBe('ready');
    vm.loadDemo();
    expect(vm.getSnapshot().document.image?.name).toBe('test.svg');
    expect(repository.document.image).not.toBeNull();
  });

  it('updates guides, subject, ratio, and variants', () => {
    vm.loadDemo();
    vm.toggleGuide('center');
    vm.markSubject(0.2, 0.8);
    vm.setRatio('1:1');
    vm.saveVariant();
    expect(vm.getSnapshot().document.guides.center).toBe(true);
    expect(vm.getSnapshot().document.subject).toEqual({ x: 0.2, y: 0.8 });
    expect(vm.getSnapshot().document.crop.ratio).toBe('1:1');
    expect(vm.getSnapshot().document.variants).toHaveLength(1);
  });

  it('keeps edits in memory and reports persistence failure', () => {
    repository.fail = true;
    vm.loadDemo();
    expect(vm.getSnapshot().phase).toBe('error');
    expect(vm.getSnapshot().document.image).not.toBeNull();
    expect(vm.getSnapshot().error).toContain('本地保存失败');
  });

  it('undoes and redoes edits across all entry points', () => {
    vm.loadDemo();
    expect(vm.getSnapshot().canUndo).toBe(false);
    vm.toggleGuide('center');
    vm.setRatio('1:1');
    vm.markSubject(0.2, 0.8);
    vm.saveVariant();
    const variantId = vm.getSnapshot().document.variants[0].id;
    vm.setRatio('16:9');
    vm.selectVariant(variantId);
    expect(vm.getSnapshot().document.crop.ratio).toBe('1:1');

    vm.undo();
    expect(vm.getSnapshot().document.crop.ratio).toBe('16:9');
    vm.undo();
    expect(vm.getSnapshot().document.crop.ratio).toBe('1:1');
    vm.undo();
    expect(vm.getSnapshot().document.variants).toHaveLength(0);
    vm.undo();
    expect(vm.getSnapshot().document.subject).toBeNull();
    vm.undo();
    expect(vm.getSnapshot().document.crop.ratio).toBe('free');
    vm.undo();
    expect(vm.getSnapshot().document.guides.center).toBe(false);
    expect(vm.getSnapshot().canUndo).toBe(false);

    vm.redo();
    expect(vm.getSnapshot().document.guides.center).toBe(true);
    vm.redo();
    expect(vm.getSnapshot().document.crop.ratio).toBe('1:1');
    expect(vm.getSnapshot().canRedo).toBe(true);
  });

  it('coalesces a continuous drag into a single undo step', () => {
    vm.loadDemo();
    vm.resizeCrop(0.5, 0.5);
    vm.beginGesture();
    vm.moveCrop(0.05, 0.02);
    vm.moveCrop(0.05, 0.02);
    vm.moveCrop(-0.02, 0.01);
    vm.endGesture();
    expect(vm.getSnapshot().document.crop.x).toBeCloseTo(0.08);
    expect(vm.getSnapshot().document.crop.y).toBeCloseTo(0.05);

    vm.undo();
    expect(vm.getSnapshot().document.crop.x).toBe(0);
    expect(vm.getSnapshot().document.crop.y).toBe(0);
    expect(vm.getSnapshot().canUndo).toBe(true);
    vm.undo();
    expect(vm.getSnapshot().document.crop.width).toBe(1);
    expect(vm.getSnapshot().canUndo).toBe(false);
  });

  it('drops a drag gesture that ends where it started', () => {
    vm.loadDemo();
    vm.resizeCrop(0.5, 0.5);
    vm.beginGesture();
    vm.moveCrop(0.1, 0.05);
    vm.moveCrop(-0.1, -0.05);
    vm.endGesture();
    vm.undo();
    expect(vm.getSnapshot().document.crop.width).toBe(1);
    expect(vm.getSnapshot().canUndo).toBe(false);
  });

  it('discards the redo branch once a new edit is made', () => {
    vm.loadDemo();
    vm.toggleGuide('center');
    vm.toggleGuide('golden');
    vm.undo();
    expect(vm.getSnapshot().canRedo).toBe(true);
    vm.setRatio('1:1');
    expect(vm.getSnapshot().canRedo).toBe(false);
    vm.redo();
    expect(vm.getSnapshot().document.guides.golden).toBe(false);
    expect(vm.getSnapshot().document.crop.ratio).toBe('1:1');
  });

  it('keeps the stored document in sync with undo and redo', () => {
    vm.loadDemo();
    vm.setRatio('1:1');
    vm.markSubject(0.3, 0.3);
    vm.undo();
    expect(repository.document.subject).toBeNull();
    expect(repository.document.crop.ratio).toBe('1:1');
    vm.undo();
    expect(repository.document.crop.ratio).toBe('free');
    vm.redo();
    expect(repository.document.crop.ratio).toBe('1:1');
    expect(repository.document).toEqual(vm.getSnapshot().document);
  });

  it('does not create undoable steps before an image is loaded', async () => {
    await vm.initialize();
    vm.toggleGuide('center');
    vm.toggleGuide('golden');
    expect(vm.getSnapshot().document.guides.center).toBe(true);
    expect(vm.getSnapshot().canUndo).toBe(false);
    expect(vm.getSnapshot().canRedo).toBe(false);
    vm.undo();
    expect(vm.getSnapshot().document.guides.center).toBe(true);
  });

  it('restores a persisted session without undoable steps', async () => {
    repository.document = { ...structuredClone(EMPTY_DOCUMENT), image: { src: 'data:image/svg+xml,saved', width: 800, height: 600, name: 'saved.svg' } };
    await vm.initialize();
    expect(vm.getSnapshot().phase).toBe('editing');
    expect(vm.getSnapshot().canUndo).toBe(false);
    expect(vm.getSnapshot().canRedo).toBe(false);
  });

  it('starts a fresh history when a new image is loaded', () => {
    vm.loadDemo();
    vm.toggleGuide('center');
    expect(vm.getSnapshot().canUndo).toBe(true);
    vm.loadDemo();
    expect(vm.getSnapshot().canUndo).toBe(false);
    expect(vm.getSnapshot().canRedo).toBe(false);
  });

  it('ignores edits that do not change the document', () => {
    vm.loadDemo();
    vm.markSubject(0.5, 0.5);
    vm.markSubject(0.5, 0.5);
    vm.undo();
    expect(vm.getSnapshot().document.subject).toBeNull();
    expect(vm.getSnapshot().canUndo).toBe(false);
  });
});
