/**
 * Tracks open TUI overlays so global Esc does not abort the agent mid-panel.
 * showSelectOverlay / paginated text push+pop automatically.
 */

let overlayDepth = 0;

export function pushOverlay(): void {
  overlayDepth += 1;
}

export function popOverlay(): void {
  overlayDepth = Math.max(0, overlayDepth - 1);
}

export function isOverlayOpen(): boolean {
  return overlayDepth > 0;
}

export function getOverlayDepth(): number {
  return overlayDepth;
}

/** Test helper — reset depth between cases. */
export function resetOverlayStackForTests(): void {
  overlayDepth = 0;
}
