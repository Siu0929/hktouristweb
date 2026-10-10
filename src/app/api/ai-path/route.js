/**
 * POST /api/ai-path
 *
 * AI-powered path planning with step-by-step directions.
 * Accepts start location, destination, and optional waypoints.
 * Returns detailed route with transport modes and estimated times.
 *
 * Request body:
 *   start: { lat, lng, name }
 *   destination: { lat, lng, name }
 *   waypoints: [{ lat, lng, name }]
 *   preferences: { mode: "fastest" | "walking" | "transit", locale: "en" | "zh-Hant" }
 */
import OpenAI from "openai";

// Lazily initialized so the route builds cleanly when OPENAI_API_KEY is absent.
let _client;
function getClient() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Input sanitisation helpers
// ---------------------------------------------------------------------------
const MAX_COORD = 180;
const MAX_STRING_LENGTH = 200;
const INJECTION_PATTERNS = [
  /^system\s*:/im,
  /^ignore\s+(all\s+)?previous\s+instructions/im,
  /<\|[\w]+\|>/,
  /\x00/,
];

function sanitiseString(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\x00/g, "").slice(0, MAX_STRING_LENGTH).trim();
}

function sanitiseCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= MAX_COORD ? n : null;
}

function sanitiseWaypoints(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 5)
    .map((w) => ({
      lat: sanitiseCoord(w?.lat),
      lng: sanitiseCoord(w?.lng),
      name: sanitiseString(w?.name),
    }))
    .filter((w) => w.lat !== null && w.lng !== null);
}

const SYSTEM_PROMPT = `You are a Hong Kong travel routing assistant. Generate step-by-step directions for getting between locations in Hong Kong.

For each route segment, provide:
1. mode: walking | driving
2. from: starting location name
3. to: destination location name
4. instruction: detailed direction in the requested language
5. duration: estimated time in minutes

Always respond with valid JSON in this exact format:
{
  "route": {
    "totalDuration": number (minutes),
    "segments": [
      {
        "mode": "walking|driving",
        "from": "location name",
        "to": "location name",
        "instruction": "detailed direction",
        "duration": number (minutes)
      }
    ]
  }
}

If locations are close enough to walk, suggest walking.
Use real Hong Kong place names and landmarks.

Always respond in the same language as the user's request.`;

export async function POST(request) {
  try {
    const body = await request.json();

    const startLat = sanitiseCoord(body?.start?.lat);
    const startLng = sanitiseCoord(body?.start?.lng);
    const destLat = sanitiseCoord(body?.destination?.lat);
    const destLng = sanitiseCoord(body?.destination?.lng);

    if (startLat === null || startLng === null || destLat === null || destLng === null) {
      return Response.json(
        { error: "Valid start and destination coordinates are required" },
        { status: 400 }
      );
    }

    const startName = sanitiseString(body?.start?.name);
    const destName = sanitiseString(body?.destination?.name);
    const waypoints = sanitiseWaypoints(body?.waypoints);
    const locale = sanitiseString(body?.preferences?.locale ?? "en").slice(0, 10);
    const mode = sanitiseString(body?.preferences?.mode ?? "fastest");

    const waypointsText = waypoints.length > 0
      ? `\nWaypoints:\n${waypoints.map((w, i) => `${i + 1}. ${w.name || "Stop"} (${w.lat}, ${w.lng})`).join("\n")}`
      : "";

    const userMessage = `Plan a route from:\n- Start: ${startName || "My location"} (${startLat}, ${startLng})\n- End: ${destName || "Destination"} (${destLat}, ${destLng})${waypointsText}\n\nMode preference: ${mode || "fastest"}`;

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });

    const content = completion.choices[0]?.message?.content || "";

    let routeData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        routeData = JSON.parse(jsonMatch[0]);
      } else {
        routeData = {
          route: {
            totalDuration: 30,
            segments: [{
              mode: "walking",
              from: start.name || "Start",
              to: destination.name || "Destination",
              instruction: content.slice(0, 200),
              duration: 30,
            }],
          },
        };
      }
    } catch {
      routeData = {
        route: {
          totalDuration: 30,
          segments: [{
            mode: "walking",
            from: startName || "Start",
            to: destName || "Destination",
            instruction: content.slice(0, 200),
            duration: 30,
          }],
        },
      };
    }

    return Response.json({
      start: { lat: startLat, lng: startLng, name: startName },
      destination: { lat: destLat, lng: destLng, name: destName },
      waypoints,
      ...routeData,
    });
  } catch (error) {
    console.error("AI path planner error:", error);
    return Response.json(
      { error: "Failed to generate path. Please try again." },
      { status: 500 }
    );
  }
}
