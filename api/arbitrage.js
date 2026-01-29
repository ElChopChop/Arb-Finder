// api/arbitrage.js
// Vercel serverless note: in-memory caches are "best effort" (may reset between cold starts),
// but they still dramatically reduce RapidAPI usage during bursts/testing.

const RESPONSE_CACHE = new Map(); // cacheKey -> { expires, payload }
const EBAY_CACHE = new Map();     // ebayKeywords -> { expires, data }
const ALI_CACHE = new Map();      // aliKey -> { expires, data }
const RATE_LIMIT = new Map();     // ip -> { windowStart, count }

function getIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? String(fwd).split(",")[0].trim() : "unknown";
}

function rateLimitOk(ip, limit = 10, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip);
  if (!entry || now - entry.windowStart > windowMs) {
    RATE_LIMIT.set(ip, { windowStart: now, count: 1 });
    return { ok: true, remaining: limit - 1 };
  }
  if (entry.count >= limit) return { ok: false, remaining: 0 };
  entry.count += 1;
  return { ok: true, remaining: limit - entry.count };
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    map.delete(key);
    return null;
  }
  return hit.payload ?? hit.data ?? null;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, { expires: Date.now() + ttlMs, payload: value, data: value });
}

function normalizeAliLink(link) {
  if (!link) return "";
  let s = String(link).trim();
  if (s.startsWith("//")) s = "https:" + s;
  if (s.startsWith("www.")) s = "https://" + s;
  return s;
}

function deepFindFirst(obj, predicate, maxNodes = 7000) {
  const stack = [obj];
  let nodes = 0;
  while (stack.length && nodes < maxNodes) {
    const cur = stack.pop();
    nodes++;
    if (predicate(cur)) return cur;

    if (cur && typeof cur === "object") {
      if (Array.isArray(cur)) {
        for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      } else {
        for (const k of Object.keys(cur)) stack.push(cur[k]);
      }
    }
  }
  return null;
}

function deepGetByKey(obj, keys) {
  const keySet = new Set(keys.map((k) => k.toLowerCase()));
  const found = deepFindFirst(obj, (x) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return false;
    return Object.keys(x).some((k) => keySet.has(k.toLowerCase()));
  });
  if (!found) return null;

  for (const k of Object.keys(found)) {
    if (keySet.has(k.toLowerCase())) return found[k];
  }
  return null;
}

function parsePriceFromString(s) {
  if (!s) return 0;
  const str = String(s).trim();
  if (!str) return 0;
  if (/^\d{8,}$/.test(str)) return 0; // IDs

  const norm = str.replace(",", ".");
  const m = norm.match(/(\d+(\.\d+)?)/);
  if (!m) return 0;

  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0 || n > 10000) return 0;
  return n;
}

