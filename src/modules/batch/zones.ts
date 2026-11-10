/**
 * A business's own clock, taken from its country, so "closing" and "midnight" mean its midnight and not ours.
 * One main zone per country (the capital's); a business in another zone of a big country changes it in the
 * schedule form. Unknown countries fall back to UTC, which the client can also change.
 */
const ZONES: Record<string, string> = {
  GB: "Europe/London", IE: "Europe/Dublin", FR: "Europe/Paris", DE: "Europe/Berlin", ES: "Europe/Madrid", IT: "Europe/Rome", NL: "Europe/Amsterdam", BE: "Europe/Brussels",
  PT: "Europe/Lisbon", CH: "Europe/Zurich", AT: "Europe/Vienna", SE: "Europe/Stockholm", NO: "Europe/Oslo", DK: "Europe/Copenhagen", FI: "Europe/Helsinki", PL: "Europe/Warsaw",
  CZ: "Europe/Prague", GR: "Europe/Athens", TR: "Europe/Istanbul", UA: "Europe/Kyiv", RO: "Europe/Bucharest", HU: "Europe/Budapest",
  US: "America/New_York", CA: "America/Toronto", MX: "America/Mexico_City", BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires", CL: "America/Santiago", CO: "America/Bogota", PE: "America/Lima",
  AE: "Asia/Dubai", SA: "Asia/Riyadh", QA: "Asia/Qatar", KW: "Asia/Kuwait", BH: "Asia/Bahrain", OM: "Asia/Muscat", IL: "Asia/Jerusalem", JO: "Asia/Amman", LB: "Asia/Beirut", IR: "Asia/Tehran",
  PK: "Asia/Karachi", IN: "Asia/Kolkata", BD: "Asia/Dhaka", LK: "Asia/Colombo", NP: "Asia/Kathmandu", TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", ID: "Asia/Jakarta", MY: "Asia/Kuala_Lumpur",
  SG: "Asia/Singapore", PH: "Asia/Manila", HK: "Asia/Hong_Kong", CN: "Asia/Shanghai", TW: "Asia/Taipei", KR: "Asia/Seoul", JP: "Asia/Tokyo",
  AU: "Australia/Sydney", NZ: "Pacific/Auckland", ZA: "Africa/Johannesburg", NG: "Africa/Lagos", KE: "Africa/Nairobi", EG: "Africa/Cairo", MA: "Africa/Casablanca", GH: "Africa/Accra", ET: "Africa/Addis_Ababa",
};
const NAMES: Record<string, string> = {
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB", ireland: "IE", france: "FR", germany: "DE", spain: "ES", italy: "IT", netherlands: "NL",
  "united states": "US", usa: "US", america: "US", canada: "CA", mexico: "MX", brazil: "BR", "united arab emirates": "AE", uae: "AE", "saudi arabia": "SA", pakistan: "PK", india: "IN",
  bangladesh: "BD", singapore: "SG", malaysia: "MY", indonesia: "ID", philippines: "PH", china: "CN", japan: "JP", "south korea": "KR", australia: "AU", "new zealand": "NZ",
  "south africa": "ZA", nigeria: "NG", kenya: "KE", egypt: "EG", turkey: "TR", qatar: "QA", kuwait: "KW", oman: "OM", bahrain: "BH", israel: "IL",
};

export function zoneForCountry(country: string | undefined): string {
  const c = (country ?? "").trim();
  if (!c) return "UTC";
  const code = c.length === 2 ? c.toUpperCase() : NAMES[c.toLowerCase()];
  return (code && ZONES[code]) || "UTC";
}
