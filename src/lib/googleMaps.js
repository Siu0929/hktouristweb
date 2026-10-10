// Must be a module-level stable reference and identical across every component
// that calls `useJsApiLoader`. The Google Maps script loader caches based on
// the `libraries` option — passing a different array to a second loader in
// the same session throws "Loader must not be called again with different
// options". Keep this in sync across all pages / components.
export const GOOGLE_MAPS_LIBRARIES = ["marker", "routes", "geometry"];
