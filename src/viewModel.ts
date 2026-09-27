import { useState, useSyncExternalStore } from 'react';
import { cropForRatio, makeVariant, moveCrop, resizeCrop } from './domain';
import { EMPTY_DOCUMENT, type CropVariant, type FrameDocument, type GuideKey, type Ratio, type ViewState } from './model';
import type { FrameRepository } from './repository';
import type { ImageService } from './service';

type Listener = () => void;

export type HistoryLabel =
  | '辅助层开关'
  | '比例切换'
  | '裁切框移动'
  | '裁切框缩放'
  | '主体标记'
  | '保存方案'
  | '切换方案';

interface DocumentSnapshot {
  guides: Record<GuideKey, boolean>;
  subject: { x: number; y: number } | null;
  crop: CropVariant;
  variants: CropVariant[];
}

interface HistoryEntry {
  label: HistoryLabel;
  snapshot: DocumentSnapshot;
}

const HISTORY_LIMIT = 100;

const takeSnapshot = (document: FrameDocument): DocumentSnapshot => ({
  guides: structuredClone(document.guides),
  subject: document.subject ? { ...document.subject } : null,
  crop: structuredClone(document.crop),
  variants: structuredClone(document.variants),
});

const restoreSnapshot = (document: FrameDocument, snapshot: DocumentSnapshot): FrameDocument => ({
  ...document,
  guides: structuredClone(snapshot.guides),
  subject: snapshot.subject ? { ...snapshot.subject } : null,
  crop: structuredClone(snapshot.crop),
  variants: structuredClone(snapshot.variants),
});

const sameGuides = (a: Record<GuideKey, boolean>, b: Record<GuideKey, boolean>): boolean =>
  (Object.keys(a) as GuideKey[]).every((key) => a[key] === b[key]);

const samePoint = (a: { x: number; y: number } | null, b: { x: number; y: number } | null): boolean => {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y;
};

const sameCrop = (a: CropVariant, b: CropVariant): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.ratio === b.ratio;

const sameSnapshot = (a: DocumentSnapshot, b: DocumentSnapshot): boolean =>
  sameGuides(a.guides, b.guides) &&
  samePoint(a.subject, b.subject) &&
  sameCrop(a.crop, b.crop) &&
  JSON.stringify(a.variants) === JSON.stringify(b.variants);

export class FrameSenseViewModel {
  private state: ViewState = { phase: 'loading', document: structuredClone(EMPTY_DOCUMENT), compareOpen: false, notice: '', error: null, canUndo: false, canRedo: false };
  private readonly listeners = new Set<Listener>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  // 一次连续拖动期间，锚定拖动开始时的画面，整次手势只记一步。
  private interaction: { label: HistoryLabel; before: DocumentSnapshot } | null = null;

  constructor(private readonly repository: FrameRepository, private readonly imageService: ImageService) {}

  getSnapshot = (): ViewState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private patch(next: Partial<ViewState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }

