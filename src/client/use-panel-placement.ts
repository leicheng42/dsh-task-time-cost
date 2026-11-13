import * as React from 'react';
import { placeStatPanel } from './placement.ts';

type ElementRef = { readonly current: HTMLElement | null };

/** Measure only owned elements; viewport events schedule at most one layout frame. */
export function usePanelPlacement(open: boolean, triggerRef: ElementRef, panelRef: ElementRef, firstActionRef: ElementRef): void {
  React.useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!open || !trigger || !panel) return;
    let frame = 0;
    let disposed = false;
    const write = (key: 'minWidth' | 'maxWidth' | 'maxHeight' | 'left' | 'top', value: number) => {
      const pixels = `${value}px`;
      if (panel.style[key] !== pixels) panel.style[key] = pixels;
    };
    const arrange = () => {
      if (disposed || !trigger.isConnected || !panel.isConnected) return;
      const ratio = panel.getBoundingClientRect().width / panel.offsetWidth;
      const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
      const availableWidth = Math.max(0, window.innerWidth / scale - 24);
      write('minWidth', Math.min(300, availableWidth));
      write('maxWidth', Math.min(440, availableWidth));
      const overlay = Number.parseFloat(getComputedStyle(panel).getPropertyValue('--dsh-frame-overlay-top'));
      const safeTop = Math.max(12, Number.isFinite(overlay) ? overlay : 12) * scale;
      const bounds = panel.getBoundingClientRect();
      const border = panel.offsetHeight - panel.clientHeight;
      const placed = placeStatPanel(trigger.getBoundingClientRect(),
        { width: bounds.width, height: (panel.scrollHeight + border) * scale },
        { width: window.innerWidth, height: window.innerHeight, topInset: safeTop, inset: 12 * scale, gap: 8 * scale });
      write('maxHeight', placed.maxHeight / scale);
      write('left', placed.left / scale);
      write('top', placed.top / scale);
    };
    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; arrange(); });
    };
    arrange();
    firstActionRef.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    observer.observe(trigger);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open, triggerRef, panelRef, firstActionRef]);
}
