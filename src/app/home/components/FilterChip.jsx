// =============================================================================
// FilterChip Component
// Filter chip shown under the search bar. The chip renders as a small
// pill with a colored swatch + icon + label.
// =============================================================================

/**
 * FilterChip - A toggleable filter button component
 * 
 * @param {string} label - Display label for the chip
 * @param {React.Component} Icon - Lucide icon component
 * @param {string} swatch - Hex color for the active state
 * @param {boolean} active - Whether the chip is currently active
 * @param {function} onClick - Click handler
 */
export default function FilterChip({ label, Icon, swatch, active, onClick }) {
  const baseClass =
    "flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold transition-all active:scale-95";
  const stateClass = active
    ? "bg-white shadow-[0_1px_3px_rgba(0,0,0,0.10)]"
    : "bg-white/90 text-[#1f2937] shadow-[0_1px_2px_rgba(0,0,0,0.08)] hover:bg-white";
  
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${baseClass} ${stateClass}`}
      style={
        active
          ? {
              boxShadow: `0 0 0 2px ${swatch}, 0 1px 3px rgba(0,0,0,0.10)`,
              color: swatch,
            }
          : undefined
      }
    >
      {Icon ? (
        <Icon
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: active ? swatch : "#1f2937" }}
        />
      ) : (
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: swatch }}
        />
      )}
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}