// --- AliExpress extractors (fixed to DataHub item_search_2 shape) ---
function aliExtractId(obj) {
  const item = obj?.item || obj;

  const direct =
    item?.itemId ??
    item?.item_id ??
    item?.productId ??
    item?.product_id ??
    item?.id ??
    null;

  if (typeof direct === "string" || typeof direct === "number") return String(direct);

  const v =
    deepGetByKey(obj, ["itemId", "item_id", "productId", "product_id", "id", "offerId", "offer_id"]) || "";
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

function aliExtractTitle(obj) {
  const item = obj?.item || obj;

  const direct = item?.title ?? item?.name ?? null;
  if (typeof direct === "string") return direct.trim();

  const v = deepGetByKey(obj, ["title", "productTitle", "product_title", "name", "itemTitle", "item_title"]) || "";
  return typeof v === "string" ? v.trim() : String(v || "").trim();
}

function aliExtractLink(obj) {
  const item = obj?.item || obj;

  const direct = item?.itemUrl ?? item?.item_url ?? item?.url ?? null;
  if (typeof direct === "string" && direct) return normalizeAliLink(direct);

  const maybeItem = deepFindFirst(obj, (x) => typeof x === "string" && /aliexpress\.com\/item\//i.test(x));
  if (typeof maybeItem === "string") return normalizeAliLink(maybeItem);

  const urlLike = deepFindFirst(obj, (x) => typeof x === "string" && /aliexpress\.com/i.test(x));
  if (typeof urlLike === "string") return normalizeAliLink(urlLike);

  const v =
    deepGetByKey(obj, ["product_url", "productUrl", "item_url", "itemUrl", "detail_url", "detailUrl", "url"]) || "";
  return normalizeAliLink(typeof v === "string" ? v : String(v || ""));
}

function aliExtractPrice(obj) {
  const item = obj?.item || obj;

  // PRIMARY: DataHub item_search_2
  // item.sku.def.promotionPrice OR item.sku.def.price
  const promo = item?.sku?.def?.promotionPrice;
  if (typeof promo === "number" && promo > 0) return promo;
  if (typeof promo === "string") {
    const n = parsePriceFromString(promo);
    if (n) return n;
  }

  const price = item?.sku?.def?.price;
  if (typeof price === "number" && price > 0) return price;
  if (typeof price === "string") {
    const n = parsePriceFromString(price);
    if (n) return n;
  }

  // SECONDARY: common variants
  const preferred =
    deepGetByKey(obj, [
      "promotionPrice",
      "promotion_price",
      "sale_price_format",
      "price_format",
      "price_str",
      "salePrice",
      "sale_price",
      "currentPrice",
      "current_price",
      "price",
      "minPrice",
      "min_price",
      "final_price",
      "finalPrice"
    ]) ?? null;

  if (typeof preferred === "number") {
    if (Number.isInteger(preferred) && preferred >= 1000 && preferred <= 500000) return preferred / 100;
    if (preferred > 0 && preferred < 5000) return preferred;
    return 0;
  }

  if (preferred && typeof preferred === "object") {
    const inner = deepGetByKey(preferred, ["value", "amount", "current", "min", "max", "price"]) ?? null;
    if (typeof inner === "number") {
      if (Number.isInteger(inner) && inner >= 1000 && inner <= 500000) return inner / 100;
      return inner > 0 && inner < 5000 ? inner : 0;
    }
    if (typeof inner === "string") {
      const n = parsePriceFromString(inner);
      return n > 0 && n < 5000 ? n : 0;
    }
  }

  if (typeof preferred === "string") {
    const n = parsePriceFromString(preferred);
    return n > 0 && n < 5000 ? n : 0;
  }

  // fallback scan: only accept strings that look like prices
  const priceLike = deepFindFirst(obj, (x) => {
    if (typeof x !== "string") return false;
    const s = x.trim();
    if (s.length < 2 || s.length > 40) return false;
    if (/^\d{8,}$/.test(s)) return false; // IDs
    const hasCurrency = /(\$|£|€|US\s?\$|GBP|EUR)/.test(s);
    const hasDecimal = /\d+[.,]\d{1,2}\b/.test(s);
    return (hasCurrency || hasDecimal) && /\d/.test(s);
  });

  if (typeof priceLike === "string") {
    const n = parsePriceFromString(priceLike);
    return n > 0 && n < 5000 ? n : 0;
  }

  return 0;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Rate limit
  const ip = getIp(req);
  const rl = rateLimitOk(ip, 10, 10 * 60 * 1000);
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  if (!rl.ok) return res.status(429).json({ error: "Rate limit exceeded. Try again later." });

  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const RAPIDAPI_HOST_ALI = process.env.RAPIDAPI_HOST_ALI || "aliexpress-datahub.p.rapidapi.com";
  const RAPIDAPI_HOST_EBAY = process.env.RAPIDAPI_HOST_EBAY || "ebay-average-selling-price.p.rapidapi.com";
  if (!RAPIDAPI_KEY) return res.status(500).json({ error: "Missing RAPIDAPI_KEY env var" });

  const debug = req.query.debug === "1";

  // HARD CAPS
  const top = Math.min(parseInt(req.query.top || "25", 10) || 25, 50);
  const aliCallCap = Math.min(parseInt(req.query.seeds || "2", 10) || 2, 2); // <= 2 Ali calls/request
  const perSeedAliItems = Math.min(parseInt(req.query.perSeed || "10", 10) || 10, 10);
  const ebayBudget = Math.min(parseInt(req.query.ebayBudget || "8", 10) || 8, 10);

  // Cache final response for 30 min
  const cacheKey = req.url;
  const cached = cacheGet(RESPONSE_CACHE, cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cached);
  }
  res.setHeader("X-Cache", "MISS");

  const category = String(req.query.category || "");
  const minProfit = Number.isFinite(parseFloat(req.query.minProfit)) ? parseFloat(req.query.minProfit) : 0;

  const CATEGORY_SEEDS = {
    electronics: ["bluetooth earbuds", "usb c hub", "wireless charger", "mini projector"],
    automotive: ["dash cam", "car phone holder", "tire inflator", "obd2 scanner"],
    health_beauty: ["hair trimmer", "nail drill", "massage gun"],
    home_garden: ["led strip lights", "handheld vacuum", "storage organizer"]
  };

  const SEEDS =
    CATEGORY_SEEDS[category] ||
    ["bluetooth earbuds", "usb c hub", "wireless charger", "dash cam", "car phone holder", "hair trimmer"];

  let aliCalls = 0;
  let ebayCalls = 0;

  async function fetchAliItems(query, page = 1) {
    // 6 hour cache per query+page
    const aliCacheKey = `${query}::${page}`;
    const cached = cacheGet(ALI_CACHE, aliCacheKey);
    if (cached) return cached;

    if (aliCalls >= aliCallCap) {
      return { status: 0, url: "", providerStatus: null, raw_head: "", items: [], budgetExceeded: true };
    }
    aliCalls++;

    const aliUrl =
      `https://${RAPIDAPI_HOST_ALI}/item_search_2` +
      `?q=${encodeURIComponent(query)}` +
      `&page=${page}` +
      `&sort=default`;

    const aliResp = await fetch(aliUrl, {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST_ALI
      }
    });

    const aliText = await aliResp.text();
    let aliData = null;
    try { aliData = JSON.parse(aliText); } catch { aliData = null; }

    const items =
      aliData?.result?.items ||
      aliData?.result?.resultList ||
      aliData?.data?.items ||
      aliData?.items ||
      [];

    const providerStatus = aliData?.result?.status || null;

    const out = {
      status: aliResp.status,
      url: aliUrl,
      providerStatus,
      raw_head: aliText.slice(0, 200),
      items: Array.isArray(items) ? items : []
    };

    cacheSet(ALI_CACHE, aliCacheKey, out, 6 * 60 * 60 * 1000); // 6 hours
    return out;
  }

  async function fetchEbayAvgSold(keywords) {
    const cached = cacheGet(EBAY_CACHE, keywords);
    if (cached) return cached;

    if (ebayCalls >= ebayBudget) {
      return { avgPrice: 0, link: "https://www.ebay.com", budgetExceeded: true };
    }
    ebayCalls++;

    const resp = await fetch(`https://${RAPIDAPI_HOST_EBAY}/findCompletedItems`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST_EBAY
      },
      body: JSON.stringify({
        keywords,
        max_search_results: 30,
        site_id: "0"
      })
    });

    if (!resp.ok) {
      const data = { avgPrice: 0, link: "https://www.ebay.com", httpStatus: resp.status };
      cacheSet(EBAY_CACHE, keywords, data, 30 * 60 * 1000);
      return data;
    }

    const ebayData = await resp.json();
    const avgPrice = parseFloat(
      ebayData?.average_price ||
      ebayData?.avg_price ||
      ebayData?.data?.average_price ||
      "0"
    );

    const data = {
      avgPrice: Number.isFinite(avgPrice) ? avgPrice : 0,
      link: ebayData?.search_url || "https://www.ebay.com"
    };

    cacheSet(EBAY_CACHE, keywords, data, 24 * 60 * 60 * 1000);
    return data;
  }

  try {
    const aliAll = [];
    const aliDebug = [];

    for (const seed of SEEDS.slice(0, aliCallCap)) {
      const r = await fetchAliItems(seed, 1);
      if (r.budgetExceeded) break;

      aliDebug.push({
        seed,
        status: r.status,
        url: r.url,
        items_count: r.items.length,
        provider_status_code: r.providerStatus?.code,
        provider_status_data: r.providerStatus?.data,
        raw_head: r.raw_head
      });

      for (const it of r.items.slice(0, perSeedAliItems)) aliAll.push(it);
    }

    // De-dupe by id -> link -> title|price
    const seen = new Set();
    const aliUnique = [];
    for (const it of aliAll) {
      const id = aliExtractId(it);
      const title = aliExtractTitle(it);
      const price = aliExtractPrice(it);
      const link = aliExtractLink(it);
      const key = id || link || `${title}|${price}`;
      if (!key || !String(key).trim()) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      aliUnique.push(it);
    }

    const candidates = aliUnique.slice(0, Math.max(ebayBudget * 2, 12));

    const results = [];
    let aliZeroPriceCount = 0;
    let ebayZeroCount = 0;
    let ebayBudgetExceededCount = 0;

    for (const item of candidates) {
      const title = aliExtractTitle(item);
      const aliPrice = aliExtractPrice(item);
      const aliLink = aliExtractLink(item);

      if (!title || !aliLink) continue;
      if (!aliPrice) { aliZeroPriceCount++; continue; }

      const ebayKeywords = title.split(/\s+/).slice(0, 6).join(" ");
      const ebay = await fetchEbayAvgSold(ebayKeywords);

      if (ebay.budgetExceeded) {
        ebayBudgetExceededCount++;
        break;
      }

      if (!ebay.avgPrice) {
        ebayZeroCount++;
        continue;
      }

      results.push({
        title,
        aliexpress: { price: aliPrice, link: aliLink },
        ebay: { price: ebay.avgPrice, link: ebay.link },
        profit: ebay.avgPrice - aliPrice
      });
    }

    results.sort((a, b) => b.profit - a.profit);
    const filtered = results.filter((r) => r.profit > minProfit).slice(0, top);

    const payload = debug
      ? {
          debug: {
            seeds_used: SEEDS.slice(0, aliCallCap),
            aliDebug,
            ali_total_fetched: aliAll.length,
            ali_unique: aliUnique.length,
            ali_calls_used: aliCalls,
            ali_call_cap: aliCallCap,
            ebay_calls_used: ebayCalls,
            ebay_budget: ebayBudget,
            ebay_budget_exceeded_count: ebayBudgetExceededCount,
            ali_zero_price_count: aliZeroPriceCount,
            ebay_zero_avg_count: ebayZeroCount,
            results_total: results.length,
            profitable_count: filtered.length,
            ali_parsed_sample: candidates.slice(0, 3).map((it) => ({
              id: aliExtractId(it),
              title: aliExtractTitle(it),
              price: aliExtractPrice(it),
              link: aliExtractLink(it)
            }))
          },
          items: filtered
        }
      : { items: filtered };

    res.setHeader("X-eBay-Calls", String(ebayCalls));
    res.setHeader("X-AliExpress-Calls", String(aliCalls));

    cacheSet(RESPONSE_CACHE, cacheKey, payload, 30 * 60 * 1000);
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: "Backend error", details: String(e) });
  }
}
