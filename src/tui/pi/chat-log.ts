import { Markdown, Text, type Component, type TUI } from '@earendil-works/pi-tui';
import type { Editor } from '@earendil-works/pi-tui';

import { piChalk, piMarkdownTheme, piSemantic, type TextStyler } from './themes.js';

export class PiChatLog {
  /** Components kept just above the editor (status / hint); chat inserts above these. */
  private stickyFooter: Component[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly editor: Editor,
  ) {}

  private editorIndex(): number {
    return this.tui.children.indexOf(this.editor);
  }

  /**
   * Register sticky footer components already in the tree (status bar, hints).
   * New chat lines insert above the first sticky component so footers stay docked.
   */
  setStickyFooter(components: Component[]): void {
    this.stickyFooter = components;
  }

  private insertIndex(): number {
    for (const sticky of this.stickyFooter) {
      const idx = this.tui.children.indexOf(sticky);
      if (idx >= 0) return idx;
    }
    return this.editorIndex();
  }

  insertBeforeEditor(component: Component): void {
    const idx = this.insertIndex();
    if (idx < 0) {
      this.tui.addChild(component);
    } else {
      this.tui.children.splice(idx, 0, component);
    }
    this.tui.requestRender();
  }

  /** Insert immediately before `anchor` (falls back to before sticky footer / editor). */
  insertBefore(component: Component, anchor: Component): void {
    const anchorIdx = this.tui.children.indexOf(anchor);
    if (anchorIdx < 0) {
      this.insertBeforeEditor(component);
      return;
    }
    this.tui.children.splice(anchorIdx, 0, component);
    this.tui.requestRender();
  }

  appendText(text: string, dim = false, styler?: TextStyler): Text {
    const style = styler ?? (dim ? piSemantic.metaLine : undefined);
    const comp = new Text(text, 1, 0, style);
    this.insertBeforeEditor(comp);
    return comp;
  }

  /** User task line (SPEC_TUI_POLISH TUI-A): `you › …`. */
  appendUserMessage(text: string): Text {
    const body = text.replace(/\r\n/g, '\n').trimEnd();
    const lines = body.split('\n');
    const formatted =
      lines.length <= 1
        ? `you › ${body}`
        : `you › ${lines[0]}\n${lines
            .slice(1)
            .map((l) => `     ${l}`)
            .join('\n')}`;
    const comp = new Text(formatted, 1, 0, piSemantic.userLine);
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