import express from "express";
import fetch from "node-fetch";
const app = express();

// IMPORTANT: secure your keys with env vars
const ALI_EXPRESS_APP_KEY = process.env.ALI_EXPRESS_APP_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;

app.get("/arbitrage", async (req, res) => {
  const { category } = req.query;
  if (!category) return res.status(400).send("Category required.");

  // 1. Fetch AliExpress products
  const aliRes = await fetch(`https://api.aliexpress.com/products?appKey=${ALI_EXPRESS_APP_KEY}&category=${category}`);
  const aliJson = await aliRes.json();

  // 2. For each product, find recent eBay sold prices
  const results = [];

  for (let prod of aliJson.products.slice(0, 20)) {
    const q = encodeURIComponent(prod.title);

    const ebayRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&filter=priceCurrency:USD,condition:NEW,hasSoldItems:true`, {
      headers: {
        "Authorization": `Bearer ${EBAY_APP_ID}`
      }
    });

    const ebayJson = await ebayRes.json();

    if (ebayJson.itemSummaries?.length) {
      const sold = ebayJson.itemSummaries[0];

      const profit = sold.price.value - prod.price;

      results.push({
        title: prod.title,
        aliexpress: {
          price: prod.price,
          link: prod.productUrl
        },
        ebay: {
          price: sold.price.value,
          link: sold.itemWebUrl
        },
        profit
      });
    }
  }

  // Sort descending by potential profit
  results.sort((a, b) => b.profit - a.profit);

  res.json({ items: results });
});

app.listen(process.env.PORT || 3000);
