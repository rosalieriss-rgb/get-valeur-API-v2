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

const EBAY_FINDING_ENDPOINT = "https://svcs.ebay.com/services/search/FindingService/v1";
// For Finding API completed items. This is your AppID = EBAY_CLIENT_ID.
const EBAY_APP_ID = EBAY_CLIENT_ID || "";

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
  soldDate?: string; // ISO date string
};


let tokenCache: { accessToken: string; expiresAtMs: number } | null = null;

/**
 * ===== USER-FRIENDLY DEAL LABELS =====
 */
type DealLabel = "great_deal" | "fair_price" | "overpriced";

function dealLabelFromRatio(ratio: number): DealLabel {
  // ratio = asking / compMedian
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

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
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

const ALLOWED_SIZES = new Set([
  "15",
  "18",
  "20",
  "22",
  "24",
  "25",
  "26",
  "27",
  "28",
  "30",
  "32",
  "33",
  "34",
  "35",
  "36",
  "38",
  "40",
  "41",
  "45",
]);

function extractSizeToken(title: string): string | null {
  const t = normalize(title);
  const m = t.match(
    /\b(15|18|20|22|24|25|26|27|28|30|32|33|34|35|36|38|40|41|45)\b(?:\s*cm)?\b/
  );
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
    if (t.includes(normalize(lt))) return lt.split(" ")[0];
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
    "leather",
    "palladium",
    "gold",
    "silver",
    "hardware",
    "auth",
    "cert",
  ]);

  const rawTokens = t.split(" ").map((x) => x.trim()).filter(Boolean);

  const out: string[] = [];
  for (const tok of rawTokens) {
    if (stop.has(tok)) continue;
    if (/^\d+$/.test(tok)) {
      if (ALLOWED_SIZES.has(tok) && !out.includes(tok)) out.push(tok);
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

  const isHermes = b.includes("hermes");
  const titleHasBirkin = t.includes("birkin");
  const titleHasKelly = t.includes("kelly");
  if (!(isHermes && (titleHasBirkin || titleHasKelly))) negatives.push("birkin", "kelly");

  const noisy = ["style", "inspired", "look", "like", "replica", "dupe", "faux", "not authentic"];
  for (const n of noisy) {
    if (!t.includes(n)) negatives.push(n);
  }

  return negatives;
}

/**
 * Light model extraction
 */
function extractModelHint(body: AnalyzeRequest): string | null {
  const t = normalize(body.title || "");
  const patterns: Array<{ re: RegExp; model: string }> = [
    { re: /\bbirkin\b/, model: "birkin" },
    { re: /\bkelly\b/, model: "kelly" },
    { re: /\bclassic\s+flap\b/, model: "classic flap" },
    { re: /\b2\.?55\b/, model: "2.55" },
    { re: /\bboy\b/, model: "boy" },
    { re: /\bneverfull\b/, model: "neverfull" },
    { re: /\bspeedy\b/, model: "speedy" },
    { re: /\balma\b/, model: "alma" },
    { re: /\bcapucines\b/, model: "capucines" },
    { re: /\bpeekaboo\b/, model: "peekaboo" },
    { re: /\bbaguette\b/, model: "baguette" },
    { re: /\bsaddle\b/, model: "saddle" },
    { re: /\bbook\s+tote\b/, model: "book tote" },
    { re: /\blady\s+dior\b/, model: "lady dior" },
    { re: /\bcassandre\b/, model: "cassandre" },
    { re: /\ble\s+5\s+a\s+7\b/, model: "le 5 a 7" },
    { re: /\bloulou\b/, model: "loulou" },
    { re: /\bjamie\b/, model: "jamie" },
  ];
  for (const p of patterns) if (p.re.test(t)) return p.model;
  return null;
}

function buildSearchQuery(body: AnalyzeRequest): string {
  const titleClean = cleanTitleForSearch(body.title || "");
  const brand = (body.brand || "").trim();
  const brandPart = brand ? `"${brand}"` : "";

  const size = extractSizeToken(titleClean);
  const leather = extractLeatherToken(titleClean);
  const modelHint = extractModelHint(body);

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

  const tokens = tokenizeCore(titleClean).slice(0, 7);

  if (modelHint) {
    const mh = normalize(modelHint);
    if (!tokens.includes(mh)) tokens.unshift(mh);
  }

  if (size && !tokens.includes(size)) tokens.unshift(size);
  if (leather && !tokens.includes(leather)) tokens.push(leather);

  const core = tokens.length ? tokens.map((t) => `"${t}"`).join(" ") : `"${titleClean}"`;
  const negatives = buildNegativeTerms(body);
  const negativeStr = negatives.map((n) => `-"${n}"`).join(" ");

  return [brandPart, core, negativeStr].filter(Boolean).join(" ").trim();
}

function buildBrowseFilter(body: AnalyzeRequest): string {
  const parts: string[] = [];
  parts.push("buyingOptions:{FIXED_PRICE|AUCTION}");

  const asking = Number(body.price?.amount || 0);
  if (Number.isFinite(asking) && asking > 0) {
    const isExpensive = asking >= 5000;
    const lowMult = isExpensive ? 0.70 : 0.60;
    const highMult = isExpensive ? 1.35 : 1.50;

    const min = Math.max(1, Math.round(asking * lowMult));
    const max = Math.max(min + 1, Math.round(asking * highMult));

    parts.push(`price:[${min}..${max}]`);
  }

  return parts.join(",");
}

function marketplaceIdFromUrl(_url: string): string {
  return "EBAY_US";
}

/**
 * ===== COMP QUALITY RANKING =====
 */
const JUNK_PHRASES = [
  "strap",
  "shoulder strap",
  "chain",
  "charm",
  "bag charm",
  "twilly",
  "scarf",
  "keychain",
  "key chain",
  "key holder",
  "wallet",
  "card holder",
  "cardholder",
  "coin purse",
  "pouch",
  "insert",
  "organizer",
  "base shaper",
  "shaper",
  "stuffing",
  "raincoat",
  "rain coat",
  "cover",
  "replacement",
  "repair",
  "handle",
  "hardware",
  "lock only",
  "keys only",
  "certificate only",
  "auth card",
  "authenticity card",
  "receipt only",
  "box only",
  "dust bag only",
  "dustbag only",
  "for parts",
  "parts only",
];

const REPLICA_SIGNALS = [
  "replica",
  "super fake",
  "dupe",
  "inspired",
  "style",
  "look like",
  "not authentic",
  "faux",
  "knockoff",
  "counterfeit",
  "copy",
  "mirror 1:1",
];

function isObviousJunkCompTitle(title: string): boolean {
  const t = normalize(title);
  if (!t) return true;
  if (REPLICA_SIGNALS.some((s) => t.includes(normalize(s)))) return true;
  if (JUNK_PHRASES.some((p) => t.includes(normalize(p)))) return true;
  return false;
}

function normalizeBrand(b: string | undefined): string | null {
  const t = normalize(b || "");
  if (!t) return null;
  if (t === "louisvuitton") return "louis vuitton";
  if (t === "saintlaurent") return "saint laurent";
  if (t === "yvessaintlaurent") return "saint laurent";
  return t;
}

function conditionBucket(cond?: string): "new" | "used" | "unknown" {
  const c = normalize(cond || "");
  if (!c) return "unknown";
  if (c.includes("new") || c.includes("brand new") || c.includes("unused")) return "new";
  if (
    c.includes("pre-owned") ||
    c.includes("used") ||
    c.includes("very good") ||
    c.includes("good") ||
    c.includes("acceptable")
  )
    return "used";
  return "unknown";
}

function buildTargetSignals(body: AnalyzeRequest) {
  const titleClean = cleanTitleForSearch(body.title || "");
  const brand = normalizeBrand(body.brand) || "";
  const size = extractSizeToken(titleClean);
  const leather = extractLeatherToken(titleClean);
  const modelHint = extractModelHint(body);

  const coreTokens = tokenizeCore(titleClean);
  const modelTokens = modelHint?.split(" ").map(normalize).filter(Boolean) || [];
  const brandTokens = brand ? brand.split(" ").map((x) => x.trim()).filter(Boolean) : [];
  const negatives = buildNegativeTerms(body);

  return {
    brand,
    size,
    leather,
    modelHint: modelHint ? normalize(modelHint) : null,
    coreTokens,
    modelTokens,
    brandTokens,
    negatives,
    asking: Number(body.price?.amount || 0),
    askingCurrency: body.price?.currency || "USD",
    targetCond: conditionBucket(body.condition),
  };
}

function tokenOverlapScore(targetTokens: string[], compTitleNorm: string) {
  if (!targetTokens.length) return { hits: 0, total: 0, score: 0 };
  let hits = 0;
  for (const tok of targetTokens) {
    const n = normalize(tok);
    if (!n) continue;
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(compTitleNorm)) hits += 1;
  }
  const total = targetTokens.length;
  const ratio = total ? hits / total : 0;
  const score = Math.round(45 * Math.pow(ratio, 0.7));
  return { hits, total, score };
}