  private emit(document: FrameDocument, phase: ViewState['phase'], notice: string, error: string | null): void {
    this.patch({ document, phase, notice, error, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
  }

  private persist(document: FrameDocument, notice: string): void {
    this.emit(document, 'editing', notice, null);
    try {
      this.repository.save(document);
    } catch {
      this.patch({ phase: 'error', error: '本地保存失败，但当前编辑仍保留在页面中。请检查浏览器存储权限。' });
    }
  }

  // 提交一次离散修改：无变化时忽略；否则把修改前快照压入撤销栈并清空重做分支。
  private commit(previous: FrameDocument, next: FrameDocument, label: HistoryLabel, notice: string): void {
    if (sameSnapshot(takeSnapshot(previous), takeSnapshot(next))) return;
    this.undoStack.push({ label, snapshot: takeSnapshot(previous) });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.persist(next, notice);
  }

  // 连续手势（移动/缩放裁切框）期间只更新画面，不写历史。
  private liveUpdate(next: FrameDocument, notice: string): void {
    this.persist(next, notice);
  }

  async initialize(): Promise<void> {
    this.patch({ phase: 'loading', notice: '正在恢复上次工作状态…', error: null });
    try {
      const document = this.repository.load();
      this.undoStack = [];
      this.redoStack = [];
      this.interaction = null;
      this.emit(document, document.image ? 'editing' : 'ready', document.image ? '已恢复上次工作状态' : '欢迎来到 FrameSense，先载入示例或导入图片。', null);
    } catch {
      this.patch({ phase: 'error', notice: '未能读取历史状态，可继续新建工作。', error: '本地数据读取失败。' });
    }
  }

  private resetWithImage(document: FrameDocument, notice: string): void {
    this.undoStack = [];
    this.redoStack = [];
    this.interaction = null;
    this.persist(document, notice);
  }

  async importImage(file: File): Promise<void> {
    this.patch({ phase: 'loading', notice: '正在载入图片…', error: null });
    try {
      const image = await this.imageService.readFile(file);
      const document: FrameDocument = { ...structuredClone(EMPTY_DOCUMENT), image };
      this.resetWithImage(document, '图片已载入，可以开始构图。');
    } catch (error) {
      this.patch({ phase: 'error', error: error instanceof Error ? error.message : '图片载入失败。' });
    }
  }

  loadDemo(): void {
    this.resetWithImage({ ...structuredClone(EMPTY_DOCUMENT), image: this.imageService.demo() }, '示例图片已载入。');
  }

  toggleGuide(guide: GuideKey): void {
    if (!this.state.document.image) return;
    const previous = this.state.document;
    const document = { ...previous, guides: { ...previous.guides, [guide]: !previous.guides[guide] } };
    this.commit(previous, document, '辅助层开关', '辅助层已更新。');
  }

  setRatio(ratio: Ratio): void {
    const image = this.state.document.image;
    if (!image) return;
    const previous = this.state.document;
    if (previous.crop.ratio === ratio) return;
    const crop = cropForRatio(ratio, image.width / image.height, previous.crop);
    this.commit(previous, { ...previous, crop }, '比例切换', `${ratio === 'free' ? '自由' : ratio} 裁切已应用。`);
  }

  beginCropInteraction(mode: 'move' | 'resize'): void {
    if (!this.state.document.image) return;
    if (this.interaction) this.endCropInteraction();
    const label: HistoryLabel = mode === 'move' ? '裁切框移动' : '裁切框缩放';
    this.interaction = { label, before: takeSnapshot(this.state.document) };
  }

  updateCropInteraction(crop: CropVariant, notice: string): void {
    if (!this.interaction) return;
    this.liveUpdate({ ...this.state.document, crop }, notice);
  }

  endCropInteraction(): void {
    const interaction = this.interaction;
    if (!interaction) return;
    this.interaction = null;
    const current = takeSnapshot(this.state.document);
    if (!sameSnapshot(interaction.before, current)) {
      this.undoStack.push({ label: interaction.label, snapshot: interaction.before });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.emit(this.state.document, 'editing', this.state.notice, null);
    }
  }

  moveCrop(dx: number, dy: number): void {
    if (!this.state.document.image) return;
    const previous = this.state.document;
    const crop = moveCrop(previous.crop, dx, dy);
    if (this.interaction) {
      this.updateCropInteraction(crop, '裁切位置已调整。');
    } else {
      this.commit(previous, { ...previous, crop }, '裁切框移动', '裁切位置已调整。');
    }
  }

  resizeCrop(width: number, height: number): void {
    if (!this.state.document.image) return;
    const previous = this.state.document;
    const crop = resizeCrop(previous.crop, width, height);
    if (this.interaction) {
      this.updateCropInteraction(crop, '裁切范围已调整。');
    } else {
      this.commit(previous, { ...previous, crop }, '裁切框缩放', '裁切范围已调整。');
    }
  }

  markSubject(x: number, y: number): void {
    if (!this.state.document.image) return;
    const previous = this.state.document;
    const subject = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    this.commit(previous, { ...previous, subject }, '主体标记', '主体标记已更新。');
  }

  saveVariant(): void {
    if (!this.state.document.image) return;
    const previous = this.state.document;
    const id = `variant-${Date.now()}`;
    const variant = makeVariant(previous.crop, id);
    const document = { ...previous, variants: [...previous.variants, variant].slice(-8) };
    this.commit(previous, document, '保存方案', `已保存裁切方案 ${document.variants.length}。`);
  }

  selectVariant(id: string): void {
    const previous = this.state.document;
    const variant = previous.variants.find((item) => item.id === id);
    if (!variant) return;
    const crop = { ...variant, id: 'current' };
    if (sameCrop(previous.crop, crop)) return;
    this.commit(previous, { ...previous, crop }, '切换方案', '已切换到保存的裁切方案。');
  }

  undo(): void {
    if (!this.state.document.image) return;
    if (this.interaction) this.endCropInteraction();
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ label: entry.label, snapshot: takeSnapshot(this.state.document) });
    const document = restoreSnapshot(this.state.document, entry.snapshot);
    this.persist(document, `已撤销：${entry.label}。`);
  }

  redo(): void {
    if (!this.state.document.image) return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ label: entry.label, snapshot: takeSnapshot(this.state.document) });
    const document = restoreSnapshot(this.state.document, entry.snapshot);
    this.persist(document, `已重做：${entry.label}。`);
  }

  toggleCompare(): void {
    this.patch({ compareOpen: !this.state.compareOpen });
  }
}

export function useFrameSenseViewModel(repository: FrameRepository, imageService: ImageService): [FrameSenseViewModel, ViewState] {
  const [viewModel] = useState(() => new FrameSenseViewModel(repository, imageService));
  const state = useSyncExternalStore(viewModel.subscribe, viewModel.getSnapshot, viewModel.getSnapshot);
  return [viewModel, state];
}
