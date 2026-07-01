import { Markdown, Text, type Component, type TUI } from '@earendil-works/pi-tui';
import type { Editor } from '@earendil-works/pi-tui';

import { piChalk, piMarkdownTheme } from './themes.js';

export class PiChatLog {
  constructor(
    private readonly tui: TUI,
    private readonly editor: Editor,
  ) {}

  private editorIndex(): number {
    return this.tui.children.indexOf(this.editor);
  }

  insertBeforeEditor(component: Component): void {
    const idx = this.editorIndex();
    if (idx < 0) {
      this.tui.addChild(component);
    } else {
      this.tui.children.splice(idx, 0, component);
    }
    this.tui.requestRender();
  }

  /** Insert immediately before `anchor` (falls back to before editor). */
  insertBefore(component: Component, anchor: Component): void {
    const anchorIdx = this.tui.children.indexOf(anchor);
    if (anchorIdx < 0) {
      this.insertBeforeEditor(component);
      return;
    }
    this.tui.children.splice(anchorIdx, 0, component);
    this.tui.requestRender();
  }

  appendText(text: string, dim = false): Text {
    const comp = new Text(text, 1, 0, dim ? (s) => piChalk.dim(s) : undefined);
    this.insertBeforeEditor(comp);
    return comp;
  }

  appendMarkdown(text: string): Markdown {
    const comp = new Markdown(text, 1, 1, piMarkdownTheme);
    this.insertBeforeEditor(comp);
    return comp;
  }

  remove(component: Component): void {
    this.tui.removeChild(component);
    this.tui.requestRender();
  }
}