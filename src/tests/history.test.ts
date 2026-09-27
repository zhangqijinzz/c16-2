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

describe('FrameSenseViewModel undo / redo', () => {
  let repository: MemoryRepository;
  let vm: FrameSenseViewModel;
  beforeEach(() => { repository = new MemoryRepository(); vm = new FrameSenseViewModel(repository, new FakeImageService()); vm.loadDemo(); });

  it('initializes with no undoable steps', () => {
    const fresh = new FrameSenseViewModel(new MemoryRepository(), new FakeImageService());
    expect(fresh.getSnapshot().canUndo).toBe(false);
    expect(fresh.getSnapshot().canRedo).toBe(false);
    fresh.undo();
    fresh.redo();
    expect(fresh.getSnapshot().canUndo).toBe(false);
    expect(fresh.getSnapshot().canRedo).toBe(false);
  });

  it('undoes and redoes discrete edits in reverse order', () => {
    expect(vm.getSnapshot().canUndo).toBe(false);

    vm.toggleGuide('center');
    vm.markSubject(0.2, 0.8);
    vm.setRatio('1:1');
    vm.saveVariant();
    expect(vm.getSnapshot().canUndo).toBe(true);
    expect(vm.getSnapshot().canRedo).toBe(false);

    vm.undo();
    expect(vm.getSnapshot().document.variants).toHaveLength(0);

    vm.undo();
    expect(vm.getSnapshot().document.crop.ratio).toBe('free');

    vm.undo();
    expect(vm.getSnapshot().document.subject).toBeNull();

    vm.undo();
    expect(vm.getSnapshot().document.guides.center).toBe(false);
    expect(vm.getSnapshot().canUndo).toBe(false);

    vm.redo();
    expect(vm.getSnapshot().document.guides.center).toBe(true);
    vm.redo();
    expect(vm.getSnapshot().document.subject).toEqual({ x: 0.2, y: 0.8 });
    vm.redo();
    expect(vm.getSnapshot().document.crop.ratio).toBe('1:1');
    vm.redo();
    expect(vm.getSnapshot().document.variants).toHaveLength(1);
    expect(vm.getSnapshot().canRedo).toBe(false);
  });

  it('treats one continuous crop drag as a single history step', () => {
    vm.beginCropInteraction('resize');
    vm.resizeCrop(0.5, 0.5);
    vm.endCropInteraction();

    vm.beginCropInteraction('move');
    vm.moveCrop(0.05, 0);
    vm.moveCrop(0.05, 0);
    vm.moveCrop(0.05, 0);
    vm.endCropInteraction();
    expect(vm.getSnapshot().document.crop.x).toBeCloseTo(0.15);

    vm.undo();
    expect(vm.getSnapshot().document.crop.x).toBe(0);
    // 再撤销一步回到缩放之前，说明移动确实只占一步。
    vm.undo();
    expect(vm.getSnapshot().document.crop.width).toBe(1);

    vm.redo();
    expect(vm.getSnapshot().document.crop.width).toBeCloseTo(0.5);
    vm.redo();
    expect(vm.getSnapshot().document.crop.x).toBeCloseTo(0.15);
  });

  it('treats one continuous resize drag as a single history step', () => {
    vm.beginCropInteraction('resize');
    vm.resizeCrop(0.9, 0.9);
    vm.resizeCrop(0.7, 0.7);
    vm.endCropInteraction();
    expect(vm.getSnapshot().document.crop.width).toBeCloseTo(0.7);

    vm.undo();
    expect(vm.getSnapshot().document.crop.width).toBe(1);
  });

  it('does not record a drag that changed nothing', () => {
    vm.beginCropInteraction('move');
    // 边界上继续往外拖会被 clamp，画面无变化。
    vm.moveCrop(0.9, 0.9);
    vm.endCropInteraction();
    expect(vm.getSnapshot().canUndo).toBe(false);
  });

  it('drops the redo branch once a new edit lands after undo', () => {
    vm.markSubject(0.3, 0.3);
    vm.markSubject(0.6, 0.6);
    vm.undo();
    expect(vm.getSnapshot().document.subject).toEqual({ x: 0.3, y: 0.3 });
    expect(vm.getSnapshot().canRedo).toBe(true);

    // 撤销后再改：分支按常规语义被丢弃。
    vm.toggleGuide('golden');
    expect(vm.getSnapshot().canRedo).toBe(false);
    vm.redo();
    expect(vm.getSnapshot().document.guides.golden).toBe(true);
    expect(vm.getSnapshot().document.subject).toEqual({ x: 0.3, y: 0.3 });

    // 继续撤销可以跨过新改动。
    vm.undo();
    expect(vm.getSnapshot().document.guides.golden).toBe(false);
  });

  it('keeps the persisted document in sync with the undone screen', () => {
    vm.markSubject(0.5, 0.5);
    vm.undo();
    expect(repository.document.subject).toBeNull();
    expect(repository.document.crop).toEqual(vm.getSnapshot().document.crop);

    // 模拟刷新：重新从仓库载入，画面与记录一致。
    const reloaded = new FrameSenseViewModel(repository, new FakeImageService());
    void reloaded.initialize();
    expect(reloaded.getSnapshot().document.subject).toBeNull();
  });

  it('ignores no-op edits before an image is loaded', () => {
    const fresh = new FrameSenseViewModel(new MemoryRepository(), new FakeImageService());
    fresh.toggleGuide('center');
    fresh.markSubject(0.5, 0.5);
    fresh.moveCrop(0.1, 0.1);
    fresh.resizeCrop(0.5, 0.5);
    fresh.saveVariant();
    fresh.setRatio('1:1');
    fresh.undo();
    fresh.redo();
    expect(fresh.getSnapshot().canUndo).toBe(false);
    expect(fresh.getSnapshot().canRedo).toBe(false);
    expect(fresh.getSnapshot().document.guides.center).toBe(false);
  });

  it('skips re-selecting the current ratio and already selected variant', () => {
    vm.setRatio('1:1');
    vm.setRatio('1:1');
    vm.saveVariant();
    const id = vm.getSnapshot().document.variants[0].id;
    vm.selectVariant(id);
    expect(vm.getSnapshot().canUndo).toBe(true);
    // 撤销最近一步 = 撤销保存，方案消失。
    vm.undo();
    expect(vm.getSnapshot().document.variants).toHaveLength(0);
    vm.undo();
    expect(vm.getSnapshot().document.crop.ratio).toBe('free');
    expect(vm.getSnapshot().canUndo).toBe(false);
  });

  it('clears history when a new image is loaded', () => {
    vm.markSubject(0.2, 0.2);
    vm.loadDemo();
    expect(vm.getSnapshot().canUndo).toBe(false);
    expect(vm.getSnapshot().document.subject).toBeNull();
  });
});