function priceClosenessScore(asking: number, compPrice: number) {
  if (!Number.isFinite(asking) || asking <= 0 || !Number.isFinite(compPrice) || compPrice <= 0)
    return 0;
  const r = compPrice / asking;
  const dist = Math.abs(Math.log(r));
  return Math.round(clamp(25 * (1 - dist / 1.0), 0, 25));
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
        if (hits >= Math.min(2, target.modelTokens.length)) {
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

    const overlap = tokenOverlapScore(
      Array.from(new Set([...(target.modelTokens || []), ...(target.coreTokens || [])])).slice(0, 8),
      titleNorm
    );
    score += overlap.score;

    const tc = target.targetCond;
    const cc = conditionBucket(c.condition);
    if (tc !== "unknown" && cc !== "unknown") {
      if (tc === cc) score += 6;
      else score -= 4;
    }

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

function confidenceFromQuality(usedForStats: Comp[]): "high" | "medium" | "low" {
  if (usedForStats.length >= 10) {
    const avg = usedForStats.reduce((s, c) => s + (c.qualityScore || 0), 0) / usedForStats.length;
    if (avg >= 78) return "high";
    if (avg >= 68) return "medium";
    return "low";
  }
  if (usedForStats.length >= 7) return "medium";
  return "low";
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
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed. Use POST." });

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

    // 2) Cache key (bump version to invalidate old cache)
    const itemKey = body.itemId || body.url;
    const cacheKey = sha256(
      `active-comps:v100:${body.source}:${itemKey}:${body.title}:${body.price?.amount}:${body.price?.currency}:${
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

      const cacheValid =
        cached?.expires_at && new Date(cached.expires_at).getTime() > now.getTime();

      if (cacheValid && cached?.value_json) {
        return res.status(200).json({ ...(cached.value_json as any), cached: true });
      }
    }

 // 3) Build query
const query = buildSearchQuery(body);
const marketplaceId = marketplaceIdFromUrl(body.url);
const filter = buildBrowseFilter(body);

// 3A) Try SOLD first with expanding windows
const SOLD_WINDOWS = [90, 180, 365];
const MIN_COMPS = 12;

let compsAll: any[] = [];
let compsSource: "sold" | "active" = "sold";
let windowDays: number | null = null;

// Try SOLD windows progressively
for (const days of SOLD_WINDOWS) {
  try {
    const sold = await fetchSoldComps({
      query,
      limit: 120, // fetch more, filter later
      marketplaceId,
      currency: body.price.currency,
      daysBack: days, // <-- keep daysBack (matches your function)
    });

    // If we have enough, stop here
    if (sold.length >= MIN_COMPS) {
      compsAll = sold;
      windowDays = days;
      break;
    }

    // Otherwise keep the best sold attempt so far
    if (sold.length > compsAll.length) {
      compsAll = sold;
      windowDays = days;
    }
  } catch (e) {
    // ignore and try next window
  }
}
// 3B) Fallback to ACTIVE ONLY if SOLD returned nothing
if (compsAll.length === 0) {
  compsSource = "active";
  windowDays = null;

  compsAll = await fetchActiveComps({
    query,
    limit: 120,
    marketplaceId,
    currency: body.price.currency,
    filter,
  });
} else {
  compsSource = "sold";
  // windowDays is already set to the best window we found (90/180/365)
}



    
    // 4) Rank + filter comps
    const { ranked, usedForStats, debug } = rankAndFilterComps(body, compsAll);
    const compsForUI = ranked.slice(0, 12);

    let payload: any;

    if (usedForStats.length >= 4) {
      const prices = usedForStats
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
      const confidence = confidenceFromQuality(usedForStats);

      payload = {
        deal: {
          label,
          labelTitle,
          labelEmoji,
          score,
          ratio: Number(ratio.toFixed(3)),
          explanationBullets: [
            `Estimate based on top-quality eBay comps (active listings): ${usedForStats.length} used.`,
            `Asking price vs comp median: ${(ratio * 100).toFixed(0)}%`,
            "Quality ranking filters accessories/replicas and prioritizes close model/size matches.",
          ],
        },
        estimate: {
          resaleValue: { amount: Math.round(med), currency: body.price.currency },
          range: {
            low: { amount: Math.round(low), currency: body.price.currency },
            high: { amount: Math.round(high), currency: body.price.currency },
          },
          confidence,
          method: "active-comps-median-top-quality",
        },
        comps: compsForUI,
     meta: {
  backendVersion: "sold-comps-v1",

  // source of comps
  compsSource,
  windowDays,

  // backward compatibility
  compsType: compsSource === "sold" ? "sold" : "active",

  // 🔎 DEBUG / VISIBILITY
  soldCompsCount: compsSource === "sold" ? compsAll.length : 0,

  // existing fields
  query,
  marketplaceId,
  filter,

  compsFound: compsAll.length,
  keptAfterFiltering: debug.counts.kept,
  compsUsed: debug.counts.used,
},


      };
    } else {
      // Limited comps: still return labels (no A/B/C)
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
            "Not enough high-quality matching comps found in active listings.",
            "Showing a low-confidence estimate based on available signals.",
          ],
        },
        estimate: {
          resaleValue: { amount: Math.round(est), currency: body.price.currency },
          range: {
            low: { amount: Math.round(low), currency: body.price.currency },
            high: { amount: Math.round(high), currency: body.price.currency },
          },
          confidence: "low",
          method: "limited-signals",
        },
        comps: compsForUI.length ? compsForUI : compsAll.slice(0, 12),
        meta: {
          backendVersion: "deal-labels-v1",
          compsType: "limited",
          query,
          marketplaceId,
          filter,
          totalCompsFound: compsAll.length,
          keptAfterFiltering: debug.counts.kept,
          usedForStats: debug.counts.used,
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
