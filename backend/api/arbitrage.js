export default async function handler(req, res) {
  // CORS (so GitHub Pages can call it)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { category } = req.query;

  const CATEGORY_KEYWORDS = {
    electronics: "electronics gadget",
    automotive: "car accessory",
    health_beauty: "beauty device",
    home_garden: "home gadget",
  };

  if (!category || !CATEGORY_KEYWORDS[category]) {
    return res.status(400).json({ error: "Invalid category" });
  }

  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const RAPIDAPI_HOST_ALI = process.env.RAPIDAPI_HOST_ALI || "aliexpress-datahub.p.rapidapi.com";
  const RAPIDAPI_HOST_EBAY = process.env.RAPIDAPI_HOST_EBAY || "ebay-average-selling-price.p.rapidapi.com";

  try {
    // 1) AliExpress search
    const aliUrl = `https://${RAPIDAPI_HOST_ALI}/item_search?q=${encodeURIComponent(
      CATEGORY_KEYWORDS[category]
    )}&page=1`;

    const aliResp = await fetch(aliUrl, {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST_ALI,
      },
    });

    const aliData = await aliResp.json();
    const items = aliData?.result?.items || [];

    const results = [];

    // 2) For each item, get eBay completed average
    for (const item of items.slice(0, 10)) {
      const title = item?.title;
      const aliPrice = parseFloat(item?.price?.current || item?.price?.min || item?.price?.value || "0");
      if (!title || !aliPrice) continue;

      const ebayResp = await fetch(`https://${RAPIDAPI_HOST_EBAY}/findCompletedItems`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Key": RAPIDAPI_KEY,
          "X-RapidAPI-Host": RAPIDAPI_HOST_EBAY,
        },
        body: JSON.stringify({
          keywords: title.split(" ").slice(0, 6).join(" "), // improves matching
          max_search_results: 20,
          site_id: "0",
        }),
      });

      const ebayData = await ebayResp.json();
      const avgPrice = parseFloat(
        ebayData?.average_price || ebayData?.avg_price || ebayData?.data?.average_price || "0"
      );

      if (!avgPrice) continue;

      const profit = avgPrice - aliPrice;

      results.push({
        title,
        aliexpress: { price: aliPrice, link: item?.product_url },
        ebay: { price: avgPrice, link: ebayData?.search_url || "https://www.ebay.com" },
        profit,
      });
    }

    results.sort((a, b) => b.profit - a.profit);

    // Optional: only show profitable ones
    const profitable = results.filter((x) => x.profit > 0);

    return res.status(200).json({ items: profitable });
  } catch (e) {
    return res.status(500).json({ error: "Backend error", details: String(e) });
  }
}
