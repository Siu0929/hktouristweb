"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { GoogleMap, useJsApiLoader, InfoWindow } from "@react-google-maps/api";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { useTranslations } from "@/contexts/LocaleContext";

import { GOOGLE_MAPS_LIBRARIES } from "@/lib/googleMaps";
import { attachMarkerHover } from "@/lib/mapHover";

// Demo dataset — replace with your real coordinates
const DEMO_LOCATIONS = [
  { id: "1", name: "Victoria Peak", lat: 22.2697, lng: 114.1447 },
  { id: "2", name: "Star Ferry Pier", lat: 22.2936, lng: 114.1690 },
  { id: "3", name: "Temple Street Night Market", lat: 22.3041, lng: 114.1727 },
  { id: "4", name: "Man Mo Temple", lat: 22.2819, lng: 114.1747 },
  { id: "5", name: "Hong Kong Science Museum", lat: 22.2985, lng: 114.1738 },
  { id: "6", name: "Kowloon Park", lat: 22.3014, lng: 114.1718 },
  { id: "7", name: "Hong Kong Museum of History", lat: 22.2996, lng: 114.1753 },
  { id: "8", name: "Tsim Sha Tsui Waterfront", lat: 22.2950, lng: 114.1725 },
];

const HK_CENTER = { lat: 22.2936, lng: 114.1690 };

const mapContainerStyle = { width: "100%", height: "100%" };

const defaultMapOptions = {
  mapId: process.env.NEXT_PUBLIC_MAP_ID ?? "default",
  disableDefaultUI: false,
  zoomControl: true,
  mapTypeControl: false,
  streetViewControl: false,
  fullscreenControl: true,
};

function MissingApiKeyMessage() {
  const t = useTranslations("map");
  return (
    <div style={{ height: 500, display: "flex", alignItems: "center", justifyContent: "center", background: "#fef3c7", borderRadius: 12, padding: 24, textAlign: "center" }}>
      <p style={{ color: "#92400e", margin: 0 }}>{t("missingApiKey")}</p>
    </div>
  );
}

function MapView() {
  const t = useTranslations("map");
  const [selected, setSelected] = useState(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const markersRef = useRef({ clusterer: null, markers: [] });
  const mapRef = useRef(null);

  // Helper to create cluster icon
  const createClusterIcon = (count) => {
    const size = 40;
    const el = document.createElement("div");
    el.style.cssText = `
      width:${size}px;
      height:${size}px;
      border-radius:50%;
      background:#10b981;
      color:#fff;
      display:flex;
      align-items:center;
      justify-content:center;
      font-weight:700;
      font-size:14px;
      border:3px solid #fff;
      box-shadow:0 2px 8px rgba(0,0,0,0.3);
      cursor:pointer;
    `;
    el.textContent = count > 99 ? "99+" : count;
    return el;
  };

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
    libraries: GOOGLE_MAPS_LIBRARIES,
  });

  const handleMapLoad = useCallback((map) => {
    mapRef.current = map;
    setMapLoaded(true);
  }, []);

  // Pan to selected marker
  useEffect(() => {
    if (!selected || !mapRef.current) return;
    const loc = DEMO_LOCATIONS.find((l) => l.id === selected);
    if (!loc) return;
    mapRef.current.panTo({ lat: loc.lat, lng: loc.lng });
    mapRef.current.setZoom(16);
  }, [selected]);

  // Create markers with clustering when map loads
  useEffect(() => {
    if (!mapLoaded || !isLoaded || !mapRef.current) return;
    const map = mapRef.current;

    // Clean up existing clusterer
    if (markersRef.current.clusterer) {
      markersRef.current.clusterer.setMap(null);
    }

    if (!window.google?.maps?.marker?.AdvancedMarkerElement) return;

    const createMarkerElement = (loc, isSelected) => {
      const color = isSelected ? "#ef4444" : "#C2410C";
      const size = isSelected ? 16 : 10;

      const dotEl = document.createElement("div");
      dotEl.style.cssText = `
        width:${size}px;
        height:${size}px;
        border-radius:50%;
        background:${color};
        border:2px solid #fff;
        box-shadow:0 1px 4px rgba(0,0,0,0.35);
        cursor:pointer;
      `;
      attachMarkerHover(dotEl, { name: loc.name });
      return dotEl;
    };

    // Create markers with AdvancedMarkerElement
    const markers = DEMO_LOCATIONS.filter((loc) => loc.lat != null && loc.lng != null).map((loc) => {
      const isSelected = selected === loc.id;
      const marker = new window.google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: loc.lat, lng: loc.lng },
        content: createMarkerElement(loc, isSelected),
      });
      marker.addListener("gmp-click", () => setSelected(loc.id));
      return marker;
    });

    // Create clusterer with custom styling
    const clusterer = new MarkerClusterer({
      map,
      markers,
      renderer: {
        render: ({ count, position }) => {
          return new window.google.maps.marker.AdvancedMarkerElement({
            map,
            position,
            content: createClusterIcon(count),
          });
        },
      },
    });

    markersRef.current = { clusterer, markers };
  }, [mapLoaded, isLoaded, selected]);

  // Update marker colors when selection changes
  useEffect(() => {
    if (!markersRef.current.markers) return;
    const { markers: currentMarkers } = markersRef.current;
    DEMO_LOCATIONS.forEach((loc, idx) => {
      if (currentMarkers[idx]) {
        const isSelected = selected === loc.id;
        const color = isSelected ? "#ef4444" : "#C2410C";
        const size = isSelected ? 16 : 10;
        const content = currentMarkers[idx].content;
        content.style.background = color;
        content.style.width = `${size}px`;
        content.style.height = `${size}px`;
      }
    });
  }, [selected]);

  if (loadError) {
    return (
      <div style={{ height: 500, display: "flex", alignItems: "center", justifyContent: "center", background: "#fee2e2", borderRadius: 12, padding: 24, textAlign: "center" }}>
        <p style={{ color: "#991b1b", margin: 0 }}>{t("loadError")}</p>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div style={{ height: 500, display: "flex", alignItems: "center", justifyContent: "center", background: "#f3f4f6", borderRadius: 12 }}>
        <p style={{ color: "#6b7280" }}>{t("loading")}</p>
      </div>
    );
  }

  const activeLocation = DEMO_LOCATIONS.find((l) => l.id === selected);

  return (
    <div style={{ height: 500, width: "100%", borderRadius: 12, overflow: "hidden" }}>
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={HK_CENTER}
        zoom={13}
        options={defaultMapOptions}
        onLoad={handleMapLoad}
      >
        {activeLocation && (
          <InfoWindow
            position={{ lat: activeLocation.lat, lng: activeLocation.lng }}
            onCloseClick={() => setSelected(null)}
          >
            <div style={{ color: "#000", padding: 4 }}>
              <h4 style={{ margin: "0 0 4px 0" }}>{activeLocation.name}</h4>
              <p style={{ margin: 0, fontSize: 12 }}>
                {t("lat")}: {activeLocation.lat.toFixed(4)}, {t("lng")}: {activeLocation.lng.toFixed(4)}
              </p>
            </div>
          </InfoWindow>
        )}
      </GoogleMap>
    </div>
  );
}

export default function MapComponent() {
  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return <MissingApiKeyMessage />;
  }
  return <MapView />;
}
