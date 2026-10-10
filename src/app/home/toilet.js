// =============================================================================
// Toilet-specific logic for the Home page
// =============================================================================

import {
  TOILET_DEFAULT_COLOR,
  TOILET_BARRIER_FREE_COLOR,
} from "./constants";
import { TOILET_SPOTS } from "./spots";
import { isToiletSpot } from "./api";

// =============================================================================
// Toilet filter chip configuration
// =============================================================================

export const TOILET_FILTER = {
  key: "toilets",
  labelKey: "categoryToilets",
  swatch: TOILET_DEFAULT_COLOR,
};

/**
 * Check if a spot matches the toilet filter.
 */
export function matchesToiletFilter(spot) {
  return spot?.category === "toilets";
}

// =============================================================================
// Toilet spot helpers
// =============================================================================

/**
 * Get all static toilet spots (sample toilets across districts).
 */
export function getToiletSpots() {
  return TOILET_SPOTS;
}

/**
 * Filter spots that are toilets.
 */
export function filterToiletSpots(spots) {
  return spots.filter(isToiletSpot);
}

/**
 * Get toilets from nearby results.
 */
export function getNearbyToilets(toilets) {
  return toilets;
}

// =============================================================================
// Toilet metadata helpers
// =============================================================================

/**
 * Check if a toilet is barrier-free (accessible).
 */
export function isBarrierFree(spot) {
  return !!spot?.barrierFree;
}

/**
 * Get toilet type description.
 */
export function getToiletType(spot) {
  return isBarrierFree(spot) ? "Barrier-Free" : "Standard";
}

/**
 * Get toilet category for filtering.
 */
export function getToiletCategory(spot) {
  return isBarrierFree(spot) ? "accessible" : "standard";
}

// =============================================================================
// Toilet color helpers
// =============================================================================

/**
 * Get the color for a toilet marker.
 */
export function getToiletColor(spot, isSelected = false) {
  if (isSelected) return "#ef4444";
  return isBarrierFree(spot) ? TOILET_BARRIER_FREE_COLOR : TOILET_DEFAULT_COLOR;
}

/**
 * Get toilet marker tier.
 * Toilets are always "major" tier (medium dot, hover label).
 */
export function getToiletMarkerTier() {
  return "major";
}

// =============================================================================
// Toilet display helpers
// =============================================================================

/**
 * Format toilet name for display.
 */
export function formatToiletName(name) {
  if (!name) return "Public Toilet";
  if (name.includes("Public Toilet")) return name;
  return `${name} Public Toilet`;
}

/**
 * Format toilet address for display.
 */
export function formatToiletAddress(address) {
  if (!address) return "";
  return address;
}

/**
 * Format distance for display.
 */
export function formatToiletDistance(distanceMetres) {
  if (typeof distanceMetres !== "number") return "";
  if (distanceMetres < 1000) {
    return `${Math.round(distanceMetres)}m`;
  }
  return `${(distanceMetres / 1000).toFixed(1)}km`;
}

// =============================================================================
// Toilet amenities
// =============================================================================

/**
 * Get amenity list for a toilet spot.
 */
export function getToiletAmenities(spot) {
  const amenities = [];
  
  if (isBarrierFree(spot)) {
    amenities.push("Wheelchair Accessible");
  }
  
  // Future: could add more amenities from spot metadata
  // e.g., baby changing, shower, etc.
  
  return amenities;
}

/**
 * Get accessibility description.
 */
export function getAccessibilityDescription(spot) {
  if (isBarrierFree(spot)) {
    return "This toilet is wheelchair accessible.";
  }
  return "Standard public toilet.";
}

// =============================================================================
// Toilet layer toggle
// =============================================================================

/**
 * Check if toilet layer should be visible.
 * Toilets are always visible when the filter is active.
 */
export function isToiletLayerVisible() {
  return true;
}

// =============================================================================
// Toilet grouping helpers
// =============================================================================

/**
 * Group toilets by district.
 */
export function groupToiletsByDistrict(toilets) {
  const groups = {};
  
  for (const toilet of toilets) {
    const district = getToiletDistrict(toilet);
    if (!groups[district]) {
      groups[district] = [];
    }
    groups[district].push(toilet);
  }
  
  return groups;
}

/**
 * Get district for a toilet based on coordinates.
 */
export function getToiletDistrict(spot) {
  const lat = spot?.lat ?? 0;
  const lng = spot?.lng ?? 0;
  
  // Approximate district detection based on coordinates
  if (lng > 114.17 && lat > 22.3) return "Kowloon";
  if (lng < 114.15 && lat < 22.29) return "Hong Kong Island";
  if (lat > 22.32) return "New Territories";
  
  return "Hong Kong";
}

/**
 * Sort toilets by distance.
 */
export function sortToiletsByDistance(toilets) {
  return [...toilets].sort((a, b) => {
    const distA = a.distanceMetres ?? Infinity;
    const distB = b.distanceMetres ?? Infinity;
    return distA - distB;
  });
}

/**
 * Get the closest toilet.
 */
export function getClosestToilet(toilets) {
  const sorted = sortToiletsByDistance(toilets);
  return sorted[0] ?? null;
}

/**
 * Get toilets within a certain distance.
 */
export function getToiletsWithinDistance(toilets, maxDistanceMetres) {
  return toilets.filter(
    (t) => typeof t.distanceMetres === "number" && t.distanceMetres <= maxDistanceMetres
  );
}

// =============================================================================
// Toilet comparison helpers
// =============================================================================

/**
 * Compare two toilets for equality.
 */
export function toiletsEqual(a, b) {
  return a?.id === b?.id;
}

/**
 * Check if toilet data is valid.
 */
export function isValidToilet(spot) {
  if (!spot) return false;
  if (!spot.id) return false;
  if (spot.category !== "toilets") return false;
  if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) return false;
  return true;
}
