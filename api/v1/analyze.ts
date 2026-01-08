import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

/**
 * ===== ENV =====
 */
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || "";
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "";
const EBAY_ENV = (process.env.EBAY_ENV || "PROD").toUpperCase(); // PROD | SANDBOX

const EBAY_BASE =
  EBAY_ENV === "SANDBOX" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

// Finding API endpoint (works with AppID)
const EBAY_FINDING_ENDPOINT = "https://svcs.ebay.com/services/search/FindingService/v1";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ===== TYPES =====
 */
type AnalyzeRequest = {
  source: "ebay";
  url: string;
  itemId?: string;
  title: string;
  price: { amount: number; currency: string };
  condition?: string;
  brand?: string;
  categoryHint?: string;

  // optional (sent from content.js)
  cacheBuster?: string;
  debugPriceRaw?: string;
};

type Comp = {
  title: string;
  price: { amount: number; currency: string };
  condition?: string;
  url: string;
  itemId?: string;

  // Debug / ranking
  qualityScore?: number;
  qualityWhy?: string[];
};

type SoldComp = Comp & {
  soldDate?: string; // ISO date string (best effort)
};

let tokenCache: { accessToken: string; expiresAtMs: number } | null = null;

/**
 * ===== USER-FRIENDLY DEAL LABELS =====
 */
type DealLabel = "great_deal" | "fair_price" | "overpriced";

function dealLabelFromRatio(ratio: number): DealLabel {
  // ratio = asking / soldMedian
  if (!Number.isFinite(ratio) || ratio <= 0) return "fair_price";
  if (ratio <= 0.88) return "great_deal";
  if (ratio <= 1.05) return "fair_price";
  return "overpriced";
}

function dealLabelMeta(label: DealLabel): { title: string; emoji: string } {
  switch (label) {
    case "great_deal":
      return { title: "Great deal", emoji: "🟢" };
    case "fair_price":
      return { title: "Fair price", emoji: "🟡" };
    case "overpriced":
      return { title: "Overpriced", emoji: "🔴" };
  }
}

/**
 * ===== EBAY TOKEN (App token) =====
 */
