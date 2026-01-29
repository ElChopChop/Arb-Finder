export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const RAPIDAPI_HOST_ALI = process.env.RAPIDAPI_HOST_ALI || "aliexpress-datahub.p.rapidapi.com";
  const RAPIDAPI_HOST_EBAY = process.env.RAPIDAPI_HOST_EBAY || "ebay-average-selling-price.p.rapidapi.com";

  if (!RAPIDAPI_KEY) return res.status(500).json({ error: "Missing RAPIDAPI_KEY env var" });

  const top = Math.min(parseInt(req.query.top || "50", 10) || 50, 200); // cap to 200
  const debug = req.query.debug === "1";

  // Optional category mode (still supported)
  const category = req.query.category;

  const CATEGORY_KEYWORDS = {
    electronics: ["bluetooth earbuds", "smart watch", "usb c hub", "wireless charger"],
    automotive: ["car phone holder", "obd2 scanner", "led headlight", "dash cam"],
    health_beauty: ["nail drill", "hair trimmer", "facial cleansing brush", "epilator"],
    home_garden: ["led strip lights", "kitchen gadget", "storage organizer", "shower head"],
  };

  // If category provided, use those seeds; else use a broad set of seeds across categories
  const SEEDS = category && CATEGORY_KEYWORDS[category]
    ? CATEGORY_KEYWORDS[category]
    : [
        // Electronics
        "bluetooth earbuds", "smart watch", "usb c hub", "wireless charger", "mini projector",
        // Automotive
        "dash cam", "obd2 scanner", "car phone holder", "led headlight",
        // Health & Beauty
        "nail drill", "hair trimmer", "facial cleansing brush",
        // Home
        "led strip lights", "shower head", "storage organizer", "kitchen gadget",
        // Misc proven AliExpress movers
        "pet grooming", "bike light", "portable fan"
      ];

  // Helper: fetch AliExpress items for a seed query
  async function fetchAliItems(query, page = 1) {
    const aliUrl = `https://${RAPIDAPI_HOST_ALI}/item_search?q=${encodeURIComponent(query)}&page=${page}`;

    const aliResp = await fetch(aliUrl, {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST_ALI,
      },
    });

    const aliData = await aliResp.json();
    const items = aliData?.result?.items || [];
    return items;
  }

  // Helper: fetch eBay average sold price for a keyword string
  async function fetchEbayAvgSold(keywords) {
    const ebayResp = await fetch(`https://${RAPIDAPI_HOST_EBAY}/findCompletedItems`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST_EBAY,
      },
      body: JSON.stringify({
        keywords,
        max_search_results: 30,
        site_id: "0", // change to "3" for UK if supported by that API
      }),
    });

    const ebayData = await ebayResp.json();

    const avgPrice = parseFloat(
      ebayData?.average_price ||
      ebayData?.avg_price ||
      ebayData?.data?.average_price ||
      "0"
    );

    const link = ebayData?.search_url || "https://www.ebay.com";

    return { avgPrice, link, raw: ebayData };
  }

  try {
    // 1) Pull AliExpress items across seeds (limit to avoid burning quota)
    const aliAll = [];
    for (const seed of SEEDS.slice(0, 8)) { // adjust up if you have quota
      const items = await fetchAliItems(seed, 1);
      for (const it of items.slice(0, 15)) aliAll.push(it);
    }

    // De-dupe by product_url/title
    const seen = new Set();
    const aliUnique = [];
    for (const it of aliAll) {
      const key = it?.product_url || it?.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      aliUnique.push(it);
    }

    // 2) For each AliExpress item, get eBay average sold price (hard cap to protect quota)
    const checkCap = 40; // raise gradually (this is the biggest cost)
    const candidates = aliUnique.slice(0, checkCap);

    const results = [];
    let ebayZeroCount = 0;

    for (const item of candidates) {
      const title = item?.title;
      const aliPrice = parseFloat(item?.price?.current || item?.price?.min || item?.price?.value || "0");
      const aliLink = item?.product_url;

      if (!title || !aliPrice || !aliLink) continue;

      // Improve match: short keyword phrase
      const ebayKeywords = title.split(" ").slice(0, 6).join(" ");

      const { avgPrice, link: ebayLink } = await fetchEbayAvgSold(ebayKeywords);
      if (!avgPrice) { ebayZeroCount++; continue; }

      const profit = avgPrice - aliPrice;

      results.push({
        title,
        aliexpress: { price: aliPrice, link: aliLink },
        ebay: { price: avgPrice, link: ebayLink },
        profit,
      });
    }

    // Sort by profit desc and take top N
    results.sort((a, b) => b.profit - a.profit);

    // Keep only profitable ones
    const profitable = results.filter(r => r.profit > 0).slice(0, top);

    if (debug) {
      return res.status(200).json({
        debug: {
          seeds_used: SEEDS.slice(0, 8),
          ali_total_fetched: aliAll.length,
          ali_unique: aliUnique.length,
          ebay_checked: candidates.length,
          ebay_zero_avg_count: ebayZeroCount,
          results_total: results.length,
          profitable_count: profitable.length
        },
        items: profitable
      });
    }

    return res.status(200).json({ items: profitable });

  } catch (e) {
    return res.status(500).json({ error: "Backend error", details: String(e) });
  }
}
