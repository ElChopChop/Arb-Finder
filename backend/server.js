import express from "express";
health_beauty: "beauty device",
home_garden: "home gadget"
};


app.get("/arbitrage", async (req, res) => {
const { category } = req.query;
if (!CATEGORY_KEYWORDS[category]) {
return res.status(400).json({ error: "Invalid category" });
}


try {
// 1. Fetch AliExpress products
const aliRes = await fetch(
`https://aliexpress-datahub.p.rapidapi.com/item_search?q=${encodeURIComponent(CATEGORY_KEYWORDS[category])}&page=1`,
{
headers: {
"X-RapidAPI-Key": RAPIDAPI_KEY,
"X-RapidAPI-Host": "aliexpress-datahub.p.rapidapi.com"
}
}
);


const aliJson = await aliRes.json();
const products = aliJson?.result?.items || [];


const results = [];


for (const p of products.slice(0, 10)) {
const title = p.title;
const aliPrice = parseFloat(p.price?.current || 0);
if (!aliPrice) continue;


// 2. Fetch eBay sold prices
const ebayRes = await fetch(
"https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems",
{
method: "POST",
headers: {
"Content-Type": "application/json",
"X-RapidAPI-Key": RAPIDAPI_KEY,
"X-RapidAPI-Host": "ebay-average-selling-price.p.rapidapi.com"
},
body: JSON.stringify({
keywords: title,
max_search_results: 20,
site_id: "0"
})
}
);


const ebayJson = await ebayRes.json();
const avgPrice = parseFloat(ebayJson?.average_price || 0);


if (avgPrice > aliPrice) {
results.push({
title,
aliexpress: {
price: aliPrice,
link: p.product_url
},
ebay: {
price: avgPrice,
link: ebayJson?.search_url || "https://www.ebay.com"
},
profit: avgPrice - aliPrice
});
}
}


results.sort((a, b) => b.profit - a.profit);
res.json({ items: results });


} catch (err) {
console.error(err);
res.status(500).json({ error: "Failed to fetch arbitrage data" });
}
});


app.listen(3000, () => console.log("Backend running on http://localhost:3000"));