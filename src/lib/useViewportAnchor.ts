import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Keeps a `position: fixed` surface (context menu, popover, floating panel)
 * inside the visible window.
 *
 * A menu opened from a right-click carries the pointer coordinates, which are
 * perfectly valid on their own and perfectly wrong near an edge: the menu is
 * laid out from that point and half of it ends up outside the window, where it
 * can neither be seen nor clicked. Wheat runs in a resizable desktop window
 * that users do make small, so every anchored surface has to measure itself
 * and fold back into the viewport.
 *
 * The surface is measured after layout, then:
 *  - flipped to the other side of the anchor when the preferred side has less
 *    room than the opposite one;
 *  - clamped so it never crosses the viewport padding on any edge;
 *  - capped in height, with `maxHeight` returned so the caller can make the
 *    surface scroll instead of letting it grow past the window.
 */
export type ViewportAnchorOptions = {
  /** Anchor point in client coordinates (a pointer position, usually). */
  x: number;
  y: number;
  /** Gap kept between the surface and the window edges. */
  padding?: number;
  /** Recomputes when this changes — pass the open/closed flag or an item count. */
  enabled?: boolean;
};

export type ViewportAnchorResult = {
  left: number;
  top: number;
  maxHeight: number;
  /** True once a real measurement has been applied. */
  measured: boolean;
};

export function useViewportAnchor<T extends HTMLElement>(
  { x, y, padding = 12, enabled = true }: ViewportAnchorOptions,
): [RefObject<T | null>, ViewportAnchorResult] {
  const ref = useRef<T | null>(null);
  const [placement, setPlacement] = useState<ViewportAnchorResult>({ left: x, top: y, maxHeight: 0, measured: false });

  useLayoutEffect(() => {
    if (!enabled) {
      setPlacement({ left: x, top: y, maxHeight: 0, measured: false });
      return undefined;
    }

    const place = () => {
      const node = ref.current;
      if (!node) return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const available = Math.max(80, viewportHeight - padding * 2);

      // Measure the natural size with any previous cap lifted, so a surface
      // that was squeezed once does not stay squeezed after a resize.
      const previousMaxHeight = node.style.maxHeight;
      node.style.maxHeight = "";
      const width = node.offsetWidth;
      const naturalHeight = node.offsetHeight;
      node.style.maxHeight = previousMaxHeight;

      const height = Math.min(naturalHeight, available);
      const spaceBelow = viewportHeight - y - padding;
      const spaceAbove = y - padding;
      // Flip upwards only when it genuinely helps: below is preferred.
      const top = height <= spaceBelow || spaceBelow >= spaceAbove
        ? Math.min(Math.max(padding, y), Math.max(padding, viewportHeight - height - padding))
        : Math.max(padding, y - height);

      const spaceRight = viewportWidth - x - padding;
      const left = width <= spaceRight
        ? Math.max(padding, x)
        : Math.max(padding, Math.min(x - width, viewportWidth - width - padding));

      setPlacement((current) =>
        current.measured && current.left === left && current.top === top && current.maxHeight === available
          ? current
          : { left, top, maxHeight: available, measured: true },
      );
    };

    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [x, y, padding, enabled]);

  return [ref, placement];
}
