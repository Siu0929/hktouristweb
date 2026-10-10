// Shared hover behavior for Google Maps AdvancedMarkerElement dots.
//
// On `mouseenter`, the dot scales up (1.4×) and a small floating tooltip pops
// above it showing the place name (and an optional category label). On
// `mouseleave`, both revert. The existing click → InfoWindow flow is left
// untouched — Google Maps still owns the `gmp-click` event and we never
// `preventDefault` or capture it.
//
// Why scale (transform) instead of mutating width/height:
// The selection-resize effect in each map mutates `style.width` /
// `style.height` to mark the chosen marker. Using a transform keeps the two
// effects independent — hover grows the dot without fighting the selected
// state for layout slots.
//
// Usage:
//   const detach = attachMarkerHover(el, { name: spot.name });
//   // call `detach()` if you ever replace `el` so the listeners are released.

export function attachMarkerHover(el, options = {}) {
  if (!el) return () => {};
  const { name, categoryLabel, categoryColor } = options;
  if (!name) return () => {};

  // Anchor tooltip absolutely to the dot. The AdvancedMarkerElement content
  // node is normally `position: static`; promoting it to relative keeps the
  // tooltip from drifting to a far ancestor.
  if (!el.style.position) {
    el.style.position = "relative";
  }
  el.style.transition =
    (el.style.transition
      ? `${el.style.transition}, `
      : "") + "transform 0.18s ease, box-shadow 0.18s ease";

  let tooltip = null;

  const show = () => {
    el.style.transform = "scale(1.4)";
    el.style.boxShadow =
      "0 6px 16px rgba(0,0,0,0.45), 0 0 0 3px rgba(255,255,255,0.6)";
    el.style.zIndex = "50";

    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.style.cssText = `
        position: absolute;
        bottom: calc(100% + 10px);
        left: 50%;
        transform: translateX(-50%);
        background: rgba(17, 24, 39, 0.96);
        color: #fff;
        padding: 6px 10px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.35;
        white-space: nowrap;
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        z-index: 1;
        animation: hk-marker-hover-fade 0.14s ease-out;
      `;

      if (categoryLabel) {
        const cat = document.createElement("div");
        cat.style.cssText = `
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          margin-bottom: 2px;
          color: ${categoryColor || "#f9fafb"};
          opacity: 0.95;
        `;
        cat.textContent = categoryLabel;
        tooltip.appendChild(cat);
      }

      const nameEl = document.createElement("div");
      nameEl.style.cssText = `
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      `;
      nameEl.textContent = name;
      tooltip.appendChild(nameEl);

      // Small caret pointing down at the dot.
      const caret = document.createElement("div");
      caret.style.cssText = `
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-top: 6px solid rgba(17, 24, 39, 0.96);
      `;
      tooltip.appendChild(caret);

      // Inject the keyframes once. We re-use a single id so subsequent calls
      // don't pile up <style> tags.
      if (typeof document !== "undefined" && !document.getElementById("hk-marker-hover-styles")) {
        const style = document.createElement("style");
        style.id = "hk-marker-hover-styles";
        style.textContent = `
          @keyframes hk-marker-hover-fade {
            from { opacity: 0; transform: translate(-50%, 4px); }
            to   { opacity: 1; transform: translate(-50%, 0); }
          }
        `;
        document.head.appendChild(style);
      }

      el.appendChild(tooltip);
    }
    tooltip.style.display = "block";
  };

  const hide = () => {
    el.style.transform = "";
    el.style.boxShadow = "";
    el.style.zIndex = "";
    if (tooltip) tooltip.style.display = "none";
  };

  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);

  return () => {
    el.removeEventListener("mouseenter", show);
    el.removeEventListener("mouseleave", hide);
    if (tooltip && tooltip.parentNode) {
      tooltip.parentNode.removeChild(tooltip);
    }
    tooltip = null;
  };
}
