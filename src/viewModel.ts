import { useState, useSyncExternalStore } from 'react';
import { cropForRatio, documentsEqual, makeVariant, moveCrop, resizeCrop } from './domain';
import { EMPTY_DOCUMENT, type FrameDocument, type GuideKey, type Ratio, type ViewState } from './model';
import type { FrameRepository } from './repository';
import type { ImageService } from './service';

type Listener = () => void;

const HISTORY_LIMIT = 100;

export class FrameSenseViewModel {
  private state: ViewState = { phase: 'loading', document: structuredClone(EMPTY_DOCUMENT), compareOpen: false, notice: '', error: null, canUndo: false, canRedo: false };
  private readonly listeners = new Set<Listener>();
  private history: FrameDocument[] = [];
  private historyIndex = -1;
  private gestureActive = false;
  private gestureRecorded = false;

  constructor(private readonly repository: FrameRepository, private readonly imageService: ImageService) {}

  getSnapshot = (): ViewState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private patch(next: Partial<ViewState>): void {
    this.state = { ...this.state, ...next, canUndo: this.historyIndex > 0, canRedo: this.historyIndex < this.history.length - 1 };
    this.listeners.forEach((listener) => listener());
  }

  private commit(document: FrameDocument, notice: string, record: boolean): void {
    if (record) this.record(document);
    this.patch({ document, phase: 'editing', notice, error: null });
    try {
      this.repository.save(document);
    } catch {
      this.patch({ phase: 'error', error: '本地保存失败，但当前编辑仍保留在页面中。请检查浏览器存储权限。' });
    }
  }

  private persist(document: FrameDocument, notice: string): void {
    this.commit(document, notice, true);
  }

  private record(document: FrameDocument): void {
    if (!document.image) return;
    if (this.gestureActive && this.gestureRecorded) {
      this.history[this.historyIndex] = document;
      return;
    }
    const current = this.history[this.historyIndex];
    if (current && documentsEqual(current, document)) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(document);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.historyIndex = this.history.length - 1;
    if (this.gestureActive) this.gestureRecorded = true;
  }

  private resetHistory(document: FrameDocument): void {
    this.history = document.image ? [document] : [];
    this.historyIndex = this.history.length - 1;
    this.gestureActive = false;
    this.gestureRecorded = false;
  }

  beginGesture(): void {
    this.gestureActive = true;
    this.gestureRecorded = false;
  }

  endGesture(): void {
    if (this.gestureActive && this.gestureRecorded) {
      const current = this.history[this.historyIndex];
      const previous = this.history[this.historyIndex - 1];
      if (current && previous && documentsEqual(current, previous)) {
        this.history.pop();
        this.historyIndex -= 1;
        this.patch({ document: previous });
      }
    }
    this.gestureActive = false;
    this.gestureRecorded = false;
  }

  undo(): void {
    if (this.gestureActive || this.historyIndex <= 0) return;
    this.historyIndex -= 1;
    this.commit(this.history[this.historyIndex], '已撤销一步操作。', false);
  }

  redo(): void {
    if (this.gestureActive || this.historyIndex >= this.history.length - 1) return;
    this.historyIndex += 1;
    this.commit(this.history[this.historyIndex], '已重做一步操作。', false);
  }

  async initialize(): Promise<void> {
    this.patch({ phase: 'loading', notice: '正在恢复上次工作状态…', error: null });
    try {
      const document = this.repository.load();
      this.resetHistory(document);
      this.patch({ document, phase: document.image ? 'editing' : 'ready', notice: document.image ? '已恢复上次工作状态' : '欢迎来到 FrameSense，先载入示例或导入图片。' });
    } catch {
      this.patch({ phase: 'error', notice: '未能读取历史状态，可继续新建工作。', error: '本地数据读取失败。' });
    }
  }

  async importImage(file: File): Promise<void> {
    this.patch({ phase: 'loading', notice: '正在载入图片…', error: null });
    try {
      const image = await this.imageService.readFile(file);
      const document: FrameDocument = { ...structuredClone(EMPTY_DOCUMENT), image };
      this.resetHistory(document);
      this.persist(document, '图片已载入，可以开始构图。');
    } catch (error) {
      this.patch({ phase: 'error', error: error instanceof Error ? error.message : '图片载入失败。' });
    }
  }

  loadDemo(): void {
    const document = { ...structuredClone(EMPTY_DOCUMENT), image: this.imageService.demo() };
    this.resetHistory(document);
    this.persist(document, '示例图片已载入。');
  }

  toggleGuide(guide: GuideKey): void {
    const document = { ...this.state.document, guides: { ...this.state.document.guides, [guide]: !this.state.document.guides[guide] } };
    this.persist(document, '辅助层已更新。');
  }

  setRatio(ratio: Ratio): void {
    const image = this.state.document.image;
    if (!image) return;
    const crop = cropForRatio(ratio, image.width / image.height, this.state.document.crop);
    this.persist({ ...this.state.document, crop }, `${ratio === 'free' ? '自由' : ratio} 裁切已应用。`);
  }

  moveCrop(dx: number, dy: number): void {
    this.persist({ ...this.state.document, crop: moveCrop(this.state.document.crop, dx, dy) }, '裁切位置已调整。');
  }

  resizeCrop(width: number, height: number): void {
    this.persist({ ...this.state.document, crop: resizeCrop(this.state.document.crop, width, height) }, '裁切范围已调整。');
  }

  markSubject(x: number, y: number): void {
    this.persist({ ...this.state.document, subject: { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) } }, '主体标记已更新。');
  }

  saveVariant(): void {
    const id = `variant-${Date.now()}`;
    const variant = makeVariant(this.state.document.crop, id);
    const document = { ...this.state.document, variants: [...this.state.document.variants, variant].slice(-8) };
    this.persist(document, `已保存裁切方案 ${document.variants.length}。`);
  }

  selectVariant(id: string): void {
    const variant = this.state.document.variants.find((item) => item.id === id);
    if (!variant) return;
    this.persist({ ...this.state.document, crop: { ...variant, id: 'current' } }, '已切换到保存的裁切方案。');
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
