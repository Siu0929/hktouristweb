"use client";

// =============================================================================
// useBottomPanelDrag
// =============================================================================
// Drag-to-resize hook for the two bottom sheets (PlacesPanel and SpotPopup).
//
// The top gray handle bar on each sheet can be dragged up or down. While
// the user drags, the sheet's height follows the pointer (clamped to
// viewport bounds). When the pointer is released, the sheet snaps to the
// nearest of three discrete positions:
//
//   1. closed   — 48 px  (handle bar only)
//   2. default  — 400 px (current production height)
//   3. expanded — 800 px (double the default)
//
// The drag never settles outside these three positions — any release
// point is rounded to the closest one, so the bottom box can never
// land at, e.g., 250 px (which would clip the tab bar) or 1200 px
// (which would cover the entire viewport on a phone in landscape).
//
// Click vs. drag:
//   - A short tap (no movement past ~4 px) is forwarded to `onClick` so
//     the existing dismiss / close handlers on the handle keep working
//     untouched.
//   - A real drag (>4 px) suppresses the click so dragging the handle
//     doesn't accidentally close the sheet.
//
// Usage:
//   const { onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
//           isDragging } = useBottomPanelDrag({
//     height,
//     onHeightChange,
//     onClick: handleDismiss,
//     sheetRef,
//   });
//   <div ref={sheetRef} className={`... ${height === 'expanded' ? 'expanded' : ''}`}>
//     <div onPointerDown={onPointerDown}
//          onPointerMove={onPointerMove}
//          onPointerUp={onPointerUp}
//          onPointerCancel={onPointerCancel}>handle</div>
//   </div>

import { useCallback, useRef, useState } from "react";

// The three discrete positions the bottom sheet snaps to. The hook
// reads `PANEL_HEIGHT_VALUES[heightKey]` to get the px value and
// `snapToNearestHeight` to find the closest key for an arbitrary
// drag end-point. Both panels (PlacesPanel and SpotPopup) read the
// same constant, so a drag on either handle resolves to the same
// pixel height.
export const PANEL_HEIGHT_VALUES = {
  closed: 48,
  default: 400,
  expanded: 800,
};

export const PANEL_HEIGHT_KEYS = ["closed", "default", "expanded"];

// Distance the pointer must travel before we treat a gesture as a
// drag (rather than a click). Anything shorter fires `onClick`
// instead, so tapping the handle keeps its existing dismiss /
// close behaviour.
const DRAG_THRESHOLD_PX = 4;

// Lower bound for the live drag height — matches the closed state
// (handle bar only). The drag can never shrink the sheet below this.
const MIN_DRAG_HEIGHT_PX = 48;

// Upper bound for the live drag height. Keeps at least
// `MAX_DRAG_HEIGHT_PX` of the map visible above the sheet during
// the drag, so the user can always see what they're about to snap
// to. A full-viewport sheet would also make the close / collapse
// button unreachable, so we cap a bit below the window height.
const MAX_DRAG_KEEP_TOP_PX = 80;

/**
 * Snap an arbitrary pixel height to the nearest of the three discrete
 * positions. Used both during drag (to clamp the live height to the
 * closest legal value) and on release (to commit the final snap).
 */
export function snapToNearestHeight(px) {
  if (!Number.isFinite(px)) return "default";
  let nearestKey = PANEL_HEIGHT_KEYS[0];
  let minDiff = Math.abs(px - PANEL_HEIGHT_VALUES[nearestKey]);
  for (const key of PANEL_HEIGHT_KEYS) {
    const diff = Math.abs(px - PANEL_HEIGHT_VALUES[key]);
    if (diff < minDiff) {
      minDiff = diff;
      nearestKey = key;
    }
  }
  return nearestKey;
}

/**
 * Drag-to-resize handler for a bottom sheet handle.
 *
 * Parameters:
 *   - `height`         — current height key ('closed' | 'default' |
 *                        'expanded'). Used as the starting height
 *                        when a drag begins.
 *   - `onHeightChange` — callback that receives the snapped height
 *                        key when the drag is released.
 *   - `onClick`        — optional click handler. Fires only when the
 *                        pointer never moved past DRAG_THRESHOLD_PX,
 *                        so taps still dismiss / close the sheet.
 *   - `sheetRef`       — ref to the sheet's outer DOM node. The hook
 *                        writes the live drag height to
 *                        `sheet.style.height` (with `transition: none`
 *                        during the drag so the CSS snap animation
 *                        doesn't fight the pointer) and reads it back
 *                        on release to compute the final snap.
 */
