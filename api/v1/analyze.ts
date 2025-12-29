import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

type AnalyzeRequest = {
  source: "ebay";
  url: string;
  itemId?: string;
  title: string;
  price: { amount: number; currency: string };
  condition?: string;
  brand?: string;
  categoryHint?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // --- CORS (allow browser + extension calls) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-device-id");

  // Handle preflight request
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    // Basic config check
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    const deviceIdHeader = req.headers["x-device-id"];
    const deviceId = typeof deviceIdHeader === "string" ? deviceIdHeader : null;
    if (!deviceId) {
      return res.status(400).json({ error: "Missing x-device-id header" });
    }

    const body = req.body as AnalyzeRequest;

    // Minimal validation
    if (!body?.source || body.source !== "ebay") {
      return res.status(400).json({ error: "Only source=ebay supported (Phase 1)" });
    }
    if (!body?.title || !body?.price?.currency || typeof body.price.amount !== "number") {
      return res.status(400).json({ error: "Missing title/price" });
    }

    // Bags-only coarse filter (Phase 1)
    const bagSignals = [
      "bag",
      "handbag",
      "tote",
      "flap",
      "hobo",
      "satchel",
      "shoulder bag",
      "kelly",
      "birkin",
      "chanel",
      "hermes",
      "hermès",
      "louis vuitton",
      "lv",
      "dior"
    ];
    const text = `${body.title} ${body.categoryHint || ""} ${body.brand || ""}`.toLowerCase();
    const looksLikeBag = bagSignals.some((s) => text.includes(s));
    if (!looksLikeBag) {
      return res.status(400).json({ error: "Phase 1 supports bags only" });
    }

    // 1) Get or create user by device_id
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
        .insert({ device_id: deviceId, plan: "free", credits_remaining: 3 })
        .select("*")
        .single();

      if (userCreateErr) throw userCreateErr;
      user = newUser;
    }

// 2) Enforce credits (DISABLED FOR TESTING)
// if (user.plan === "free" && user.credits_remaining <= 0) {
//   return res.status(402).json({
//     error: "No credits remaining",
//     paywall: true,
//     credits: { plan: user.plan, remaining: 0 }
//   });
// }


    // 3) Cache key (for later: real eBay calls)
    const itemKey = body.itemId || body.url;
    const cacheKey = sha256(`phase1:${body.source}:${itemKey}:${body.title}`);

    const now = new Date();

    const { data: cached } = await supabase
      .from("cache")
      .select("value_json, expires_at")
      .eq("key", cacheKey)
      .maybeSingle();

    const cacheValid = cached?.expires_at && new Date(cached.expires_at).getTime() > now.getTime();

async function decrementCreditsIfFree() {
  // Credits disabled for testing
  return user.credits_remaining;
}


    if (cacheValid && cached?.value_json) {
      const remaining = await decrementCreditsIfFree();
      return res.status(200).json({
        ...(cached.value_json as any),
        credits: { plan: user.plan, remaining },
        cached: true
      });
    }

    // 4) SIMPLE (NON-MOCK) heuristics (Phase 1)
// Goal: vary output by brand + condition + price without calling eBay yet.

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

type Tier = {
  name: string;
  retention: number; // expected resale retention vs listing price proxy (until comps)
  confidence: "low" | "medium";
};

const BRAND_TIERS: Record<string, Tier> = {
  hermes: { name: "Ultra-luxury", retention: 0.98, confidence: "medium" },
  "hermès": { name: "Ultra-luxury", retention: 0.98, confidence: "medium" },
  chanel: { name: "Ultra-luxury", retention: 0.92, confidence: "medium" },
  "louis vuitton": { name: "Luxury", retention: 0.86, confidence: "medium" },
  lv: { name: "Luxury", retention: 0.86, confidence: "medium" },
  dior: { name: "Luxury", retention: 0.84, confidence: "medium" },
  gucci: { name: "Luxury", retention: 0.78, confidence: "medium" },
  prada: { name: "Luxury", retention: 0.76, confidence: "medium" },
  celine: { name: "Luxury", retention: 0.75, confidence: "medium" },
  fendi: { name: "Luxury", retention: 0.74, confidence: "medium" },
  balenciaga: { name: "Luxury", retention: 0.70, confidence: "medium" },
  ysl: { name: "Luxury", retention: 0.72, confidence: "medium" },
  "saint laurent": { name: "Luxury", retention: 0.72, confidence: "medium" },
};

const DEFAULT_TIER: Tier = { name: "Unknown", retention: 0.68, confidence: "low" };

// Condition multipliers (applied to expected resale)
const CONDITION_MULT: Record<string, { label: string; mult: number }> = {
  new: { label: "New", mult: 1.08 },
  "new with tags": { label: "New with tags", mult: 1.12 },
  "like new": { label: "Like new", mult: 1.05 },
  "excellent": { label: "Excellent", mult: 1.02 },
  "very good": { label: "Very good", mult: 1.0 },
  "good": { label: "Good", mult: 0.90 },
  "fair": { label: "Fair", mult: 0.78 },
  "poor": { label: "Poor", mult: 0.65 },
};

