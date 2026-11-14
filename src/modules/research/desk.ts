import { clean, getJson, ResearchError } from "./sources.js";

/**
 * The data desk: read-only look-ups of the kind a market desk uses. News (GDELT, no key), economic indicators
 * (World Bank, no key; FRED, free key), share prices (Alpha Vantage, free key) and UK companies (Companies House,
 * free key). Everything returned is public text or numbers: shown as data, never as instructions.
 */
export type DeskKind = "news" | "indicator" | "series" | "quote" | "company";
export const DESK_KINDS: readonly DeskKind[] = ["news", "indicator", "series", "quote", "company"];

export interface DeskItem { title: string; value?: string; detail: string; url?: string; date?: string }
export interface DeskKeys { fred?: string; alphaVantage?: string; companiesHouse?: string }

const enc = encodeURIComponent;
/** Only plain web addresses, so a feed can never hand us another kind of link. */
const web = (u: unknown): string | undefined => (typeof u === "string" && /^https?:\/\/[^\s<>"']{4,500}$/.test(u) ? u : undefined);
const num = (v: unknown, digits = 2): string | undefined => { const n = Number(v); return v !== null && v !== "" && v !== "." && Number.isFinite(n) ? n.toLocaleString("en-GB", { maximumFractionDigits: digits }) : undefined; };

/** News from around the world, from GDELT's open index. */
export async function news(http: typeof fetch, query: string, within: "week" | "month" | "year"): Promise<DeskItem[]> {
  const span = within === "week" ? "1week" : within === "month" ? "1month" : "12months";
  const j = await getJson(http, "The news index", `https://api.gdeltproject.org/api/v2/doc/doc?query=${enc(query)}&mode=artlist&maxrecords=15&format=json&timespan=${span}&sort=hybridrel`, {});
  return (Array.isArray(j?.articles) ? j.articles : []).map((a: any): DeskItem => {
    const d = /^(\d{4})(\d{2})(\d{2})/.exec(String(a?.seendate ?? ""));
    return { title: clean(a?.title, 200), detail: `${clean(a?.domain, 80)}${a?.sourcecountry ? `, ${clean(a.sourcecountry, 40)}` : ""}`, url: web(a?.url), date: d ? `${d[1]}-${d[2]}-${d[3]}` : undefined };
  }).filter((i: DeskItem) => i.title);
}

/** A World Bank indicator for a country, newest figures first. For example GB and NY.GDP.MKTP.KD.ZG (GDP growth). */
export async function indicator(http: typeof fetch, country: string, code: string): Promise<DeskItem[]> {
  if (!/^[A-Za-z]{2,3}$/.test(country)) throw new ResearchError("a country is a 2 or 3 letter code such as GB or USA");
  if (!/^[A-Za-z0-9.]{3,40}$/.test(code)) throw new ResearchError("an indicator code looks like NY.GDP.MKTP.KD.ZG");
  const j = await getJson(http, "The World Bank", `https://api.worldbank.org/v2/country/${country}/indicator/${code}?format=json&per_page=12`, {});
  if (!Array.isArray(j) || !Array.isArray(j[1])) throw new ResearchError("The World Bank has no such country or indicator.");
  return j[1].filter((r: any) => r?.value !== null && r?.value !== undefined).slice(0, 8).map((r: any): DeskItem => ({ title: clean(r?.indicator?.value, 160), value: num(r.value, 3), detail: clean(r?.country?.value, 60), date: clean(r?.date, 10) }));
}

/** A FRED economic series (for example UNRATE or CPIAUCSL), newest observations first. */
export async function series(http: typeof fetch, key: string, id: string): Promise<DeskItem[]> {
  if (!/^[A-Za-z0-9_]{1,30}$/.test(id)) throw new ResearchError("a FRED series id is letters and numbers, for example UNRATE");
  const j = await getJson(http, "FRED", `https://api.stlouisfed.org/fred/series/observations?series_id=${enc(id)}&api_key=${enc(key)}&file_type=json&sort_order=desc&limit=8`, {});
  return (Array.isArray(j?.observations) ? j.observations : []).map((o: any): DeskItem => ({ title: id.toUpperCase(), value: num(o?.value, 3), detail: "FRED, St. Louis Fed", date: clean(o?.date, 10), url: `https://fred.stlouisfed.org/series/${enc(id)}` })).filter((i: DeskItem) => i.value !== undefined);
}

/** The latest price for a share or fund symbol. */
export async function quote(http: typeof fetch, key: string, symbol: string): Promise<DeskItem[]> {
  if (!/^[A-Za-z0-9.-]{1,12}$/.test(symbol)) throw new ResearchError("a symbol is letters and numbers, for example IBM or VOD.LON");
  const j = await getJson(http, "Alpha Vantage", `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${enc(symbol)}&apikey=${enc(key)}`, {});
  if (j?.Note || j?.Information) throw new ResearchError("Alpha Vantage says today's free allowance is used up. Try tomorrow.");
  const q = j?.["Global Quote"];
  if (!q || !q["05. price"]) throw new ResearchError("No price found for that symbol.");
  return [{ title: clean(q["01. symbol"], 20) || symbol.toUpperCase(), value: num(q["05. price"], 4), detail: `Change ${clean(q["09. change"], 20)} (${clean(q["10. change percent"], 20)}), volume ${num(q["06. volume"], 0) ?? "unknown"}`, date: clean(q["07. latest trading day"], 10) }];
}

/** UK companies by name, from Companies House. */
export async function company(http: typeof fetch, key: string, query: string): Promise<DeskItem[]> {
  const j = await getJson(http, "Companies House", `https://api.company-information.service.gov.uk/search/companies?q=${enc(query)}&items_per_page=10`, { headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` } });
  return (Array.isArray(j?.items) ? j.items : []).filter((c: any) => /^[A-Z0-9]{6,10}$/.test(String(c?.company_number))).map((c: any): DeskItem => ({
    title: clean(c.title, 160), detail: `${clean(c.company_status, 30)}, number ${c.company_number}${c.address_snippet ? `, ${clean(c.address_snippet, 120)}` : ""}`, date: clean(c.date_of_creation, 10) || undefined,
    url: `https://find-and-update.company-information.service.gov.uk/company/${c.company_number}`,
  }));
}

/** One cheap read for each key, used by the Connections page tests. */
export async function deskKeyWorks(http: typeof fetch, which: "fred" | "alphavantage" | "companieshouse", key: string): Promise<void> {
  if (which === "fred") await series(http, key, "UNRATE");
  else if (which === "alphavantage") await quote(http, key, "IBM");
  else await company(http, key, "test");
}
