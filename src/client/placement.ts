export interface PanelAnchor { left: number; top: number; bottom: number }
export interface PanelSize { width: number; height: number }
export interface PanelViewport { width: number; height: number; topInset: number; inset?: number; gap?: number }
export interface PanelPlacement extends PanelSize { left: number; top: number; maxHeight: number }

/** Prefer the native above-trigger seat, flip when needed, then scroll within the larger safe area. */
export function placeStatPanel(anchor: PanelAnchor, size: PanelSize, viewport: PanelViewport): PanelPlacement {
  const inset = viewport.inset ?? 12;
  const gap = viewport.gap ?? 8;
  const leftEdge = Math.min(inset, viewport.width / 2);
  const rightEdge = Math.max(leftEdge, viewport.width - inset);
  const bottomEdge = Math.max(0, viewport.height - inset);
  const topEdge = Math.min(bottomEdge, Math.max(inset, viewport.topInset));
  const width = Math.min(size.width, rightEdge - leftEdge);
  const above = Math.max(0, Math.min(anchor.top - gap, bottomEdge) - topEdge);
  const below = Math.max(0, bottomEdge - Math.max(anchor.bottom + gap, topEdge));
  const useAbove = size.height <= above || size.height > below && above >= below;
  const maxHeight = useAbove ? above : below;
  const height = Math.min(size.height, maxHeight);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  return {
    left: clamp(anchor.left, leftEdge, rightEdge - width),
    top: clamp(useAbove ? anchor.top - gap - height : anchor.bottom + gap, topEdge, bottomEdge - height),
    width, height, maxHeight,
  };
}
