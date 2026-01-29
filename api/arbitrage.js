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

  const top = Math.min(parseInt(req.query.top || "50", 10) || 50, 200);
  const debug = req.query.debug === "1";

  const SEEDS = [
    "bluetooth earbuds",
    "smart watch",
    "usb c hub",
    "wireless charger",
    "mini projector",
    "dash cam",
    "obd2 scanner",
    "car phone holder",
  ];

  async function fetchAliItems(query, page = 1) {
    // IMPORTANT: use item_search_2 + sort=default (RapidAPI examples use this) :contentReference[oaicite:1]{index=1}
    const aliUrl =
      `https://${RAPIDAPI_HOST_ALI}/item_search_2` +
      `?q=${encodeURIComponent(query)}` +
      `&page=${page}` +
      `&sort=default`;

    const aliResp = await fetch(aliUrl, {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST_ALI,
      },
    });

    const aliText = await aliResp.text();
    let aliData;
    try {
      aliData = JSON.parse(aliText);
    } catch {
      aliData = null;
    }

    // Be flexible: APIs sometimes change field names
    const items =
      aliData?.result?.items ||
      aliData?.result?.resultList ||
      aliData?.data?.items ||
      aliData?.items ||
      [];

    return { status: aliResp.status, url: aliUrl, rawText: aliText, items };
  }

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
        site_id: "0",
      }),
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
      link: ebayData?.search_url || "https://www.ebay.com",
      raw: ebayData,
    };
  }

  try {
    const aliAll = [];
    const aliDebug = [];

    for (const seed of SEEDS) {
      const { status, url, rawText, items } = await fetchAliItems(seed, 1);

      aliDebug.push({
        seed,
        status,
        url,
        items_count: Array.isArray(items) ? items.length : 0,
        // keep debug small; first 200 chars only
        raw_head: rawText?.slice(0, 200),
      });

      if (Array.isArray(items)) {
        for (const it of items.slice(0, 15)) aliAll.push(it);
      }
    }

    // De-dupe by URL/title
    const seen = new Set();
    const aliUnique = [];
    for (const it of aliAll) {
      const key = it?.product_url || it?.productUrl || it?.itemUrl || it?.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      aliUnique.push(it);
    }

    const checkCap = 40;
    const candidates = aliUnique.slice(0, checkCap);

    const results = [];
    let ebayZeroCount = 0;

    for (const item of candidates) {
      const title = item?.title || item?.product_title || item?.name;
      const aliPrice = parseFloat(
        item?.price?.current ||
          item?.price?.min ||
          item?.price?.value ||
          item?.price ||
          "0"
      );
      const aliLink = item?.product_url || item?.productUrl || item?.itemUrl;

      if (!title || !aliPrice || !aliLink) continue;

      const ebayKeywords = title.split(" ").slice(0, 6).join(" ");
      const { avgPrice, link: ebayLink } = await fetchEbayAvgSold(ebayKeywords);

      if (!avgPrice) {
        ebayZeroCount++;
        continue;
      }

      results.push({
        title,
        aliexpress: { price: aliPrice, link: aliLink },
        ebay: { price: avgPrice, link: ebayLink },
        profit: avgPrice - aliPrice,
      });
    }

    results.sort((a, b) => b.profit - a.profit);
    const profitable = results.filter((x) => x.profit > 0).slice(0, top);

    if (debug) {
      return res.status(200).json({
        debug: {
          aliDebug,
          ali_total_fetched: aliAll.length,
          ali_unique: aliUnique.length,
          ebay_checked: candidates.length,
          ebay_zero_avg_count: ebayZeroCount,
          results_total: results.length,
          profitable_count: profitable.length,
        },
        items: profitable,
      });
    }

    return res.status(200).json({ items: profitable });
  } catch (e) {
    return res.status(500).json({ error: "Backend error", details: String(e) });
  }
}
