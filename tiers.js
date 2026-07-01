// Admin-managed subscription tiers (plans). Everything about pricing is DATA, editable from /admin —
// names, prices, features, order, and enable/disable — with no code changes. Stored in data/tiers.json.
//
// Stripe prices are immutable, so when an admin changes a tier's price/period we create a NEW Stripe
// price on the tier's product and point the tier at it (ensureStripePrices). "Turn tiers off" = leave a
// single tier enabled (the site then renders one plan instead of a grid).
const fs = require("fs");
const path = require("path");
const stripe = require("./stripe");

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA, "tiers.json");

const DEFAULTS = {
    currency: "$", cta: "Subscribe now",
    fineprint: "7-day grace period included with every install. Cancel anytime.",
    tiers: [
        { id: "basic", name: "Basic", price: 9, period: "month", popular: false, enabled: true,
          features: ["1 PC", "Files, folders & database backups", "Smart schedules", "Email pass/fail alerts", "Automatic updates"] },
        { id: "pro", name: "Pro", price: 19, period: "month", popular: true, enabled: true,
          features: ["Up to 5 PCs on your network", "Everything in Basic", "Bootable disk images + incrementals", "Website backups", "Priority email support"] },
        { id: "business", name: "Business", price: 39, period: "month", popular: false, enabled: true,
          features: ["Unlimited PCs & agents", "Everything in Pro", "Advanced retention (GFS)", "Priority support with faster SLA"] }
    ]
};

function loadRaw() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return null; } }
function save(o) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o, null, 2)); } catch (e) {} }
function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || ("tier" + Math.floor(Date.now() / 1000)); }

// First run: seed from DEFAULTS, and back the Pro tier with the existing single Stripe price if one exists.
function config() {
    let c = loadRaw();
    if (!c) {
        c = JSON.parse(JSON.stringify(DEFAULTS));
        const sp = stripe.cfg().priceId;
        if (sp) { const pro = c.tiers.find(t => t.id === "pro"); if (pro) { pro.stripePriceId = sp; pro.stripePriceAmount = 1900; pro.stripePricePeriod = "month"; } }
        save(c);
    }
    if (!Array.isArray(c.tiers)) c.tiers = [];
    return c;
}

// Ensure every enabled tier has a current Stripe price (create product/price when new or price changed).
async function ensureStripePrices(c) {
    if (!stripe.configured()) return c;
    for (const t of c.tiers) {
        if (!t.enabled) continue;
        const amount = Math.round(Number(t.price) * 100);
        if (!(amount > 0)) continue;
        if (t.stripePriceId && t.stripePriceAmount === amount && t.stripePricePeriod === (t.period || "month")) continue;
        if (!t.stripeProductId) { const p = await stripe.createProduct("HayBackup — " + t.name); t.stripeProductId = p.id; }
        const price = await stripe.createPrice({ productId: t.stripeProductId, amount: Number(t.price), interval: t.period || "month", currency: "usd" });
        t.stripePriceId = price.id; t.stripePriceAmount = amount; t.stripePricePeriod = t.period || "month";
    }
    return c;
}

// What the public website sees (enabled tiers only, no Stripe internals except the price id for checkout).
function publicConfig() {
    const c = config();
    return {
        currency: c.currency || "$", cta: c.cta || "Subscribe now", fineprint: c.fineprint || "",
        tiers: c.tiers.filter(t => t.enabled).map(t => ({
            id: t.id, name: t.name, price: t.price, period: t.period || "month",
            features: t.features || [], popular: !!t.popular, priceId: t.stripePriceId || "", ready: !!t.stripePriceId
        }))
    };
}

function getTier(id) { return config().tiers.find(t => t.id === id) || null; }

// Full config for the admin (includes Stripe status per tier).
function adminConfig() {
    const c = config();
    return {
        currency: c.currency || "$", cta: c.cta || "", fineprint: c.fineprint || "",
        tiers: c.tiers.map(t => ({ id: t.id, name: t.name, price: t.price, period: t.period || "month",
            features: t.features || [], popular: !!t.popular, enabled: t.enabled !== false,
            hasStripePrice: !!t.stripePriceId, stripePriceId: t.stripePriceId || "" }))
    };
}

// Save an edited config from the admin, then sync Stripe prices. Returns { ok, config, warning? }.
async function saveConfig(input) {
    const c = config();
    if (typeof input.currency === "string" && input.currency.trim()) c.currency = input.currency.trim();
    if (typeof input.cta === "string") c.cta = input.cta;
    if (typeof input.fineprint === "string") c.fineprint = input.fineprint;
    const incoming = Array.isArray(input.tiers) ? input.tiers : [];
    c.tiers = incoming.map(t => {
        const id = t.id && String(t.id).trim() ? String(t.id).trim() : slug(t.name);
        const ex = c.tiers.find(x => x.id === id) || {};
        const feats = Array.isArray(t.features) ? t.features : String(t.features || "").split(/\r?\n/);
        return {
            id, name: String(t.name || "Plan").trim(), price: Number(t.price) || 0, period: t.period === "year" ? "year" : "month",
            features: feats.map(s => String(s).trim()).filter(Boolean), popular: !!t.popular, enabled: t.enabled !== false,
            stripeProductId: ex.stripeProductId, stripePriceId: ex.stripePriceId, stripePriceAmount: ex.stripePriceAmount, stripePricePeriod: ex.stripePricePeriod
        };
    });
    let warning = "";
    try { await ensureStripePrices(c); } catch (e) { warning = "Saved, but a Stripe price couldn't be created: " + e.message; }
    save(c);
    return { ok: true, config: adminConfig(), warning };
}

module.exports = { config, publicConfig, adminConfig, saveConfig, getTier, ensureStripePrices };
