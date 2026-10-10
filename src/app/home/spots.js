// =============================================================================
// Tourist spots data — attractions and toilets
// =============================================================================

// =============================================================================
// Attractions
// =============================================================================

export const ATTRACTION_SPOTS = [
  { id: "victoria-peak", name: "Victoria Peak", category: "attractions", lat: 22.2697, lng: 114.1447 },
  { id: "star-ferry", name: "Star Ferry Pier (TST)", category: "attractions", lat: 22.2936, lng: 114.169 },
  { id: "tst-promenade", name: "Tsim Sha Tsui Promenade", category: "attractions", lat: 22.295, lng: 114.1725 },
  { id: "kowloon-park", name: "Kowloon Park", category: "attractions", lat: 22.3014, lng: 114.1718 },
  { id: "temple-street", name: "Temple Street Night Market", category: "attractions", lat: 22.3041, lng: 114.1727 },
  { id: "man-mo", name: "Man Mo Temple", category: "attractions", lat: 22.2819, lng: 114.1747 },
  { id: "science-museum", name: "Hong Kong Science Museum", category: "attractions", lat: 22.2985, lng: 114.1738 },
  { id: "history-museum", name: "Hong Kong Museum of History", category: "attractions", lat: 22.2996, lng: 114.1753 },
  { id: "disneyland", name: "Hong Kong Disneyland", category: "attractions", lat: 22.313, lng: 114.0413 },
  { id: "ocean-park", name: "Ocean Park", category: "attractions", lat: 22.247, lng: 114.1744 },
  { id: "big-buddha", name: "Tian Tan Buddha (Ngong Ping)", category: "attractions", lat: 22.2539, lng: 113.9055 },
  { id: "po-lin", name: "Po Lin Monastery", category: "attractions", lat: 22.2553, lng: 113.9058 },
  { id: "wong-tai-sin", name: "Wong Tai Sin Temple", category: "attractions", lat: 22.3722, lng: 114.1936 },
  { id: "chi-lin", name: "Chi Lin Nunnery", category: "attractions", lat: 22.3419, lng: 114.1748 },
  { id: "lan-qui-fong", name: "Lan Kwai Fong", category: "attractions", lat: 22.2811, lng: 114.1556 },
  { id: "central-harbourfront", name: "Central Harbourfront", category: "attractions", lat: 22.2833, lng: 114.1603 },
];

// =============================================================================
// Toilets (category: toilets)
// Sample toilets across districts. Fetched dynamically via API.
// =============================================================================

export const TOILET_SPOTS = [
  { id: "toilet-tst", name: "Tsim Sha Tsui Public Toilet", category: "toilets", lat: 22.2969, lng: 114.1719 },
  { id: "toilet-central", name: "Central Pier Public Toilet", category: "toilets", lat: 22.2878, lng: 114.1605 },
  { id: "toilet-causeway", name: "Causeway Bay Public Toilet", category: "toilets", lat: 22.2803, lng: 114.1836 },
  { id: "toilet-mongkok", name: "Mong Kok Public Toilet", category: "toilets", lat: 22.3195, lng: 114.1706 },
  { id: "toilet-hunghom", name: "Hung Hom Public Toilet", category: "toilets", lat: 22.3037, lng: 114.1817 },
  { id: "toilet-quarry-bay", name: "Quarry Bay Park Public Toilet", category: "toilets", lat: 22.2866, lng: 114.2093 },
];

// =============================================================================
// All tourist spots combined
// =============================================================================

export const TOURIST_SPOTS = [
  ...ATTRACTION_SPOTS,
  ...TOILET_SPOTS,
];

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Filter spots by category.
 */
export function filterByCategory(spots, category) {
  return spots.filter((s) => s.category === category);
}

/**
 * Get all toilet spots.
 */
export function getToiletSpots() {
  return TOILET_SPOTS;
}

/**
 * Get attraction spots.
 */
export function getAttractionSpots() {
  return ATTRACTION_SPOTS;
}
