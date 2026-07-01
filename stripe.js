// Stripe Checkout (subscriptions) — zero dependency: talks to the Stripe REST API over Node's https,
// and verifies webhook signatures with built-in crypto. No `stripe` npm package needed.
//
// Config (set in Admin → Payments): data/stripe-config.json
//   { secretKey: "sk_...", priceId: "price_...", webhookSecret: "whsec_..." }
// Paid subscribers + issued license keys: data/subscribers.json
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const CFG = path.join(DATA, "stripe-config.json");
// Pin a stable Stripe API version — this account defaults to a newer version where some request
// params differ (e.g. promotion_codes rejects `coupon`). Pinning keeps our request shapes valid.
const STRIPE_VERSION = "2023-10-16";
const SUBS = path.join(DATA, "subscribers.json");

// Config from env vars (Railway/12-factor secrets) first, then data/stripe-config.json (admin UI).
function cfg() {
    let f = {}; try { f = JSON.parse(fs.readFileSync(CFG, "utf8")); } catch (e) {}
    return {
        secretKey: process.env.STRIPE_SECRET_KEY || f.secretKey || "",
        priceId: process.env.STRIPE_PRICE_ID || f.priceId || "",
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || f.webhookSecret || ""
    };
}
function saveCfg(c) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); } catch (e) {} }
function configured() { const c = cfg(); return !!(c.secretKey && c.priceId); }

function subs() { try { return JSON.parse(fs.readFileSync(SUBS, "utf8")); } catch { return []; } }
function saveSubs(a) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SUBS, JSON.stringify(a, null, 2)); } catch (e) {} }

// Mark that we've emailed this license key (so the webhook doesn't re-send on retries/duplicate events).
function markEmailed(licenseKey) {
    const list = subs(); const rec = list.find(x => x.licenseKey === licenseKey);
    if (rec) { rec.emailedKeyAt = new Date().toISOString(); saveSubs(list); }
}

function generateLicenseKey() {
    const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
    return "HB-" + seg() + "-" + seg() + "-" + seg() + "-" + seg();
}

