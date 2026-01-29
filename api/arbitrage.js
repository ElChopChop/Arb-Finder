// api/arbitrage.js
export default async function handler(req, res) {
  // CORS for GitHub Pages
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const RAPIDAPI_HOST_ALI = process.env.RAPIDAPI_HOST_ALI || "aliexpress-datahub.p.rapidapi.com";
  const RAPIDAPI_HOST_EBAY =
    process.env.RAPIDAPI_HOST_EBAY || "ebay-average-selling-price.p.rapidapi.com";

  if (!RAPIDAPI_KEY) return res.status(500).json({ error: "Missing RAPIDAPI_KEY env var" });

  const top = Math.min(parseInt(req.query.top || "50", 10) || 50, 200);
  const debug = req.query.debug === "1";
  const category = String(req.query.category || "");

  const CATEGORY_SEEDS = {
    electronics: ["bluetooth earbuds", "usb c hub", "wireless charger", "mini projector"],
    automotive: ["dash cam", "car phone holder", "tire inflator"],
    health_beauty: ["hair trimmer", "nail drill", "massage gun"],
    home_garden: ["led strip lights", "handheld vacuum", "storage organizer"]
  };

  const SEEDS =
    CATEGORY_SEEDS[category] ||
    [
      ...CATEGORY_SEEDS.electronics.slice(0, 3),
      ...CATEGORY_SEEDS.automotive.slice(0, 2),
      ...CATEGORY_SEEDS.health_beauty.slice(0, 1),
      "bike light"
    ];

  const maxSeeds = Math.min(SEEDS.length, parseInt(req.query.seeds || "6", 10) || 6);
  const perSeedAliItems = Math.min(parseInt(req.query.perSeed || "15", 10) || 15, 30);
  const checkCap = Math.min(parseInt(req.query.check || "35", 10) || 35, 120);
  const minProfit = Number.isFinite(parseFloat(req.query.minProfit))
    ? parseFloat(req.query.minProfit)
    : 0;

  // ----------------------------
  // Deep helpers (Ali payload varies)
  // ----------------------------
  function deepFindFirst(obj, predicate, maxNodes = 6000) {
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

  function normalizeAliLink(link) {
    if (!link) return "";
    let s = String(link).trim();
    if (s.startsWith("//")) s = "https:" + s;
    if (s.startsWith("www.")) s = "https://" + s;
    return s;
  }

  function aliExtractTitle(item) {
    const v =
      deepGetByKey(item, [
        "title",
        "productTitle",
        "product_title",
        "name",
        "itemTitle",
        "item_title",
        "displayTitle"
      ]) || "";
    return typeof v === "string" ? v.trim() : String(v || "").trim();
  }

  function aliExtractLink(item) {
    const maybeItem = deepFindFirst(item, (x) => typeof x === "string" && /aliexpress\.com\/item\//i.test(x));
    if (typeof maybeItem === "string") return normalizeAliLink(maybeItem);

    const urlLike = deepFindFirst(item, (x) => typeof x === "string" && x.includes("aliexpress.com"));
    if (typeof urlLike === "string") return normalizeAliLink(urlLike);

    const v =
      deepGetByKey(item, [
        "product_url",
        "productUrl",
        "item_url",
        "itemUrl",
        "detail_url",
        "detailUrl",
        "url",
        "itemLink",
        "productLink"
      ]) || "";
    return normalizeAliLink(typeof v === "string" ? v : String(v || ""));
  }

  function aliExtractId(item) {
    const v =
      deepGetByKey(item, [
        "itemId",
        "item_id",
        "productId",
        "product_id",
        "id",
        "offerId",
        "offer_id"
      ]) || "";
    return typeof v === "string" || typeof v === "number" ? String(v) : "";
  }

  function parseFirstNumber(x) {
    const m = String(x).match(/(\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  function aliExtractPrice(item) {
    // 1) Common keys (including "formatted/string" fields many APIs use)
    const v =
      deepGetByKey(item, [
        "current",
        "currentPrice",
        "current_price",
        "salePrice",
        "sale_price",
        "price",
        "minPrice",
        "min_price",
        "maxPrice",
        "max_price",
        "originalPrice",
        "original_price",
        "price_format",
        "priceFormat",
        "price_str",
        "priceStr",
        "sale_price_format",
        "target_price",
        "targetPrice",
        "final_price",
        "finalPrice"
      ]) || "";

    // If numeric, easy
    if (typeof v === "number") return v;

    // If object, try inner numeric-ish value
    if (v && typeof v === "object") {
      const inner =
        deepGetByKey(v, ["current", "value", "min", "max", "price", "amount"]) || "";
      if (typeof inner === "number") return inner;
      const n = parseFirstNumber(inner);
      if (n) return n;
    }

    // If string contains a number, use it
    const n1 = parseFirstNumber(v);
    if (n1) return n1;

    // 2) Fallback: scan the whole object for a plausible price string
    // Look for strings like "$12.34", "US $12.34", "£9.99", "12.34"
    const priceLike = deepFindFirst(item, (x) => {
      if (typeof x !== "string") return false;
      const s = x.trim();
      if (s.length < 2 || s.length > 40) return false;
      // must contain a number
      if (!/\d/.test(s)) return false;
      // avoid things like IDs
      if (/^\d{10,}$/.test(s)) return false;
      // look for currency or common price patterns
      return /(\$|£|€|US\s?\$|GBP|EUR)\s*\d+(\.\d+)?/.test(s) || /^\d+(\.\d+)?$/.test(s);
    });

    if (typeof priceLike === "string") {
      const n2 = parseFirstNumber(priceLike);
      if (n2) return n2;
    }

    return 0;
  }

  // ----------------------------
  // RapidAPI fetchers
  // ----------------------------
  async function fetchAliItems(query, page = 1) {
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
    try {
      aliData = JSON.parse(aliText);
    } catch {
      aliData = null;
    }

    const items =
      aliData?.result?.items ||
      aliData?.result?.resultList ||
      aliData?.data?.items ||
      aliData?.items ||
      [];

    // Also capture provider error status even if HTTP 200
    const providerStatus = aliData?.result?.status || null;

    return {
      status: aliResp.status,
      url: aliUrl,
      rawText: aliText,
      providerStatus,
      items: Array.isArray(items) ? items : []
    };
  }

  async function fetchEbayAvgSold(keywords) {
    const ebayResp = await fetch(`https://${RAPIDAPI_HOST_EBAY}/findCompletedItems`, {
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

    const ebayData = await ebayResp.json();
    const avgPrice = parseFloat(
      ebayData?.average_price ||
        ebayData?.avg_price ||
        ebayData?.data?.average_price ||
        "0"
    );

    return {
      avgPrice,
      link: ebayData?.search_url || "https://www.ebay.com"
    };
  }

  // ----------------------------
  // Main
  // ----------------------------
  try {
    const aliAll = [];
    const aliDebug = [];

    for (const seed of SEEDS.slice(0, maxSeeds)) {
      const { status, url, rawText, providerStatus, items } = await fetchAliItems(seed, 1);

      aliDebug.push({
        seed,
        status,
        url,
        items_count: items.length,
        provider_status_code: providerStatus?.code,
        provider_status_data: providerStatus?.data,
        raw_head: rawText?.slice(0, 200)
      });

      for (const it of items.slice(0, perSeedAliItems)) aliAll.push(it);
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

    const candidates = aliUnique.slice(0, checkCap);

    const results = [];
    let ebayZeroCount = 0;
    let aliZeroPriceCount = 0;

    for (const item of candidates) {
      const title = aliExtractTitle(item);
      const aliPrice = aliExtractPrice(item);
      const aliLink = aliExtractLink(item);

      if (!title || !aliLink) continue;
      if (!aliPrice) { aliZeroPriceCount++; continue; }

      const ebayKeywords = title.split(/\s+/).slice(0, 6).join(" ");
      const { avgPrice, link: ebayLink } = await fetchEbayAvgSold(ebayKeywords);

      if (!avgPrice) {
        ebayZeroCount++;
        continue;
      }

      results.push({
        title,
        aliexpress: { price: aliPrice, link: aliLink },
        ebay: { price: avgPrice, link: ebayLink },
        profit: avgPrice - aliPrice
      });
    }

    results.sort((a, b) => b.profit - a.profit);
    const filtered = results.filter((r) => r.profit > minProfit).slice(0, top);

    if (debug) {
      const sample = candidates.slice(0, 3).map((it) => ({
        id: aliExtractId(it),
        title: aliExtractTitle(it),
        price: aliExtractPrice(it),
        link: aliExtractLink(it)?.slice(0, 140) || ""
      }));

      return res.status(200).json({
        debug: {
          seeds_used: SEEDS.slice(0, maxSeeds),
          aliDebug,
          ali_total_fetched: aliAll.length,
          ali_unique: aliUnique.length,
          ebay_checked: candidates.length,
          ebay_zero_avg_count: ebayZeroCount,
          ali_zero_price_count: aliZeroPriceCount,
          results_total: results.length,
          profitable_count: filtered.length,
          ali_parsed_sample: sample
        },
        items: filtered
      });
    }

    return res.status(200).json({ items: filtered });
  } catch (e) {
    return res.status(500).json({ error: "Backend error", details: String(e) });
  }
}
