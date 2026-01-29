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
    const aliUrl =