async function getEbayAppToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 30_000) return tokenCache.accessToken;

  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env vars");
  }

  const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${EBAY_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }).toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`eBay token error (${res.status}): ${txt}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { accessToken: json.access_token, expiresAtMs: now + json.expires_in * 1000 };
  return tokenCache.accessToken;
}

/**
 * ===== EBAY BROWSE SEARCH (ACTIVE comps) =====
 */
async function fetchActiveComps(params: {
  query: string;
  limit: number;
  marketplaceId: string;
  currency: string;
  filter: string;
}): Promise<Comp[]> {
  const token = await getEbayAppToken();

  const q = params.query.trim().slice(0, 200);
  const url = new URL(`${EBAY_BASE}/buy/browse/v1/item_summary/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(params.limit));
  if (params.filter && String(params.filter).trim()) {
    url.searchParams.set("filter", String(params.filter).trim());
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": params.marketplaceId,
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Browse search error (${res.status}): ${txt}`);
  }

  const json = await res.json();
  const items = (json?.itemSummaries || []) as any[];

  const comps: Comp[] = items
    .map((it) => {
      const amount = Number(it?.price?.value);
      const currency = it?.price?.currency || params.currency;
      if (!Number.isFinite(amount) || amount <= 0) return null;

      return {
        title: String(it?.title || "").slice(0, 180),
        price: { amount, currency },
        condition: it?.condition,
        url: it?.itemWebUrl || it?.itemHref || "",
        itemId: it?.itemId,
      } as Comp;
    })
    .filter(Boolean)
    .filter((c: Comp) => !!c.url);

  return comps;
}

/**
 * ===== EBAY FINDING API (SOLD comps) =====
 * Uses AppID (= EBAY_CLIENT_ID). Works without OAuth.
 * We use findCompletedItems + SoldItemsOnly=true and a time window.
 */
function findingGlobalIdFromMarketplace(marketplaceId: string): string {
  if (marketplaceId === "EBAY_GB") return "EBAY-GB";
  if (marketplaceId === "EBAY_DE") return "EBAY-DE";
  if (marketplaceId === "EBAY_FR") return "EBAY-FR";
  if (marketplaceId === "EBAY_IT") return "EBAY-IT";
  return "EBAY-US";
}

/**
 * ✅ NEW: Finding API is inconsistent with quotes / negatives / accents.
 * We clean our query to something the legacy Finding endpoint handles reliably.
 */
function toFindingKeywords(q: string): string {
  return String(q || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents (Hermès -> Hermes)
    .replace(/"([^"]+)"/g, "$1") // remove quotes
    .replace(/\s+-"[^"]+"/g, " ") // remove -"phrase"
    .replace(/\s+-\S+/g, " ") // remove -token
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSoldComps(params: {
  query: string;
  limit: number;
  marketplaceId: string;
  currency: string;
  daysBack: number;
}): Promise<SoldComp[]> {
  if (!EBAY_CLIENT_ID) {
    throw new Error("Missing EBAY_CLIENT_ID (used as Finding API AppID)");
  }

  // ✅ FIX: use Finding-safe keywords
  const keywords = toFindingKeywords(params.query).slice(0, 250);

  const endTo = new Date();
  const endFrom = new Date(Date.now() - params.daysBack * 24 * 60 * 60 * 1000);

  const url = new URL(EBAY_FINDING_ENDPOINT);
  url.searchParams.set("OPERATION-NAME", "findCompletedItems");
  url.searchParams.set("SERVICE-VERSION", "1.13.0");
  url.searchParams.set("SECURITY-APPNAME", EBAY_CLIENT_ID);
  url.searchParams.set("RESPONSE-DATA-FORMAT", "JSON");
  url.searchParams.set("REST-PAYLOAD", "true");
  url.searchParams.set("GLOBAL-ID", findingGlobalIdFromMarketplace(params.marketplaceId));

  url.searchParams.set("keywords", keywords);
  url.searchParams.set("paginationInput.entriesPerPage", String(params.limit));

  url.searchParams.set("itemFilter(0).name", "SoldItemsOnly");
  url.searchParams.set("itemFilter(0).value", "true");

  url.searchParams.set("itemFilter(1).name", "EndTimeFrom");
  url.searchParams.set("itemFilter(1).value", endFrom.toISOString());

  url.searchParams.set("itemFilter(2).name", "EndTimeTo");
  url.searchParams.set("itemFilter(2).value", endTo.toISOString());

  const res = await fetch(url.toString(), { method: "GET" });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Finding (sold) error (${res.status}): ${txt}`);
  }

  const json = await res.json();

  const items =
    json?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || ([] as any[]);

  const out: SoldComp[] = (items as any[])
    .map((it) => {
      const priceValue =
        it?.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ ??
        it?.sellingStatus?.currentPrice?.__value__;
      const amount = Number(priceValue);

      const currency =
        it?.sellingStatus?.[0]?.currentPrice?.[0]?.["@currencyId"] ||
        it?.sellingStatus?.currentPrice?.["@currencyId"] ||
        params.currency;

      if (!Number.isFinite(amount) || amount <= 0) return null;

      const title = String(it?.title?.[0] || it?.title || "").slice(0, 180);
      const url = String(it?.viewItemURL?.[0] || it?.viewItemURL || "");
      const itemId = String(it?.itemId?.[0] || it?.itemId || "");

      const soldDate =
        it?.listingInfo?.[0]?.endTime?.[0] ||
        it?.listingInfo?.endTime ||
        undefined;

      return {
        title,
        price: { amount, currency },
        condition:
          it?.condition?.[0]?.conditionDisplayName?.[0] ||
          it?.condition?.[0]?.conditionDisplayName,
        url,
        itemId,
        soldDate,
      } as SoldComp;
    })
    .filter(Boolean)
    .filter((c: SoldComp) => !!c.url && !!c.title);

  return out;
}

/**
 * ===== BASIC STATS =====
 */
