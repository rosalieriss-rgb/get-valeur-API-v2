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
 * Uses OAuth client_credentials grant.
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
      // Note: this scope string is the standard eBay scope; it works with sandbox/prod base URLs.
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
 * Browse API is active listings; this is our "real comps now" source.
 */
async function fetchActiveComps(params: {
  query: string;
  limit: number;
  marketplaceId: string; // e.g., EBAY_US
  currency: string;
}): Promise<Comp[]> {
  const token = await getEbayAppToken();

  const q = params.query.trim().slice(0, 140);
  const url = new URL(`${EBAY_BASE}/buy/browse/v1/item_summary/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE|AUCTION}");

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
        title: String(it?.title || "").slice(0, 160),
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

/**
 * ===== ROBUST FILTER HELPERS =====
 * Prevent "median explodes" when search returns unrelated expensive items.
 */
function normalize(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function brandAliases(brand?: string): string[] {
  const b = normalize(brand || "");
  if (!b) return [];

  // Minimal aliases for now — extend later as needed.
  if (b.includes("louis vuitton")) return ["louis vuitton", "lv"];
  if (b.includes("saint laurent")) return ["saint laurent", "ysl"];
  if (b.includes("hermes") || b.includes("hermès")) return ["hermes", "hermès"];
  return [b];
}

function iqrBounds(nums: number[]) {
  if (nums.length < 8) return { lo: -Infinity, hi: Infinity }; // not enough data
  const q1 = percentile(nums, 0.25);
  const q3 = percentile(nums, 0.75);
  const iqr = q3 - q1;
  return { lo: q1 - 1.5 * iqr, hi: q3 + 1.5 * iqr };
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
    "hermès",
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
  const t = text.toLowerCase();
  return bagSignals.some((s) => t.includes(s));
}

/**
 * ===== QUERY CLEANING (IMPORTANT) =====
 * Reduce noisy titles so eBay search returns tighter comps.
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
    "new",
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

function buildSearchQuery(body: AnalyzeRequest): string {
  const title = cleanTitleForSearch(body.title || "");
  const brand = (body.brand || "").trim();

  // If title already contains brand, keep title as-is.
  if (brand && title.toLowerCase().includes(brand.toLowerCase())) return title;

  // Otherwise prefix brand for better match.
  if (brand) return `${brand} ${title}`.trim();

  return title;
}

/**
 * Simple marketplace mapping (keep EBAY_US for now).
 * Later we can map by domain (.fr/.it/.de), but this is fine for v1.
 */
function marketplaceIdFromUrl(url: string): string {
  return "EBAY_US";
}

/**
 * ===== MAIN HANDLER =====
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-device-id");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed. Use POST." });
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

    // 3) Fetch ACTIVE comps
    const query = buildSearchQuery(body);
    const marketplaceId = marketplaceIdFromUrl(body.url);

    const compsAll = await fetchActiveComps({
      query,
      limit: 24,
      marketplaceId,
      currency: body.price.currency,
    });

    // Prefer same currency if enough exist
    const compsSameCurrency = compsAll.filter((c) => c.price.currency === body.price.currency);
    const compsBase = compsSameCurrency.length >= 4 ? compsSameCurrency : compsAll;

    // --- Robust comp filtering (prevents crazy medians) ---
    const asking = body.price.amount;
    const aliases = brandAliases(body.brand);

    let compsUsed = compsBase;

    // 1) Brand gate (only if brand provided)
    if (aliases.length) {
      const gated = compsUsed.filter((c) => {
        const t = normalize(c.title);
        return aliases.some((a) => t.includes(a));
      });
      if (gated.length >= 4) compsUsed = gated; // only accept if still enough
    }

    // 2) Sanity band vs asking (tunable)
    // Keeps results from including totally different categories (e.g. Birkin sneaking in)
    const banded = compsUsed.filter((c) => {
      const p = c.price.amount;
      return Number.isFinite(p) && p > 0 && p >= asking * 0.25 && p <= asking * 4;
    });
    if (banded.length >= 4) compsUsed = banded;

    // 3) IQR outlier removal
    const pricesForIqr = compsUsed
      .map((c) => c.price.amount)
      .filter((n) => Number.isFinite(n) && n > 0);

    const { lo, hi } = iqrBounds(pricesForIqr);
    const iqrFiltered = compsUsed.filter((c) => c.price.amount >= lo && c.price.amount <= hi);
    if (iqrFiltered.length >= 4) compsUsed = iqrFiltered;
    // --- End robust filtering ---

    // Build payload using comps if enough
    let payload: any;

    if (compsUsed.length >= 4) {
      const prices = compsUsed
        .map((c) => c.price.amount)
        .filter((n) => Number.isFinite(n) && n > 0);

      const med = median(prices);
      const low = percentile(prices, 0.25);
      const high = percentile(prices, 0.75);

      // Deal score: asking vs median
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

      const confidence =
        prices.length >= 16 ? "high" :
        prices.length >= 10 ? "medium" :
        "low";

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
          confidence,
          method: "active-comps-median",
        },
        comps: compsUsed.slice(0, 12),
        meta: {
          compsType: "active",
          query,
          marketplaceId,
          totalCompsFound: compsAll.length,
          compsUsed: compsUsed.length,
          filters: {
            brandGate: aliases.length ? aliases : null,
            sanityBand: { min: asking * 0.25, max: asking * 4 },
            iqr: pricesForIqr.length >= 8 ? true : false,
          },
        },
      };
    } else {
      // 4) Fallback heuristic (still sane!)
      const est = asking * 0.93; // slightly under asking for "expected resale" (tunable)
      const low = asking * 0.84;
      const high = asking * 1.02;

      // Score heuristic
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
            "Next: improve search query parsing (model/size) for tighter comps.",
          ],
        },
        estimate: {
          resaleValue: { amount: Math.round(est), currency: body.price.currency },
          range: {
            low: { amount: Math.round(low), currency: body.price.currency },
            high: { amount: Math.round(high), currency: body.price.currency },
          },
          confidence: "medium",
          method: "fallback-heuristic",
        },
        comps: compsAll.slice(0, 12),
        meta: {
          compsType: "heuristic",
          query,
          marketplaceId,
          totalCompsFound: compsAll.length,
          compsUsed: compsUsed.length,
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
    return res.status(500).json({
      error: "Internal error",
      detail: err?.message || String(err),
    });
  }
}