export function useBottomPanelDrag({
  height,
  onHeightChange,
  onClick,
  sheetRef,
}) {
  // Pointer-events state lives in a ref so re-renders during a drag
  // don't tear down the gesture. `startHeight` is captured at
  // pointer-down so the drag deltas are measured against the height
  // we started from (not the height after any mid-drag snap).
  const dragStateRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handlePointerDown = useCallback(
    (e) => {
      // Ignore non-primary mouse buttons. Touch and pen always go
      // through (they don't have a meaningful "button" attribute).
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Don't prevent default on every down — the handle is also a
      // tap target, and preventDefault would suppress the
      // subsequent click event on platforms that synthesise click
      // from down/up. We instead rely on pointer capture below to
      // stop the browser from stealing the gesture for scrolling.
      const target = e.currentTarget;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers throw if the pointer is already captured
        // by an ancestor; that's fine — we still get the move/up
        // events because we attached the listener directly.
      }
      dragStateRef.current = {
        pointerId: e.pointerId,
        startY: e.clientY,
        startHeight: PANEL_HEIGHT_VALUES[height] ?? PANEL_HEIGHT_VALUES.default,
        moved: false,
      };
      // Suppress the CSS snap transition while dragging so the
      // height follows the pointer 1:1 with no perceptible lag.
      // The transition is restored on pointer-up (or cancel).
      if (sheetRef?.current) {
        sheetRef.current.style.transition = "none";
      }
      setIsDragging(true);
    },
    [height, sheetRef]
  );

  const handlePointerMove = useCallback(
    (e) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      // Drag-up is "expand" — pointer moves toward the top of the
      // screen, sheet grows. So height delta = startY - clientY.
      const deltaY = state.startY - e.clientY;
      if (Math.abs(deltaY) > DRAG_THRESHOLD_PX) state.moved = true;
      const newHeight = Math.max(
        MIN_DRAG_HEIGHT_PX,
        Math.min(
          (typeof window !== "undefined" ? window.innerHeight : 800) -
            MAX_DRAG_KEEP_TOP_PX,
          state.startHeight + deltaY
        )
      );
      if (sheetRef?.current) {
        sheetRef.current.style.height = `${newHeight}px`;
      }
    },
    [sheetRef]
  );

  // Shared finalisation logic for both pointer-up and pointer-cancel.
  // Reads the live drag height back from the DOM (rather than
  // recomputing it from start + delta) so any rounding performed by
  // the browser lands on the same px the user actually saw.
  const finaliseDrag = useCallback(
    (e) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      const target = e.currentTarget;
      try {
        target.releasePointerCapture(state.pointerId);
      } catch {
        // releasePointerCapture throws if the pointer was already
        // released by the browser (e.g. on touch-cancel); safe to
        // ignore.
      }
      // Restore the CSS snap transition before snapping, so the
      // release animation is visible. Setting the height via React
      // state below triggers the transition automatically once
      // `transition` is back to the stylesheet value.
      if (sheetRef?.current) {
        sheetRef.current.style.transition = "";
        sheetRef.current.style.height = "";
      }
      const liveHeightPx = sheetRef?.current
        ? sheetRef.current.getBoundingClientRect().height
        : PANEL_HEIGHT_VALUES[height] ?? PANEL_HEIGHT_VALUES.default;
      const snappedKey = snapToNearestHeight(liveHeightPx);
      // Only fire the callback if we actually settled on a new
      // position — otherwise re-snapping to the same key on a
      // tap-with-no-move would create a redundant render.
      if (snappedKey !== height) {
        onHeightChange?.(snappedKey);
      }
      const wasClick = !state.moved;
      dragStateRef.current = null;
      setIsDragging(false);
      // Forward a pure tap (no drag) to the click handler. We do
      // this *after* clearing `dragStateRef` so the click handler
      // sees a settled hook.
      if (wasClick && typeof onClick === "function") {
        onClick(e);
      }
    },
    [height, onHeightChange, onClick, sheetRef]
  );

  const handlePointerUp = useCallback(
    (e) => finaliseDrag(e),
    [finaliseDrag]
  );
  const handlePointerCancel = useCallback(
    (e) => finaliseDrag(e),
    [finaliseDrag]
  );

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
    isDragging,
  };
}