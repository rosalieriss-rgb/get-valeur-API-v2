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
};

let tokenCache: { accessToken: string; expiresAtMs: number } | null = null;

/**
 * ===== EBAY TOKEN (App token) =====
 */
async function getEbayAppToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 30_000) {
    return tokenCache.accessToken;
  }

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
 * Uses Browse API item_summary/search.
 */
async function fetchActiveComps(params: {
  query: string;
  limit: number;
  marketplaceId: string; // e.g., EBAY_US
  currency: string;
  filter: string;
}): Promise<Comp[]> {
  const token = await getEbayAppToken();

  const q = params.query.trim().slice(0, 200);
  const url = new URL(`${EBAY_BASE}/buy/browse/v1/item_summary/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("filter", params.filter);

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
 * ===== STATS HELPERS =====
 */
function median(nums: number[]): number {
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function percentile(nums: number[], p: number): number {
  const arr = [...nums].sort((a, b) => a - b);
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

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

/**
 * Keep size tokens like 25/30/35/40 (important for B/K + many bags)
 */
const ALLOWED_SIZES = new Set(["15", "18", "20", "22", "24", "25", "26", "27", "28", "30", "32", "33", "34", "35", "36", "38", "40", "41", "45"]);

function extractSizeToken(title: string): string | null {
  const t = normalize(title);
  // matches "Birkin 30", "Kelly 25", "30cm", "30 cm"
  const m = t.match(/\b(15|18|20|22|24|25|26|27|28|30|32|33|34|35|36|38|40|41|45)\b(?:\s*cm)?\b/);
  if (m?.[1] && ALLOWED_SIZES.has(m[1])) return m[1];
  return null;
}

const LEATHER_TOKENS = [
  "epson",
  "togo",
  "clemence",
  "swift",
  "box",
  "chevre",
  "chevre mysore",
  "chevre mysores",
  "barenia",
  "barenia faubourg",
  "alligator",
  "crocodile",
  "ostrich",
  "lizard",
];

function extractLeatherToken(title: string): string | null {
  const t = normalize(title);
  for (const lt of LEATHER_TOKENS) {
    if (t.includes(normalize(lt))) {
      // prefer shorter canonical token
      return lt.split(" ")[0];
    }
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

function tokenizeCore(title: string): string[] {
  const t = normalize(title);

  const stop = new Set([
    "bag",
    "handbag",
    "purse",
    "tote",
    "shoulder",
    "crossbody",
    "satchel",
    "hobo",
    "authentic",
    "original",
    "with",
    "all",
    "paperwork",
    "receipt",
    "dustbag",
    "dust",
    "box",
    "tags",
    "rare",
    "vintage",
    "women",
    "womens",
    "designer",
    "leather", // too generic
    "palladium", // hardware type often too noisy in search
    "gold",
    "silver",
  ]);

  const rawTokens = t.split(" ").map((x) => x.trim()).filter(Boolean);

  const out: string[] = [];
  for (const tok of rawTokens) {
    if (stop.has(tok)) continue;
    if (/^\d+$/.test(tok)) {
      if (ALLOWED_SIZES.has(tok)) {
        if (!out.includes(tok)) out.push(tok);
      }
      continue;
    }
    if (tok.length < 3) continue;
    if (!out.includes(tok)) out.push(tok);
  }

  return out;
}

function buildNegativeTerms(body: AnalyzeRequest): string[] {
  const t = normalize(body.title || "");
  const b = normalize(body.brand || "");

  const negatives: string[] = [];

  // If item isn't Hermes Birkin/Kelly, block those high-price drift terms
  const isHermes = b.includes("hermes");
  const titleHasBirkin = t.includes("birkin");
  const titleHasKelly = t.includes("kelly");

  if (!(isHermes && (titleHasBirkin || titleHasKelly))) {
    negatives.push("birkin", "kelly");
  }

  // Block "style" replicas unless the title contains them
  const noisy = ["style", "inspired", "look", "like", "replica"];
  for (const n of noisy) {
    if (!t.includes(n)) negatives.push(n);
  }

  return negatives;
}

function buildSearchQuery(body: AnalyzeRequest): string {
  const titleClean = cleanTitleForSearch(body.title || "");
  const brand = (body.brand || "").trim();
  const brandPart = brand ? `"${brand}"` : "";

  const size = extractSizeToken(titleClean);
  const leather = extractLeatherToken(titleClean);

  // Special: Hermes Birkin/Kelly must include (Birkin|Kelly) + size
  if (isBirkinOrKelly(body)) {
    const t = normalize(titleClean);
    const model = t.includes("birkin") ? "Birkin" : "Kelly";
    const parts = [
      brandPart || `"Hermes"`,
      `"${model}"`,
      size ? `"${size}"` : "",
      leather ? `"${leather}"` : "",
    ].filter(Boolean);

    return parts.join(" ").trim();
  }

  // General bags:
  const tokens = tokenizeCore(titleClean).slice(0, 7);

  // Ensure size token included if present
  if (size && !tokens.includes(size)) tokens.unshift(size);

  // Ensure leather token included if present
  if (leather && !tokens.includes(leather)) tokens.push(leather);

  const core = tokens.length ? tokens.map((t) => `"${t}"`).join(" ") : `"${titleClean}"`;
  const negatives = buildNegativeTerms(body);
  const negativeStr = negatives.map((n) => `-"${n}"`).join(" ");

  return [brandPart, core, negativeStr].filter(Boolean).join(" ").trim();
}

/**
 * Browse API filter builder.
 * Key improvement: add a price band around asking price to avoid drift.
 */
function buildBrowseFilter(body: AnalyzeRequest): string {
  const parts: string[] = [];

  // keep both auctions + fixed
  parts.push("buyingOptions:{FIXED_PRICE|AUCTION}");

  const asking = Number(body.price?.amount || 0);
  const currency = body.price?.currency || "USD";

  // price band:
  // - for expensive items, keep a tighter band (e.g. 0.70–1.35)
  // - for normal items, slightly wider (0.60–1.50)
  if (Number.isFinite(asking) && asking > 0) {
    const isExpensive = asking >= 5000;
    const lowMult = isExpensive ? 0.70 : 0.60;
    const highMult = isExpensive ? 1.35 : 1.50;

    const min = Math.max(1, Math.round(asking * lowMult));
    const max = Math.max(min + 1, Math.round(asking * highMult));

    // Browse filter price format: price:[min..max]
    // Currency is inferred from marketplace; we keep input currency for later filtering anyway.
    parts.push(`price:[${min}..${max}]`);
  }

  // You can add condition filter later if you want (e.g., NEW, USED), but leave for now.

  return parts.join(",");
}

/**
 * Simple marketplace mapping (keep EBAY_US for now).
 */
function marketplaceIdFromUrl(_url: string): string {
  return "EBAY_US";
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
    if (!deviceId) {
      return res.status(400).json({ error: "Missing x-device-id header" });
    }

    const body = req.body as AnalyzeRequest;

    if (!body?.source || body.source !== "ebay") {
      return res.status(400).json({ error: "Only source=ebay supported (Phase 1)" });
    }
    if (!body?.title || !body?.price?.currency || typeof body.price.amount !== "number") {
      return res.status(400).json({ error: "Missing title/price" });
    }

    const text = `${body.title} ${body.categoryHint || ""} ${body.brand || ""}`.toLowerCase();
    if (!looksLikeBag(text)) {
      return res.status(400).json({ error: "Phase 1 supports bags only" });
    }

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

    // 2) Cache key
    const itemKey = body.itemId || body.url;
    const cacheKey = sha256(
      `active-comps:${body.source}:${itemKey}:${body.title}:${body.price?.amount}:${body.price?.currency}:${(body as any)?.cacheBuster || ""}`
    );

    // Read cache (unless nocache=1)
    const now = new Date();
    if (!noCache) {
      const { data: cached } = await supabase
        .from("cache")
        .select("value_json, expires_at")
        .eq("key", cacheKey)
        .maybeSingle();

      const cacheValid =
        cached?.expires_at && new Date(cached.expires_at).getTime() > now.getTime();

      if (cacheValid && cached?.value_json) {
        return res.status(200).json({ ...(cached.value_json as any), cached: true });
      }
    }

    // 3) Fetch ACTIVE comps (tighter query + price band)
    const query = buildSearchQuery(body);
    const marketplaceId = marketplaceIdFromUrl(body.url);
    const filter = buildBrowseFilter(body);

    const compsAll = await fetchActiveComps({
      query,
      limit: 24,
      marketplaceId,
      currency: body.price.currency,
      filter,
    });

    // Prefer same currency
    const compsSameCurrency = compsAll.filter((c) => c.price.currency === body.price.currency);
    const comps = compsSameCurrency.length >= 4 ? compsSameCurrency : compsAll;

    // Build payload using comps if enough
    let payload: any;

    if (comps.length >= 4) {
      const prices = comps
        .map((c) => c.price.amount)
        .filter((n) => Number.isFinite(n) && n > 0);

      const med = median(prices);
      const low = percentile(prices, 0.25);
      const high = percentile(prices, 0.75);

      // Deal score: asking vs median
      const asking = body.price.amount;
      const ratio = asking / med; // <1 means good deal

      let score = 70;
      if (ratio <= 0.85) score = 88;
      else if (ratio <= 0.95) score = 80;
      else if (ratio <= 1.05) score = 68;
      else if (ratio <= 1.15) score = 58;
      else score = 48;

      const rating =
        score >= 85 ? "A" :
        score >= 75 ? "B+" :
        score >= 65 ? "B" :
        score >= 55 ? "C+" : "C";

      payload = {
        deal: {
          rating,
          score,
          explanationBullets: [
            "Estimate based on real eBay comps (active listings).",
            `Asking price vs comp median: ${(ratio * 100).toFixed(0)}%`,
            "Next: swap active comps → SOLD comps when access/data source is available.",
          ],
        },
        estimate: {
          resaleValue: { amount: Math.round(med), currency: body.price.currency },
          range: {
            low: { amount: Math.round(low), currency: body.price.currency },
            high: { amount: Math.round(high), currency: body.price.currency },
          },
          confidence: prices.length >= 12 ? "high" : (prices.length >= 7 ? "medium" : "low"),
          method: "active-comps-median",
        },
        comps: comps.slice(0, 12),
        meta: {
          compsType: "active",
          query,
          marketplaceId,
          filter,
          totalCompsFound: compsAll.length,
        },
      };
    } else {
      // Fallback heuristic (still sane)
      const asking = body.price.amount;
      const est = asking * 0.93;
      const low = asking * 0.84;
      const high = asking * 1.02;

      const ratio = asking / est;
      let score = 62;
      if (ratio <= 0.95) score = 74;
      else if (ratio <= 1.05) score = 62;
      else score = 54;

      const rating =
        score >= 85 ? "A" :
        score >= 75 ? "B+" :
        score >= 65 ? "B" :
        score >= 55 ? "C+" : "C";

      payload = {
        deal: {
          rating,
          score,
          explanationBullets: [
            "Not enough matching comps found via eBay search (active listings).",
            "Using heuristic estimate based on asking price and basic signals.",
            "Next: improve model/size parsing for tighter comps.",
          ],
        },
        estimate: {
          resaleValue: { amount: Math.round(est), currency: body.price.currency },
          range: {
            low: { amount: Math.round(low), currency: body.price.currency },
            high: { amount: Math.round(high), currency: body.price.currency },
          },
          confidence: "low",
          method: "fallback-heuristic",
        },
        comps: compsAll.slice(0, 12),
        meta: {
          compsType: "heuristic",
          query,
          marketplaceId,
          filter,
          totalCompsFound: compsAll.length,
        },
      };
    }

    // 5) Cache (6h)
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    await supabase.from("cache").upsert({
      key: cacheKey,
      value_json: payload,
      expires_at: expiresAt,
    });

    // 6) Log analysis
    await supabase.from("analyses").insert({
      user_id: user.id,
      source: body.source,
      item_key: itemKey,
      input_json: body,
      output_json: payload,
    });

    return res.status(200).json({ ...payload, cached: false });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Internal error", detail: err?.message || String(err) });
  }
}
