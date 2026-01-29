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

  // Keep seed count small to reduce timeouts / quota burn
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
      ...CATEGORY_SEEDS.health_beauty.slice(0, 2),
      ...CATEGORY_SEEDS.home_garden.slice(0, 2),
      "bike light"
    ];

  const maxSeeds = Math.min(SEEDS.length, parseInt(req.query.seeds || "6", 10) || 6);
  const perSeedAliItems = Math.min(parseInt(req.query.perSeed || "15", 10) || 15, 30);
  const checkCap = Math.min(parseInt(req.query.check || "35", 10) || 35, 100);
  const minProfit = Number.isFinite(parseFloat(req.query.minProfit))
    ? parseFloat(req.query.minProfit)
    : 0;

  // ----------------------------
  // Deep helpers (AliExpress payload varies a lot)
  // ----------------------------
  function deepFindFirst(obj, predicate, maxNodes = 4000) {
    // Iterative DFS to avoid recursion limits
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
    // Find first occurrence of any key name (case-insensitive)
    const keySet = new Set(keys.map((k) => k.toLowerCase()));
    const found = deepFindFirst(obj, (x) => {
      if (!x || typeof x !== "object" || Array.isArray(x)) return false;
      for (const k of Object.keys(x)) {
        if (keySet.has(k.toLowerCase())) return true;
      }
      return false;
    });
    if (!found) return null;

    for (const k of Object.keys(found)) {
      if (keySet.has(k.toLowerCase())) return found[k];
    }
    return null;
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
    // Prefer a real AliExpress item URL if present anywhere
    const urlLike = deepFindFirst(item, (x) => typeof x === "string" && x.includes("aliexpress.com"));
    const s = typeof urlLike === "string" ? urlLike : "";

    // If we found any AE url, try to pick the /item/ style link if possible
    if (s) {
      const maybeItem = deepFindFirst(item, (x) =>
        typeof x === "string" && /aliexpress\.com\/item\//i.test(x)
      );
      const picked = typeof maybeItem === "string" ? maybeItem : s;
      return picked.trim();
    }

    // Fallback to common keys
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

    return typeof v === "string" ? v.trim() : String(v || "").trim();
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

  function aliExtractPrice(item) {
    // Try common numeric-ish fields first
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
        "original_price"
      ]) || "";

    if (typeof v === "number") return v;

    // If it's an object (like {current: "12.34"}), try another pass
    if (v && typeof v === "object") {
      const inner = deepGetByKey(v, ["current", "value", "min", "max", "price"]) || "";
      if (typeof inner === "number") return inner;
      const m2 = String(inner).match(/(\d+(\.\d+)?)/);
      return m2 ? parseFloat(m2[1]) : 0;
    }

    const m = String(v).match(/(\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
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

    return {
      status: aliResp.status,
      url: aliUrl,
      rawText: aliText,
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
      const { status, url, rawText, items } = await fetchAliItems(seed, 1);

      aliDebug.push({
        seed,
        status,
        url,
        items_count: items.length,
        raw_head: rawText?.slice(0, 200)
      });

      // Only add a slice to control quota
      for (const it of items.slice(0, perSeedAliItems)) aliAll.push(it);
    }

    // De-dupe: prefer item id, then URL, then title|price
    const seen = new Set();
    const aliUnique = [];
    for (const it of aliAll) {
      const id = aliExtractId(it);
      const title = aliExtractTitle(it);
      const link = aliExtractLink(it);
      const price = aliExtractPrice(it);

      const key = id || link || `${title}|${price}`;
      if (!key || !String(key).trim()) continue;

      if (seen.has(key)) continue;
      seen.add(key);
      aliUnique.push(it);
    }

    const candidates = aliUnique.slice(0, checkCap);

    const results = [];
    let ebayZeroCount = 0;

    for (const item of candidates) {
      const title = aliExtractTitle(item);
      const aliPrice = aliExtractPrice(item);
      const aliLink = aliExtractLink(item);

      if (!title || !aliPrice || !aliLink) continue;

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
      // include a tiny sample of parsed fields to confirm extraction is working
      const sample = candidates.slice(0, 2).map((it) => ({
        id: aliExtractId(it),
        title: aliExtractTitle(it),
        price: aliExtractPrice(it),
        link: aliExtractLink(it)?.slice(0, 120) || ""
      }));

      return res.status(200).json({
        debug: {
          seeds_used: SEEDS.slice(0, maxSeeds),
          aliDebug,
          ali_total_fetched: aliAll.length,
          ali_unique: aliUnique.length,
          ebay_checked: candidates.length,
          ebay_zero_avg_count: ebayZeroCount,
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