function inferBrand(text: string): string | null {
  const t = text.toLowerCase();
  const keys = Object.keys(BRAND_TIERS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (t.includes(k)) return k;
  }
  return null;
}

function inferCondition(text: string): { key: string; label: string; mult: number } {
  const t = text.toLowerCase();

  // Quick signals
  if (t.includes("nwt") || t.includes("new with tags")) return { key: "new with tags", ...CONDITION_MULT["new with tags"] };
  if (t.includes("brand new") || t.includes("bnwt") || t.includes("new")) return { key: "new", ...CONDITION_MULT["new"] };
  if (t.includes("like new") || t.includes("as new")) return { key: "like new", ...CONDITION_MULT["like new"] };
  if (t.includes("excellent")) return { key: "excellent", ...CONDITION_MULT["excellent"] };
  if (t.includes("very good")) return { key: "very good", ...CONDITION_MULT["very good"] };
  if (t.includes("good")) return { key: "good", ...CONDITION_MULT["good"] };
  if (t.includes("fair")) return { key: "fair", ...CONDITION_MULT["fair"] };
  if (t.includes("poor") || t.includes("damaged") || t.includes("damage")) return { key: "poor", ...CONDITION_MULT["poor"] };

  // Default if unknown
  return { key: "very good", ...CONDITION_MULT["very good"] };
}

// Build combined text for inference
const combinedText = `${body.title} ${body.brand || ""} ${body.condition || ""} ${body.categoryHint || ""}`;

// Infer brand tier
const inferredBrandKey = inferBrand(combinedText) || (body.brand ? inferBrand(body.brand) : null);
const tier = inferredBrandKey ? BRAND_TIERS[inferredBrandKey] : DEFAULT_TIER;

// Infer condition
const cond = inferCondition(combinedText);

// Estimate resale value (heuristic)
const base = body.price.amount;
const estimatedResale = Math.round(base * tier.retention * cond.mult);

// Deal score: compare asking price vs estimated resale
// If asking price is below estimate => good deal
const delta = (estimatedResale - base) / Math.max(estimatedResale, 1); // -1..+1-ish
let score = Math.round(60 + delta * 80); // center at 60, swings with delta
score = clamp(score, 5, 98);

// Rating bands
let rating = "C";
if (score >= 90) rating = "A";
else if (score >= 80) rating = "A-";
else if (score >= 72) rating = "B+";
else if (score >= 65) rating = "B";
else if (score >= 55) rating = "B-";
else if (score >= 45) rating = "C+";
else if (score >= 35) rating = "C";
else rating = "D";

// Confidence + range width
const confidence = tier.confidence;
const rangeWidth =
  confidence === "medium" ? 0.10 : 0.18; // +/-10% or +/-18%

const low = Math.round(estimatedResale * (1 - rangeWidth));
const high = Math.round(estimatedResale * (1 + rangeWidth));

// Explanation bullets (dynamic)
const brandLabel = inferredBrandKey ? inferredBrandKey.toUpperCase() : "UNKNOWN BRAND";
const bullets = [
  `Brand signal: ${brandLabel} (${tier.name} tier).`,
  `Condition adjustment: ${cond.label} (${Math.round((cond.mult - 1) * 100)}%).`,
];

if (estimatedResale > base) {
  bullets.push(`Asking price looks below estimated resale → stronger deal.`);
} else if (estimatedResale < base) {
  bullets.push(`Asking price looks above estimated resale → weaker deal.`);
} else {
  bullets.push(`Asking price aligns with estimated resale.`);
}

bullets.push(`No sold comps yet (next step). This is a heuristic estimate.`);

// “Pseudo comps” (still not real solds, but now derived from estimate)
const comps = [
  {
    title: `Comparable (heuristic) — ${cond.label}`,
    soldPrice: { amount: Math.round(estimatedResale * 0.96), currency: body.price.currency },
    soldDate: "Heuristic",
    condition: cond.label,
    url: "https://example.com"
  },
  {
    title: `Comparable (heuristic) — ${cond.label}`,
    soldPrice: { amount: Math.round(estimatedResale * 1.03), currency: body.price.currency },
    soldDate: "Heuristic",
    condition: cond.label,
    url: "https://example.com"
  }
];

const payload = {
  deal: {
    rating,
    score,
    explanationBullets: bullets
  },
  estimate: {
    resaleValue: { amount: estimatedResale, currency: body.price.currency },
    range: {
      low: { amount: low, currency: body.price.currency },
      high: { amount: high, currency: body.price.currency }
    },
    confidence
  },
  comps
};


    // 5) Save cache (24h)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("cache").upsert({
      key: cacheKey,
      value_json: payload,
      expires_at: expiresAt
    });

    // 6) Save analysis log
    await supabase.from("analyses").insert({
      user_id: user.id,
      source: body.source,
      item_key: itemKey,
      input_json: body,
      output_json: payload
    });

    // 7) Decrement credits and respond
    const remaining = await decrementCreditsIfFree();

    return res.status(200).json({
      ...payload,
      credits: { plan: user.plan, remaining },
      cached: false
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Internal error", detail: err?.message || String(err) });
  }
}