// POST x-www-form-urlencoded to Stripe with the secret key.
function stripePost(apiPath, body, key) {
    return new Promise((resolve, reject) => {
        const req = https.request({ host: "api.stripe.com", path: apiPath, method: "POST", timeout: 20000,
            headers: { "Authorization": "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body), "Stripe-Version": STRIPE_VERSION } },
            res => { let d = ""; res.on("data", x => d += x); res.on("end", () => { let j = {}; try { j = JSON.parse(d); } catch (e) {} (res.statusCode >= 200 && res.statusCode < 300) ? resolve(j) : reject(new Error((j.error && j.error.message) || ("Stripe HTTP " + res.statusCode))); }); });
        req.on("timeout", () => req.destroy(new Error("Stripe request timed out")));
        req.on("error", reject);
        req.end(body);
    });
}

// GET from Stripe with the secret key (for retrieving sessions/subscriptions).
function stripeGet(apiPath, key) {
    return new Promise((resolve, reject) => {
        const req = https.request({ host: "api.stripe.com", path: apiPath, method: "GET", timeout: 20000,
            headers: { "Authorization": "Bearer " + key, "Stripe-Version": STRIPE_VERSION } },
            res => { let d = ""; res.on("data", x => d += x); res.on("end", () => { let j = {}; try { j = JSON.parse(d); } catch (e) {} (res.statusCode >= 200 && res.statusCode < 300) ? resolve(j) : reject(new Error((j.error && j.error.message) || ("Stripe HTTP " + res.statusCode))); }); });
        req.on("timeout", () => req.destroy(new Error("Stripe request timed out")));
        req.on("error", reject);
        req.end();
    });
}

// Create a hosted Checkout Session for the subscription price; returns the session (with .url to redirect to).
function createCheckoutSession({ email, successUrl, cancelUrl, priceId }) {
    const c = cfg();
    const params = [
        "mode=subscription",
        "line_items[0][price]=" + encodeURIComponent(priceId || c.priceId),
        "line_items[0][quantity]=1",
        "success_url=" + encodeURIComponent(successUrl),
        "cancel_url=" + encodeURIComponent(cancelUrl),
        "allow_promotion_codes=true",
        "billing_address_collection=auto"
    ];
    if (email) params.push("customer_email=" + encodeURIComponent(email));
    return stripePost("/v1/checkout/sessions", params.join("&"), c.secretKey);
}

// Retrieve a completed Checkout Session and make sure a subscriber/license record exists for it.
// Race-proof: the success page can call this even before the webhook lands, so the buyer always
// gets their key. Returns the subscriber record (with .licenseKey) or null if the session isn't paid.
async function ensureSubscriberForSession(sessionId) {
    const s = await getCheckoutSession(sessionId);
    if (!s || !s.id) return null;
    if (s.payment_status && s.payment_status === "unpaid" && s.status !== "complete") return null;
    const email = (s.customer_details && s.customer_details.email) || s.customer_email || "";
    const list = subs();
    let rec = (s.subscription && list.find(x => x.subscriptionId === s.subscription))
           || (email && list.find(x => x.email && x.email.toLowerCase() === email.toLowerCase())) || null;
    if (!rec) { rec = { email, createdAt: new Date().toISOString() }; list.push(rec); }
    if (!rec.licenseKey) rec.licenseKey = generateLicenseKey();
    if (email && !rec.email) rec.email = email;
    rec.customerId = s.customer || rec.customerId;
    rec.subscriptionId = s.subscription || rec.subscriptionId;
    rec.status = rec.status || "active";
    saveSubs(list);
    return rec;
}
function getCheckoutSession(id) { return stripeGet("/v1/checkout/sessions/" + encodeURIComponent(id), cfg().secretKey); }

// Validate a license key for the desktop app. Looks the key up, checks the LIVE Stripe subscription
// state, and returns { valid, plan, status, expiresAt, message } — the shape desktop license.js expects.
async function licenseForKey(key) {
    key = String(key || "").trim();
    if (!key) return { valid: false, message: "No license key entered yet." };
    const list = subs();
    const rec = list.find(x => x.licenseKey && x.licenseKey.toUpperCase() === key.toUpperCase());
    if (!rec) return { valid: false, message: "License key not recognized. Check the key from your purchase confirmation." };
    // Comped/gifted license: authoritative on our side (no Stripe subscription to consult).
    if (rec.comp) {
        const exp = rec.currentPeriodEnd ? new Date(rec.currentPeriodEnd).getTime() : (Date.now() + 3650 * 86400 * 1000);
        const ok = exp > Date.now();
        return { valid: ok, plan: rec.plan || "Pro", status: ok ? "active" : "expired", expiresAt: new Date(exp).toISOString(),
                 message: ok ? "Complimentary license — active." : "Complimentary license has expired." };
    }
    let status = rec.status || "active", expiresAt = rec.currentPeriodEnd || null;
    if (rec.subscriptionId && cfg().secretKey) {
        try {
            const sub = await stripeGet("/v1/subscriptions/" + encodeURIComponent(rec.subscriptionId), cfg().secretKey);
            if (sub && sub.status) {
                status = sub.status;
                if (sub.current_period_end) expiresAt = new Date(sub.current_period_end * 1000).toISOString();
                rec.status = status; rec.currentPeriodEnd = expiresAt; saveSubs(list);
            }
        } catch (e) { /* Stripe unreachable -> fall back to the cached record status */ }
    }
    const active = (status === "active" || status === "trialing");
    if (active && !expiresAt) expiresAt = new Date(Date.now() + 31 * 86400 * 1000).toISOString(); // safety window until a sub.* webhook sets the real period end
    return { valid: active, plan: "Pro", status, expiresAt,
             message: active ? "Subscription active — thanks for using HayBackup." : ("Subscription is " + status + ". Renew to keep updates & support.") };
}

// ---- Products & prices (for admin-managed tiers). Prices are immutable in Stripe, so changing a
// tier's price = creating a NEW price on the same product and pointing the tier at it. ----
function createProduct(name) { return stripePost("/v1/products", "name=" + encodeURIComponent(name), cfg().secretKey); }
function createPrice(o) {
    const p = ["unit_amount=" + Math.round(Number(o.amount) * 100), "currency=" + (o.currency || "usd"),
               "recurring[interval]=" + encodeURIComponent(o.interval || "month"), "product=" + encodeURIComponent(o.productId)];
    return stripePost("/v1/prices", p.join("&"), cfg().secretKey);
}

// ---- Coupons & promotion codes (discounts / promotions) ----
// A Coupon defines the discount; a Promotion Code is the customer-facing code that applies it.
function createCoupon(o) {
    const p = [];
    if (o.percentOff) p.push("percent_off=" + encodeURIComponent(o.percentOff));
    else if (o.amountOff) { p.push("amount_off=" + Math.round(Number(o.amountOff) * 100)); p.push("currency=usd"); }
    p.push("duration=" + encodeURIComponent(o.duration || "once"));
    if (o.duration === "repeating" && o.durationInMonths) p.push("duration_in_months=" + encodeURIComponent(o.durationInMonths));
    if (o.name) p.push("name=" + encodeURIComponent(o.name));
    return stripePost("/v1/coupons", p.join("&"), cfg().secretKey);
}
function createPromotionCode(o) {
    const p = ["coupon=" + encodeURIComponent(o.couponId)];
    if (o.code) p.push("code=" + encodeURIComponent(o.code));
    if (o.maxRedemptions) p.push("max_redemptions=" + encodeURIComponent(o.maxRedemptions));
    if (o.expiresAt) p.push("expires_at=" + encodeURIComponent(o.expiresAt));
    return stripePost("/v1/promotion_codes", p.join("&"), cfg().secretKey);
}
function listPromotionCodes() { return stripeGet("/v1/promotion_codes?limit=100", cfg().secretKey); }
function setPromotionCodeActive(id, active) { return stripePost("/v1/promotion_codes/" + encodeURIComponent(id), "active=" + (active ? "true" : "false"), cfg().secretKey); }
// Create a coupon and a promotion code for it in one step. Returns the promotion code object.
async function createDiscount(o) {
    const coupon = await createCoupon(o);
    return createPromotionCode({ couponId: coupon.id, code: o.code, maxRedemptions: o.maxRedemptions, expiresAt: o.expiresAt });
}

// Cancel a subscription (immediately, or at period end).
function cancelSubscription(subId, atPeriodEnd) {
    if (atPeriodEnd) return stripePost("/v1/subscriptions/" + encodeURIComponent(subId), "cancel_at_period_end=true", cfg().secretKey);
    return new Promise((resolve, reject) => {
        const req = https.request({ host: "api.stripe.com", path: "/v1/subscriptions/" + encodeURIComponent(subId), method: "DELETE", timeout: 20000,
            headers: { "Authorization": "Bearer " + cfg().secretKey, "Stripe-Version": STRIPE_VERSION } },
            res => { let d = ""; res.on("data", x => d += x); res.on("end", () => { let j = {}; try { j = JSON.parse(d); } catch (e) {} (res.statusCode >= 200 && res.statusCode < 300) ? resolve(j) : reject(new Error((j.error && j.error.message) || ("Stripe HTTP " + res.statusCode))); }); });
        req.on("timeout", () => req.destroy(new Error("Stripe request timed out"))); req.on("error", reject); req.end();
    });
}

// Verify a Stripe webhook signature (Stripe-Signature: "t=...,v1=..."). Needs the RAW request body.
function verifyWebhook(rawBody, sigHeader, secret) {
    try {
        const map = {};
        String(sigHeader || "").split(",").forEach(kv => { const i = kv.indexOf("="); if (i > 0) map[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
        if (!map.t || !map.v1) return false;
        const expected = crypto.createHmac("sha256", secret).update(map.t + "." + rawBody).digest("hex");
        const a = Buffer.from(expected), b = Buffer.from(map.v1);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) { return false; }
}

// Apply a webhook event to the subscriber/license records. Returns the affected record (if any).
function recordEvent(event) {
    const list = subs();
    if (event.type === "checkout.session.completed") {
        const s = event.data.object || {};
        const email = (s.customer_details && s.customer_details.email) || s.customer_email || "";
        let rec = email ? list.find(x => x.email && x.email.toLowerCase() === email.toLowerCase()) : null;
        if (!rec) { rec = { email, createdAt: new Date().toISOString() }; list.push(rec); }
        if (!rec.licenseKey) rec.licenseKey = generateLicenseKey();   // issue a key even if the account pre-existed (registered-then-bought)
        rec.customerId = s.customer || rec.customerId;
        rec.subscriptionId = s.subscription || rec.subscriptionId;
        rec.status = "active";
        saveSubs(list);
        return rec;
    }
    if (event.type && event.type.indexOf("customer.subscription.") === 0) {
        const sub = event.data.object || {};
        const rec = list.find(x => x.subscriptionId === sub.id) || list.find(x => x.customerId === sub.customer);
        if (rec) {
            rec.status = sub.status || rec.status;
            if (sub.current_period_end) rec.currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
            saveSubs(list);
        }
        return rec || null;
    }
    return null;
}

module.exports = { cfg, saveCfg, configured, subs, createCheckoutSession, getCheckoutSession, ensureSubscriberForSession, licenseForKey, verifyWebhook, recordEvent, markEmailed, generateLicenseKey, createCoupon, createPromotionCode, listPromotionCodes, setPromotionCodeActive, createDiscount, cancelSubscription, createProduct, createPrice };
