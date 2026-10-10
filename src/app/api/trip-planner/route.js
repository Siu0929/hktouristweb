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

const SYSTEM_PROMPT = `You are a helpful Hong Kong travel assistant. Create detailed, practical travel itineraries for visitors to Hong Kong.

When planning itineraries, consider:
- Opening hours and best times to visit
- Nearby attractions that can be combined
- Local food and dining recommendations
- Practical tips (weather-appropriate clothing, what to bring)

Always respond in the same language as the user's message. Format your response with clear sections using emojis and bullet points for readability.`;

// ---------------------------------------------------------------------------
// Input sanitisation: strip attempts to override the system prompt or
// inject disallowed content via the user message (prompt injection defence).
// ---------------------------------------------------------------------------
const INJECTION_PATTERNS = [
  /^system\s*:/im,
  /^ignore\s+(all\s+)?previous\s+instructions/im,
  /^(you\s+are|you\s+should|you\s+must)\b/im,
  /<\|[\w]+\|>/,       // chatML special tokens
  /\x00/,               // null bytes
];

const MAX_MESSAGE_LENGTH = 2000;

function sanitiseMessage(raw) {
  if (typeof raw !== "string") return "";
  // Truncate to max length
  let cleaned = raw.slice(0, MAX_MESSAGE_LENGTH);
  // Remove null bytes
  cleaned = cleaned.replace(/\x00/g, "");
  // Detect and block injection attempts
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      // Replace the suspicious line with a placeholder rather than rejecting
      // outright, so accidental typing doesn't frustrate users.
      cleaned = cleaned.replace(pattern, "[input sanitised]");
    }
  }
  return cleaned.trim();
}

export async function POST(request) {
  try {
    const { message } = await request.json();

    if (!message || typeof message !== "string") {
      return Response.json({ error: "Message is required" }, { status: 400 });
    }

    const safeMessage = sanitiseMessage(message);
    if (!safeMessage) {
      return Response.json({ error: "Message is empty or invalid" }, { status: 400 });
    }

    const completion = await getClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: safeMessage },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });

    const response = completion.choices[0]?.message?.content || "Sorry, I couldn't generate a response.";

    return Response.json({ response });
  } catch (error) {
    console.error("Trip planner error:", error);
    return Response.json(
      { error: "Failed to generate trip plan. Please try again." },
      { status: 500 }
    );
  }
}
