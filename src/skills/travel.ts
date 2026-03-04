/**
 * Travel Agent Skill — Amadeus API
 *
 * Flight search, hotel search, and travel advisories.
 * Free tier available at developers.amadeus.com
 */

import type Anthropic from "@anthropic-ai/sdk";

let amadeusToken: string | null = null;
let tokenExpiry = 0;

async function getAmadeusToken(): Promise<string | null> {
  const key = process.env.AMADEUS_API_KEY;
  const secret = process.env.AMADEUS_API_SECRET;
  if (!key || !secret) return null;

  if (amadeusToken && Date.now() < tokenExpiry) return amadeusToken;

  const response = await fetch("https://test.api.amadeus.com/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${key}&client_secret=${secret}`,
  });

  if (!response.ok) return null;
  const data = await response.json();
  amadeusToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return amadeusToken;
}

export const definitions: Anthropic.Tool[] = [
  {
    name: "search_flights",
    description: "Search for flights between cities. Returns available flights with prices.",
    input_schema: {
      type: "object" as const,
      properties: {
        origin: { type: "string", description: "Origin IATA city/airport code (e.g., JFK, LAX, LHR)" },
        destination: { type: "string", description: "Destination IATA city/airport code" },
        departure_date: { type: "string", description: "Departure date in YYYY-MM-DD format" },
        return_date: { type: "string", description: "Return date for round-trip (optional)" },
        adults: { type: "number", description: "Number of adult passengers (default 1)" },
      },
      required: ["origin", "destination", "departure_date"],
    },
  },
  {
    name: "search_hotels",
    description: "Search for hotels in a city. Returns available hotels with prices and ratings.",
    input_schema: {
      type: "object" as const,
      properties: {
        city_code: { type: "string", description: "IATA city code (e.g., NYC, LON, PAR)" },
        check_in: { type: "string", description: "Check-in date YYYY-MM-DD" },
        check_out: { type: "string", description: "Check-out date YYYY-MM-DD" },
        adults: { type: "number", description: "Number of guests (default 1)" },
      },
      required: ["city_code", "check_in", "check_out"],
    },
  },
  {
    name: "travel_advisory",
    description: "Get travel safety information and advisories for a country.",
    input_schema: {
      type: "object" as const,
      properties: {
        country_code: { type: "string", description: "ISO 2-letter country code (e.g., US, GB, JP)" },
      },
      required: ["country_code"],
    },
  },
];

export async function handler(toolName: string, input: Record<string, unknown>): Promise<string> {
  switch (toolName) {
    case "search_flights":
      return searchFlights(input);
    case "search_hotels":
      return searchHotels(input);
    case "travel_advisory":
      return travelAdvisory(input);
    default:
      return `Unknown travel tool: ${toolName}`;
  }
}

async function searchFlights(input: Record<string, unknown>): Promise<string> {
  const token = await getAmadeusToken();
  if (!token) return "Travel search not configured. Set AMADEUS_API_KEY and AMADEUS_API_SECRET in .env.";

  const params = new URLSearchParams({
    originLocationCode: input.origin as string,
    destinationLocationCode: input.destination as string,
    departureDate: input.departure_date as string,
    adults: String(input.adults || 1),
    max: "5",
    currencyCode: "USD",
  });
  if (input.return_date) params.set("returnDate", input.return_date as string);

  const response = await fetch(
    `https://test.api.amadeus.com/v2/shopping/flight-offers?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const err = await response.text();
    return `Flight search failed: ${response.status} - ${err.substring(0, 200)}`;
  }

  const data = await response.json();
  const offers = data.data || [];

  if (offers.length === 0) return "No flights found for this route and date.";

  return offers.slice(0, 5).map((offer: any, i: number) => {
    const segments = offer.itineraries?.[0]?.segments || [];
    const price = offer.price;
    const seg = segments.map((s: any) =>
      `  ${s.departure.iataCode} → ${s.arrival.iataCode} (${s.carrierCode}${s.number}, ${s.departure.at.substring(11, 16)})`
    ).join("\n");
    return `${i + 1}. $${price.total} ${price.currency}\n${seg}\n   Duration: ${offer.itineraries[0].duration}`;
  }).join("\n\n");
}

async function searchHotels(input: Record<string, unknown>): Promise<string> {
  const token = await getAmadeusToken();
  if (!token) return "Travel search not configured. Set AMADEUS_API_KEY and AMADEUS_API_SECRET in .env.";

  // First, find hotels in the city
  const listResponse = await fetch(
    `https://test.api.amadeus.com/v1/reference-data/locations/hotels/by-city?cityCode=${input.city_code}&radius=30&radiusUnit=KM&hotelSource=ALL`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!listResponse.ok) return `Hotel search failed: ${listResponse.status}`;

  const listData = await listResponse.json();
  const hotels = listData.data?.slice(0, 5) || [];

  if (hotels.length === 0) return "No hotels found in this city.";

  return hotels.map((h: any, i: number) =>
    `${i + 1}. ${h.name}\n   ID: ${h.hotelId}\n   ${h.address?.countryCode || ""}`
  ).join("\n\n");
}

async function travelAdvisory(input: Record<string, unknown>): Promise<string> {
  const code = (input.country_code as string).toUpperCase();

  // Use the open travel advisory API
  const response = await fetch(`https://www.travel-advisory.info/api?countrycode=${code}`);
  if (!response.ok) return `Advisory lookup failed: ${response.status}`;

  const data = await response.json();
  const info = data.data?.[code];
  if (!info) return `No advisory found for country code ${code}.`;

  const advisory = info.advisory;
  return [
    `Country: ${info.name}`,
    `Risk Score: ${advisory.score}/5`,
    `Risk Level: ${advisory.message}`,
    `Sources: ${advisory.sources_active} active advisories`,
    `Updated: ${advisory.updated}`,
  ].join("\n");
}