function median(arr: number[]): number {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  if (a.length % 2) return a[mid];
  return (a[mid - 1] + a[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * ===== BAG DETECTION =====
 */
function looksLikeBag(text: string) {
  const bagSignals = [
    "bag",
    "handbag",
    "tote",
    "flap",
    "hobo",
    "satchel",
    "shoulder bag",
    "crossbody",
    "kelly",
    "birkin",
    "chanel",
    "hermes",
    "louis vuitton",
    "lv",
    "dior",
    "prada",
    "gucci",
    "celine",
    "fendi",
    "ysl",
    "saint laurent",
  ];
  const t = normalize(text);
  return bagSignals.some((s) => t.includes(normalize(s)));
}

/**
 * ===== QUERY CLEANING =====
 */
function cleanTitleForSearch(title: string): string {
  let t = (title || "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stopPhrases = [
    "original",
    "authentic",
    "100% authentic",
    "genuine",
    "w/ all paperwork",
    "with all paperwork",
    "with paperwork",
    "all paperwork",
    "paperwork",
    "receipt",
    "dust bag",
    "dustbag",
    "box",
    "tags",
    "brand new",
    "nwt",
    "mint",
    "rare",
  ];

  for (const s of stopPhrases) {
    const re = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    t = t.replace(re, " ");
  }

  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function extractSizeToken(title: string): string | null {
  const t = normalize(title);
  const m = t.match(
    /\b(15|18|20|22|24|25|26|27|28|30|32|33|34|35|36|38|40|41|45)\b(?:\s*cm)?\b/
  );
  return m?.[1] || null;
}

const LEATHER_TOKENS = [
  "epson",
  "togo",
  "clemence",
  "swift",
  "box",
  "chevre",
  "barenia",
  "alligator",
  "crocodile",
  "ostrich",
  "lizard",
];

function extractLeatherToken(title: string): string | null {
  const t = normalize(title);
  for (const lt of LEATHER_TOKENS) {
    if (t.includes(normalize(lt))) return lt;
  }
  return null;
}

function isBirkinOrKelly(body: AnalyzeRequest): boolean {
  const t = normalize(body.title || "");
  const b = normalize(body.brand || "");
  const isHermes = b.includes("hermes");
  const hasBK = t.includes("birkin") || t.includes("kelly");
  return isHermes && hasBK;
}

function buildSearchQuery(body: AnalyzeRequest): string {
  // Your current "smart-ish" query builder (kept).
  // Important: Finding API will now receive a cleaned version via toFindingKeywords().
  const brand = (body.brand || "").trim();
  const cleaned = cleanTitleForSearch(body.title || "");
  const size = extractSizeToken(body.title || "");
  const leather = extractLeatherToken(body.title || "");
  const bk = isBirkinOrKelly(body);

  const parts: string[] = [];
  if (brand) parts.push(`"${brand}"`);
  if (cleaned) parts.push(`"${cleaned}"`);

  // For Birkin/Kelly, size matters a lot:
  if (bk && size) parts.push(`"${size}"`);

  // Leather token helps
  if (bk && leather) parts.push(`"${leather}"`);

  // negatives to reduce junk (these are OK for ACTIVE browse; Finding will strip them)
  const negatives = [
    "twilly",
    "strap",
    "dustbag",
    "box only",
    "charms",
    "scarf",
    "organizer",
    "insert",
    "accessories",
    "replica",
  ];
  for (const n of negatives) parts.push(`-"${n}"`);

  return parts.join(" ").trim().slice(0, 300);
}

// ===========================
// SOLD QUERY (Finding-safe)
// ===========================
function buildSoldQuery(body: AnalyzeRequest): string {
  const t = normalize(body.title || "");
  const _b = normalize(body.brand || "");

  // Model detection
  const model =
    t.includes("neverfull") ? "Neverfull" :
    t.includes("speedy") ? "Speedy" :
    t.includes("alma") ? "Alma" :
    t.includes("birkin") ? "Birkin" :
    t.includes("kelly") ? "Kelly" :
    "";

  // Size detection (LV + Hermes)
  const size =
    t.includes("gm") ? "GM" :
    t.includes("mm") ? "MM" :
    t.includes("pm") ? "PM" :
    t.match(/\b(25|30|35|40)\b/)?.[1] || "";

  const parts = [body.brand || "", model, size].filter(Boolean);

  // Fallback if model not detected
  if (parts.length < 2) {
    const tokens = normalize(body.title || "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 4);

    return [body.brand || "", ...tokens].filter(Boolean).join(" ").slice(0, 120);
  }

  return parts.join(" ").trim().slice(0, 120);
}

function marketplaceIdFromUrl(url: string): string {
  const u = (url || "").toLowerCase();
  if (u.includes("ebay.co.uk")) return "EBAY_GB";
  if (u.includes("ebay.de")) return "EBAY_DE";
  if (u.includes("ebay.fr")) return "EBAY_FR";
  if (u.includes("ebay.it")) return "EBAY_IT";
  return "EBAY_US";
}

function buildBrowseFilter(_body: AnalyzeRequest): string {
  return "";
}

/**
 * ===== QUALITY / RANKING =====
 */
function tokenOverlapScore(tokens: string[], titleNorm: string) {
  let hits = 0;
  for (const t of tokens) if (titleNorm.includes(t)) hits++;
  const score = hits * 6;
  return { hits, score };
}

function priceClosenessScore(asking: number, compPrice: number) {
  if (!Number.isFinite(asking) || asking <= 0 || !Number.isFinite(compPrice) || compPrice <= 0) return 0;
  const r = compPrice / asking;
  const dist = Math.abs(Math.log(r));
  return Math.round(clamp(25 * (1 - dist / 1.0), 0, 25));
}

function isObviousJunkCompTitle(title: string): boolean {
  const t = normalize(title || "");
  const junk = [
    "twilly",
    "strap",
    "dustbag",
    "dust bag",
    "box only",
    "empty box",
    "scarf",
    "organizer",
    "insert",
    "charm",
    "charms",
    "keychain",
    "replica",
    "inspired",
  ];
  return junk.some((j) => t.includes(normalize(j)));
}

function buildTargetSignals(body: AnalyzeRequest) {
  const titleNorm = normalize(body.title || "");
  const brandNorm = normalize(body.brand || "");

  const size = extractSizeToken(body.title || "");
  const leather = extractLeatherToken(body.title || "");

  const modelHint =
    titleNorm.includes("birkin") ? "birkin" :
    titleNorm.includes("kelly") ? "kelly" :
    titleNorm.includes("classic flap") ? "classic flap" :
    "";

  const coreTokens = titleNorm.split(" ").filter(Boolean).slice(0, 8);
  const modelTokens = modelHint ? [modelHint] : [];
  const brandTokens = brandNorm ? brandNorm.split(" ").filter(Boolean).slice(0, 3) : [];

  return {
    asking: body.price.amount,
    askingCurrency: body.price.currency,
    brand: brandNorm || "",
    brandTokens,
    modelHint,
    modelTokens,
    coreTokens,
    size,
    leather,
    negatives: ["replica", "inspired", "twilly", "strap", "dustbag", "scarf", "organizer", "insert", "charm", "box only"],
    targetCond: "unknown" as const,
  };
}

function rankAndFilterComps(body: AnalyzeRequest, compsIn: Comp[]) {
  const target = buildTargetSignals(body);
  const out: Comp[] = [];

  for (const c of compsIn) {
    const titleNorm = normalize(c.title || "");
    const why: string[] = [];

    if (!c.url || !titleNorm) continue;
    if (isObviousJunkCompTitle(c.title)) continue;

    const asking = target.asking;
    const p = Number(c.price?.amount || 0);

    // drop extreme outliers
    if (Number.isFinite(asking) && asking > 0 && Number.isFinite(p) && p > 0) {
      if (asking >= 300 && p < asking * 0.25) continue;
      if (asking >= 300 && p > asking * 3.0) continue;
    }

    let score = 0;

    const negHit = target.negatives.find((n) => titleNorm.includes(normalize(n)));
    if (negHit) {
      score -= 35;
      why.push(`neg:${negHit}`);
    }

    if (target.brand) {
      if (titleNorm.includes(target.brand)) {
        score += 22;
        why.push("brand+");
      } else if (target.brandTokens.length >= 2) {
        const { hits } = tokenOverlapScore(target.brandTokens, titleNorm);
        if (hits >= 1) {
          score += 12;
          why.push("brand~");
        }
      }
    }

    if (target.modelHint) {
      if (titleNorm.includes(target.modelHint)) {
        score += 18;
        why.push("model+");
      } else if (target.modelTokens.length) {
        const { hits } = tokenOverlapScore(target.modelTokens, titleNorm);
        if (hits >= 1) {
          score += 10;
          why.push("model~");
        }
      }
    }

    if (target.size) {
      const compSize = extractSizeToken(c.title);
      if (compSize && compSize === target.size) {
        score += 20;
        why.push("size+");
      } else if (compSize && compSize !== target.size) {
        score -= 18;
        why.push(`size!(${compSize})`);
      } else {
        score -= 8;
        why.push("size?");
      }
    }

    if (target.leather) {
      const compLeather = extractLeatherToken(c.title);
      if (compLeather && compLeather === target.leather) {
        score += 10;
        why.push("leather+");
      } else if (compLeather && compLeather !== target.leather) {
        score -= 6;
        why.push(`leather!(${compLeather})`);
      }
    }

    // token overlap
    const overlap = tokenOverlapScore(
      Array.from(new Set([...(target.modelTokens || []), ...(target.coreTokens || [])])).slice(0, 8),
      titleNorm
    );
    score += overlap.score;

    // currency match
    if (c.price?.currency && target.askingCurrency && c.price.currency !== target.askingCurrency) {
      score -= 6;
      why.push("ccy!");
    }

    score += priceClosenessScore(target.asking, p);
    score = clamp(score, 0, 100);

    if (score < 45) continue;

    out.push({ ...c, qualityScore: score, qualityWhy: why });
  }

  out.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

  const topForStats = out.filter((c) => (c.qualityScore || 0) >= 60);
  const usedForStats = (topForStats.length >= 4 ? topForStats : out).slice(0, 10);

  return {
    ranked: out,
    usedForStats,
    debug: { counts: { input: compsIn.length, kept: out.length, used: usedForStats.length } },
  };
}

/**
 * You renamed “confidence” => “data coverage”
 * We keep the field name `estimate.confidence` but values are:
 *  - strong / standard / limited
 */
type DataCoverage = "strong" | "standard" | "limited";

function coverageFromQuality(usedForStats: Comp[]): DataCoverage {
  if (usedForStats.length >= 10) {
    const avg = usedForStats.reduce((s, c) => s + (c.qualityScore || 0), 0) / usedForStats.length;
    if (avg >= 78) return "strong";
    if (avg >= 68) return "standard";
    return "limited";
  }
  if (usedForStats.length >= 7) return "standard";
  return "limited";
}

/**
 * ===== MAIN HANDLER =====
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-device-id");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." });

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const noCache = String((req.query as any)?.nocache || "") === "1";

    const deviceIdHeader = req.headers["x-device-id"];
    const deviceId = typeof deviceIdHeader === "string" ? deviceIdHeader : null;
    if (!deviceId) return res.status(400).json({ error: "Missing x-device-id header" });

    const body = req.body as AnalyzeRequest;

    if (!body?.source || body.source !== "ebay") {
      return res.status(400).json({ error: "Only source=ebay supported (Phase 1)" });
    }
    if (!body?.title || !body?.price?.currency || typeof body.price.amount !== "number") {
      return res.status(400).json({ error: "Missing title/price" });
    }

    const text = `${body.title} ${body.categoryHint || ""} ${body.brand || ""}`.toLowerCase();
    if (!looksLikeBag(text)) return res.status(400).json({ error: "Phase 1 supports bags only" });

    // 1) Get or create user
    const { data: existingUser, error: userFetchErr } = await supabase
      .from("users")
      .select("*")
      .eq("device_id", deviceId)
      .maybeSingle();
    if (userFetchErr) throw userFetchErr;

    let user = existingUser;
    if (!user) {
      const { data: newUser, error: userCreateErr } = await supabase
        .from("users")
        .insert({ device_id: deviceId, plan: "free", credits_remaining: 0 })
        .select("*")
        .single();
      if (userCreateErr) throw userCreateErr;
      user = newUser;
    }

    // 2) Cache key (bump version to invalidate old cache)
    const itemKey = body.itemId || body.url;
    const cacheKey = sha256(
      `sold-only-market-active-resale-v3:${body.source}:${itemKey}:${body.title}:${body.price?.amount}:${body.price?.currency}:${
        (body as any)?.cacheBuster || ""
      }`
    );

    // Read cache (unless nocache=1)
    const now = new Date();
    if (!noCache) {
      const { data: cached } = await supabase
        .from("cache")
        .select("value_json, expires_at")
        .eq("key", cacheKey)
        .maybeSingle();

      const cacheValid = cached?.expires_at && new Date(cached.expires_at).getTime() > now.getTime();

      if (cacheValid && cached?.value_json) {
        return res.status(200).json({ ...(cached.value_json as any), cached: true });
      }
    }

    // 3) Build query + filters
    const activeQuery = buildSearchQuery(body);
    const soldQuery = buildSoldQuery(body); // ✅ key change: SOLD should use this
    const marketplaceId = marketplaceIdFromUrl(body.url);
    const filter = buildBrowseFilter(body);

    // ---------------------------
    // A) ACTIVE comps ALWAYS (for potential resale value)
    // ---------------------------
    let activeAll: Comp[] = [];
    try {
      activeAll = await fetchActiveComps({
        query: activeQuery,
        limit: 100,
        marketplaceId,
        currency: body.price.currency,
        filter,
      });
    } catch (e) {
      activeAll = [];
    }

    const activeRanked = rankAndFilterComps(body, activeAll);
    const activeUsedForStats = activeRanked.usedForStats;
    const activePrices = activeUsedForStats
      .map((c) => c.price.amount)
      .filter((n) => Number.isFinite(n) && n > 0);
    const activeMed = activePrices.length ? median(activePrices) : null;

    // ---------------------------
    // B) SOLD comps ONLY (for average market value)
    // ---------------------------
  // ---------------------------
// B) SOLD comps ONLY (for average market value)
// ---------------------------
const SOLD_WINDOWS = [365] as const;
const MIN_SOLD_FOR_STRONG = 12;

let soldAll: SoldComp[] = [];
let soldWindowDays: number | null = null;

let bestSoldCount = 0;
let bestSoldWindow: number | null = null;

// Debug diagnostics for SOLD fetch
const soldDiagnostics: any[] = [];

for (const days of SOLD_WINDOWS) {
  try {
    const sold = await fetchSoldComps({
      query: soldQuery, // ✅ use SOLD query helper (NOT activeQuery)
      limit: 100,       // ✅ Finding API max entriesPerPage is 100
      marketplaceId,
      currency: body.price.currency,
      daysBack: days,
    });

    soldDiagnostics.push({
      daysBack: days,
      query: soldQuery,
      fetched: sold.length,
    });

    if (sold.length > bestSoldCount) {
      bestSoldCount = sold.length;
      bestSoldWindow = days;
    }

    // stop early if we hit minimum
    if (sold.length >= MIN_SOLD_FOR_STRONG) {
      soldAll = sold;
      soldWindowDays = days;
      break;
    }

    // keep best attempt so far
    if (sold.length > soldAll.length) {
      soldAll = sold;
      soldWindowDays = days;
    }
  } catch (e: any) {
    soldDiagnostics.push({
      daysBack: days,
      query: soldQuery,
      error: e?.message || String(e),
    });
  }
}

    // Visibility: how many sold comps existed in the best attempt
    const soldCompsCountBestAttempt = bestSoldCount;
    const soldBestWindow = bestSoldWindow;

    // ✅ IMPORTANT: Always return a days window for UI, even if sold comps are thin.
    const finalSoldWindowDays = soldWindowDays ?? soldBestWindow ?? 365;

    // Rank + filter SOLD comps
    const soldRanked = rankAndFilterComps(body, soldAll);
    const soldCompsForUI = soldRanked.ranked.slice(0, 12);

    const soldCompsFound = soldAll.length;
    const soldKeptAfterFiltering = soldRanked.debug.counts.kept;
    const soldCompsUsed = soldRanked.debug.counts.used;

    // 5) Build payload
    let payload: any;

    // base deal ratio on SOLD median if possible
    if (soldRanked.usedForStats.length >= 4) {
      const prices = soldRanked.usedForStats
        .map((c) => c.price.amount)
        .filter((n) => Number.isFinite(n) && n > 0);

      const med = median(prices);
      const low = percentile(prices, 0.25);
      const high = percentile(prices, 0.75);

      const asking = body.price.amount;
      const ratio = asking / med;

      let score = 70;
      if (ratio <= 0.85) score = 88;
      else if (ratio <= 0.95) score = 80;
      else if (ratio <= 1.05) score = 68;
      else if (ratio <= 1.15) score = 58;
      else score = 48;

      const label = dealLabelFromRatio(ratio);
      const { title: labelTitle, emoji: labelEmoji } = dealLabelMeta(label);

      const coverage = coverageFromQuality(soldRanked.usedForStats);

      payload = {
        deal: {
          label,
          labelTitle,
          labelEmoji,
          score,
          ratio: Number(ratio.toFixed(3)),
          explanationBullets: [
            `Asking price vs SOLD median: ${(ratio * 100).toFixed(0)}%`,
            "Quality ranking filters accessories/replicas and prioritizes close model/size matches.",
          ],
        },

        // SOLD ONLY
        estimate: {
          marketValue: { amount: Math.round(med), currency: body.price.currency },
          range: {
            low: { amount: Math.round(low), currency: body.price.currency },
            high: { amount: Math.round(high), currency: body.price.currency },
          },
          confidence: coverage, // strong / standard / limited
          method: `sold-comps-median-top-quality-${finalSoldWindowDays}`,
        },

        // ACTIVE ONLY
        resale: {
          potentialValue: activeMed != null ? { amount: Math.round(activeMed), currency: body.price.currency } : null,
          count: activeAll.length,
          method: "active-comps-median-top-quality",
        },

        // For UI: show SOLD comps list
        comps: soldCompsForUI,

        meta: {
          backendVersion: "sold-market-active-resale-v3",

          sold: {
            daysWindow: finalSoldWindowDays,
            compsCount: soldCompsFound,
            soldCompsCountBestAttempt,
          },
          active: {
            compsCount: activeAll.length,
          },

          soldDiagnostics,

          // ✅ show both queries for debugging
          activeQuery,
          soldQuery,

          marketplaceId,
          filter,

          soldCompsFound,
          soldKeptAfterFiltering,
          soldCompsUsed,
          activeCompsFound: activeAll.length,
        },
      };
    } else {
      // Very limited SOLD comps: heuristic sold estimate + still return active resale
      const asking = body.price.amount;
      const est = asking * 0.93;
      const low = asking * 0.84;
      const high = asking * 1.02;

      const ratio = asking / est;

      let score = 62;
      if (ratio <= 0.95) score = 74;
      else if (ratio <= 1.05) score = 62;
      else score = 54;

      const label = dealLabelFromRatio(ratio);
      const { title: labelTitle, emoji: labelEmoji } = dealLabelMeta(label);

      payload = {
        deal: {
          label,
          labelTitle,
          labelEmoji,
          score,
          ratio: Number(ratio.toFixed(3)),
          explanationBullets: [
            `Sold comps were limited for this exact query (lookback: ${finalSoldWindowDays} days); estimate uses heuristics.`,
          ],
        },

        // SOLD ONLY (heuristic)
        estimate: {
          marketValue: { amount: Math.round(est), currency: body.price.currency },
          range: {
            low: { amount: Math.round(low), currency: body.price.currency },
            high: { amount: Math.round(high), currency: body.price.currency },
          },
          confidence: "limited",
          method: "limited-sold-signals",
        },

        // ACTIVE ONLY
        resale: {
          potentialValue: activeMed != null ? { amount: Math.round(activeMed), currency: body.price.currency } : null,
          count: activeAll.length,
          method: "active-comps-median-top-quality",
        },

        comps: soldCompsForUI,

        meta: {
          backendVersion: "sold-market-active-resale-v3",

          sold: {
            daysWindow: finalSoldWindowDays,
            compsCount: soldCompsFound,
            soldCompsCountBestAttempt,
          },
          active: {
            compsCount: activeAll.length,
          },

          soldDiagnostics,

          // ✅ show both queries for debugging
          activeQuery,
          soldQuery,

          marketplaceId,
          filter,

          soldCompsFound,
          soldKeptAfterFiltering,
          soldCompsUsed,
          activeCompsFound: activeAll.length,
        },
      };
    }

    // Credits (keep simple / your existing logic can replace this)
    const credits = { remaining: user?.credits_remaining ?? 0, plan: user?.plan || "free" };

    const responseBody = { data: { ...payload, credits }, cached: false };

    // cache write (short TTL)
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30); // 30 min
    await supabase.from("cache").upsert({
      key: cacheKey,
      value_json: responseBody,
      expires_at: expiresAt.toISOString(),
    });

    return res.status(200).json(responseBody);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
