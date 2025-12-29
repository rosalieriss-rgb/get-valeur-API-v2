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
      "bag", "handbag", "tote", "flap", "hobo", "satchel", "shoulder bag",
      "kelly", "birkin", "chanel", "hermes", "hermès", "louis vuitton", "lv", "dior"
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

    // 2) Enforce credits
    if (user.plan === "free" && user.credits_remaining <= 0) {
      return res.status(402).json({
        error: "No credits remaining",
        paywall: true,
        credits: { plan: user.plan, remaining: 0 }
      });
    }

    // 3) Cache key (for later: real eBay calls)
    const itemKey = body.itemId || body.url;
    const cacheKey = sha256(`phase1:${body.source}:${itemKey}:${body.title}`);

    const now = new Date();

    const { data: cached } = await supabase
      .from("cache")
      .select("value_json, expires_at")
      .eq("key", cacheKey)
      .maybeSingle();

    const cacheValid =
      cached?.expires_at && new Date(cached.expires_at).getTime() > now.getTime();

    // Decrement credits helper
    async function decrementCreditsIfFree() {
      if (user.plan !== "free") return null;
      const remaining = user.credits_remaining - 1;
      await supabase
        .from("users")
        .update({ credits_remaining: remaining, updated_at: new Date().toISOString() })
        .eq("id", user.id);
      return remaining;
    }

    if (cacheValid && cached?.value_json) {
      const remaining = await decrementCreditsIfFree();
      return res.status(200).json({
        ...(cached.value_json as any),
        credits: { plan: user.plan, remaining: remaining },
        cached: true
      });
    }

    // 4) MOCK analysis payload (replace in Step 3 with real sold comps)
    // Simple mock: resale ~ 88% of list price
    const mockResale = Math.round(body.price.amount * 0.88);

    const payload = {
      deal: {
        rating: "B+",
        score: 78,
        explanationBullets: [
          "Backend + credits are working.",
          "These comps are mocked for now.",
          "Next: connect real eBay sold comparables."
        ]
      },
      estimate: {
        resaleValue: { amount: mockResale, currency: body.price.currency },
        range: {
          low: { amount: Math.round(mockResale * 0.93), currency: body.price.currency },
          high: { amount: Math.round(mockResale * 1.04), currency: body.price.currency }
        },
        confidence: "low"
      },
      comps: [
        {
          title: "Mock comp #1",
          soldPrice: { amount: Math.round(mockResale * 0.95), currency: body.price.currency },
          soldDate: "2025-11-18",
          condition: "Pre-owned",
          url: "https://example.com"
        },
        {
          title: "Mock comp #2",
          soldPrice: { amount: Math.round(mockResale * 1.02), currency: body.price.currency },
          soldDate: "2025-11-05",
          condition: "Pre-owned",
          url: "https://example.com"
        }
      ]
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
