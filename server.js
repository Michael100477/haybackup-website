// HayBackup — public marketing & purchase site (DEV build) + admin backend.
// Zero dependencies (Node built-ins only) so it runs anywhere and moves to any host with no install step.
// Move-to-production notes are in README-DEPLOY.md.
//
//   PORT=8090 node server.js        (defaults to 8090 — a free port on this dev box)
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const stripe = require("./stripe");
const mailer = require("./mailer");

const PORT = process.env.PORT || 8090;
const HOST = process.env.HOST || "::";   // dual-stack (IPv4+IPv6) so the hostname works even when it resolves to IPv6 first
const PUBLIC = path.join(__dirname, "public");
// Writable runtime state (admin password, pricing, published releases, leads). On Railway the container
// filesystem is EPHEMERAL — set DATA_DIR to a mounted volume path (e.g. /data) so this survives deploys.
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const PRICING_FILE = path.join(DATA, "pricing.json");
const ADMIN_FILE = path.join(DATA, "admin.json");
const RELEASES_DIR = path.join(DATA, "releases");
const RELEASE_FILE = path.join(DATA, "release.json");
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}

const TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain"
};

// ---------- pricing (the thing the admin edits) ----------
const DEFAULT_PRICING = {
    plan: "HayBackup — Pro",
    currency: "$",
    price: 19,
    period: "month",
    features: [
        "Unlimited backup jobs & schedules",
        "Bootable system images + incrementals",
        "File, database & website backups",
        "Back up unlimited PCs on your network",
        "Email alerts on pass/fail",
        "Automatic updates & priority support"
    ],
    cta: "Subscribe now",
    fineprint: "7-day grace period included with every install. No credit card to try."
};
function pricing() { try { return Object.assign({}, DEFAULT_PRICING, JSON.parse(fs.readFileSync(PRICING_FILE, "utf8"))); } catch { return Object.assign({}, DEFAULT_PRICING); } }
function savePricing(p) {
    const cur = pricing();
    const out = {
        plan: typeof p.plan === "string" ? p.plan.slice(0, 80) : cur.plan,
        currency: typeof p.currency === "string" ? p.currency.slice(0, 4) : cur.currency,
        price: (p.price !== undefined && p.price !== "" && !isNaN(Number(p.price))) ? Number(p.price) : cur.price,
        period: typeof p.period === "string" ? p.period.slice(0, 20) : cur.period,
        features: Array.isArray(p.features) ? p.features.map(s => String(s).slice(0, 160)).filter(Boolean).slice(0, 20) : cur.features,
        cta: typeof p.cta === "string" ? p.cta.slice(0, 40) : cur.cta,
        fineprint: typeof p.fineprint === "string" ? p.fineprint.slice(0, 240) : cur.fineprint
    };
    fs.writeFileSync(PRICING_FILE, JSON.stringify(out, null, 2));
    return out;
}

// ---------- admin auth (single password; scrypt; in-memory sessions) ----------
const sessions = new Map();                  // token -> expiry(ms)
const SESSION_MS = 7 * 86400 * 1000;
function adminRec() { try { return JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8")); } catch { return null; } }
function needsSetup() { const a = adminRec(); return !a || !a.hash; }
function setPassword(pw) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ salt, hash, created: new Date().toISOString() }, null, 2));
}
function verifyPw(pw) {
    const a = adminRec(); if (!a) return false;
    const h = crypto.scryptSync(pw, a.salt, 64).toString("hex");
    try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(a.hash)); } catch { return false; }
}
function parseCookies(req) { const o = {}; (req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); return o; }
// Automation token (for unattended publishing/config — no human password needed).
// Set ADMIN_API_TOKEN in the environment; send it as "Authorization: Bearer <token>" or "x-admin-token: <token>".
function tokenAuthed(req) {
    const tok = (process.env.ADMIN_API_TOKEN || "").trim();
    if (!tok) return false;
    let supplied = (req.headers["x-admin-token"] || "").toString().trim();
    if (!supplied) { const m = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] || ""); if (m) supplied = m[1].trim(); }
    if (!supplied) return false;
    try { return supplied.length === tok.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(tok)); } catch { return false; }
}
function isAuthed(req) { if (tokenAuthed(req)) return true; const t = parseCookies(req).haybackup_admin; if (!t) return false; const e = sessions.get(t); if (!e || e < Date.now()) { sessions.delete(t); return false; } return true; }
function setSession(res) { const t = crypto.randomBytes(32).toString("hex"); sessions.set(t, Date.now() + SESSION_MS); res.setHeader("Set-Cookie", `haybackup_admin=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`); }

// ---------- helpers ----------
function send(res, code, body, type) { res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" }); res.end(body); }
function json(res, code, obj) { send(res, code, JSON.stringify(obj), TYPES[".json"]); }
function readBody(req) { return new Promise(resolve => { let d = ""; req.on("data", c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on("end", () => resolve(d)); }); }
async function jsonBody(req) { try { return JSON.parse((await readBody(req)) || "{}"); } catch { return {}; } }
// Public base URL. Behind a TLS-terminating proxy (Railway) the socket is plain HTTP, so trust
// X-Forwarded-Proto/Host to reconstruct the original https:// origin clients actually used.
function baseUrl(req) {
    const xproto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const scheme = xproto || (req.socket.encrypted ? "https" : "http");
    const host = (req.headers["x-forwarded-host"] || req.headers.host || ("localhost:" + PORT)).split(",")[0].trim();
    return scheme + "://" + host;
}

// ---------- releases (the update feed the desktop app checks) ----------
function release() { try { return JSON.parse(fs.readFileSync(RELEASE_FILE, "utf8")); } catch { return null; } }
function sha256File(p) { return new Promise((res, rej) => { const h = crypto.createHash("sha256"); const s = fs.createReadStream(p); s.on("data", d => h.update(d)); s.on("end", () => res(h.digest("hex"))); s.on("error", rej); }); }

function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const full = path.normalize(path.join(PUBLIC, rel));
    if (!full.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
    fs.stat(full, (err, st) => {
        if (err || !st.isFile()) {
            const nf = path.join(PUBLIC, "404.html");
            return fs.readFile(nf, (e2, b2) => e2 ? send(res, 404, "Not found") : send(res, 404, b2, TYPES[".html"]));
        }
        fs.readFile(full, (e3, buf) => e3 ? send(res, 500, "Read error") : send(res, 200, buf, TYPES[path.extname(full).toLowerCase()] || "application/octet-stream"));
    });
}

const handler = async (req, res) => {
    const u = url.parse(req.url, true);
    const p = u.pathname;

    if (p === "/healthz") return json(res, 200, { ok: true, service: "haybackup-website", ts: new Date().toISOString() });

    // ---- public pricing (landing page + checkout read this) ----
    if (p === "/api/pricing" && req.method === "GET") return json(res, 200, { ok: true, pricing: pricing() });

    // ---- checkout interest capture ----
    if (p === "/api/checkout" && req.method === "POST") {
        const body = await jsonBody(req);
        const lead = { ts: new Date().toISOString(), name: String(body.name || "").slice(0, 120), email: String(body.email || "").slice(0, 160), plan: String(body.plan || "").slice(0, 60), note: String(body.note || "").slice(0, 500), ip: req.socket.remoteAddress };
        if (!lead.email || lead.email.indexOf("@") < 0) return json(res, 400, { ok: false, error: "A valid email is required." });
        try { fs.appendFileSync(path.join(DATA, "leads.jsonl"), JSON.stringify(lead) + "\n"); } catch (e) {}
        return json(res, 200, { ok: true, message: "Thanks! We'll be in touch about your subscription." });
    }

    // ---- Stripe Checkout (subscription) ----
    if (p === "/api/checkout/session" && req.method === "POST") {
        if (!stripe.configured()) return json(res, 400, { ok: false, error: "Online payment isn't set up yet." });
        const b = await jsonBody(req);
        const base = baseUrl(req);
        try {
            const s = await stripe.createCheckoutSession({ email: String(b.email || "").trim(), successUrl: base + "/success.html?session_id={CHECKOUT_SESSION_ID}", cancelUrl: base + "/checkout.html" });
            return json(res, 200, { ok: true, url: s.url });
        } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    // After-checkout: the success page calls this with ?session_id=... to show the buyer their license key.
    if (p === "/api/checkout/result" && req.method === "GET") {
        const sid = (u.query.session_id || "").trim();
        if (!sid) return json(res, 400, { ok: false, error: "Missing session_id." });
        if (!stripe.configured()) return json(res, 400, { ok: false, error: "Payments not configured." });
        try {
            const rec = await stripe.ensureSubscriberForSession(sid);
            if (!rec) return json(res, 200, { ok: false, pending: true, error: "Payment not completed yet." });
            return json(res, 200, { ok: true, email: rec.email || "", licenseKey: rec.licenseKey });
        } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    // Stripe webhook (raw body for signature verification). Records paid subscribers + issues a license.
    if (p === "/api/stripe/webhook" && req.method === "POST") {
        const raw = await readBody(req);
        const c = stripe.cfg();
        if (c.webhookSecret && !stripe.verifyWebhook(raw, req.headers["stripe-signature"], c.webhookSecret)) return send(res, 400, "bad signature");
        let event = {}; try { event = JSON.parse(raw); } catch (e) { return send(res, 400, "bad json"); }
        let rec = null; try { rec = stripe.recordEvent(event); } catch (e) {}
        // Email the buyer their license key once, on first completed checkout.
        if (event.type === "checkout.session.completed" && rec && rec.email && rec.licenseKey && !rec.emailedKeyAt && mailer.configured()) {
            mailer.sendLicenseEmail(rec).then(() => stripe.markEmailed(rec.licenseKey)).catch(e => console.error("license email failed:", e.message));
        }
        return json(res, 200, { received: true });
    }

    // ---- LICENSE SERVER: the desktop app GETs <this>?machine=&key= and reads { valid, plan, expiresAt, message }.
    // Validates the key against the live Stripe subscription. Unknown/empty key -> valid:false (no expiresAt),
    // which leaves the app in its install grace period rather than locking anyone out.
    if (p === "/api/license/check") {
        try {
            const key = (u.query.key || "").trim();
            if (!stripe.configured()) return json(res, 200, { valid: false, plan: "Pro", message: "Licensing not configured yet." });
            const r = await stripe.licenseForKey(key);
            return json(res, 200, r);
        } catch (e) { return json(res, 200, { valid: false, message: "License check error: " + e.message }); }
    }

    // ---- UPDATE FEED: the desktop app's "Check for updates" / daily check points here ----
    if (p === "/api/update/latest" && req.method === "GET") {
        const r = release();
        if (!r || !r.version) return json(res, 404, { ok: false, error: "No release published yet." });
        return json(res, 200, { version: r.version, url: baseUrl(req) + "/download/installer", sha256: r.sha256 || null, notes: r.notes || "" });
    }
    if (p === "/download/installer" && (req.method === "GET" || req.method === "HEAD")) {
        const r = release();
        const f = (r && r.file) ? path.join(RELEASES_DIR, r.file) : null;
        if (!f || !fs.existsSync(f)) return send(res, 404, "No installer published.");
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="HayBackup-Setup.exe"', "Content-Length": fs.statSync(f).size });
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(f).pipe(res);
    }

    // ---- admin: publish a release (raw binary PUT of the installer; version+notes in headers) ----
    if (p === "/api/admin/release") {
        if (!isAuthed(req)) return json(res, 401, { ok: false, error: "Not signed in." });
        if (req.method === "GET") return json(res, 200, { ok: true, release: release() });
        if (req.method === "PUT") {
            const version = String(req.headers["x-version"] || "").trim();
            const notes = (() => { try { return decodeURIComponent(String(req.headers["x-notes"] || "")); } catch { return ""; } })();
            if (!version) return json(res, 400, { ok: false, error: "Missing version (x-version header)." });
            fs.mkdirSync(RELEASES_DIR, { recursive: true });
            const tmp = path.join(RELEASES_DIR, "upload-" + Date.now() + ".tmp");
            const ws = fs.createWriteStream(tmp);
            req.pipe(ws);
            ws.on("error", () => json(res, 500, { ok: false, error: "Upload write failed." }));
            ws.on("finish", async () => {
                try {
                    if (fs.statSync(tmp).size < 100000) { fs.unlinkSync(tmp); return json(res, 400, { ok: false, error: "Uploaded file is too small to be an installer." }); }
                    const sha = await sha256File(tmp);
                    const finalPath = path.join(RELEASES_DIR, "HayBackup-Setup.exe");
                    fs.renameSync(tmp, finalPath);
                    const rel = { version, notes, sha256: sha, file: "HayBackup-Setup.exe", publishedAt: new Date().toISOString() };
                    fs.writeFileSync(RELEASE_FILE, JSON.stringify(rel, null, 2));
                    json(res, 200, { ok: true, release: rel });
                } catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} json(res, 500, { ok: false, error: e.message }); }
            });
            return;
        }
    }

    // ---- admin API ----
    if (p === "/api/admin/state" && req.method === "GET") return json(res, 200, { ok: true, needsSetup: needsSetup(), authed: isAuthed(req) });
    if (p === "/api/admin/setup" && req.method === "POST") {
        if (!needsSetup()) return json(res, 400, { ok: false, error: "Admin is already set up." });
        const b = await jsonBody(req); const pw = String(b.password || "");
        if (pw.length < 8) return json(res, 400, { ok: false, error: "Password must be at least 8 characters." });
        setPassword(pw); setSession(res); return json(res, 200, { ok: true });
    }
    if (p === "/api/admin/login" && req.method === "POST") {
        const b = await jsonBody(req);
        if (verifyPw(String(b.password || ""))) { setSession(res); return json(res, 200, { ok: true }); }
        return json(res, 401, { ok: false, error: "Incorrect password." });
    }
    if (p === "/api/admin/logout" && req.method === "POST") {
        const t = parseCookies(req).haybackup_admin; if (t) sessions.delete(t);
        res.setHeader("Set-Cookie", "haybackup_admin=; HttpOnly; Path=/; Max-Age=0"); return json(res, 200, { ok: true });
    }
    if (p === "/api/admin/pricing") {
        if (!isAuthed(req)) return json(res, 401, { ok: false, error: "Not signed in." });
        if (req.method === "GET") return json(res, 200, { ok: true, pricing: pricing() });
        if (req.method === "POST") { const b = await jsonBody(req); return json(res, 200, { ok: true, pricing: savePricing(b) }); }
    }
    if (p === "/api/admin/stripe") {
        if (!isAuthed(req)) return json(res, 401, { ok: false, error: "Not signed in." });
        if (req.method === "GET") { const c = stripe.cfg(); return json(res, 200, { ok: true, config: { priceId: c.priceId, hasSecret: !!c.secretKey, hasWebhook: !!c.webhookSecret }, configured: stripe.configured() }); }
        if (req.method === "POST") {
            const b = await jsonBody(req); const c = stripe.cfg();
            if (typeof b.priceId === "string") c.priceId = b.priceId.trim();
            if (typeof b.secretKey === "string" && b.secretKey.trim()) c.secretKey = b.secretKey.trim();      // keep existing if blank
            if (typeof b.webhookSecret === "string" && b.webhookSecret.trim()) c.webhookSecret = b.webhookSecret.trim();
            stripe.saveCfg(c); return json(res, 200, { ok: true });
        }
    }
    if (p === "/api/admin/subscribers" && req.method === "GET") {
        if (!isAuthed(req)) return json(res, 401, { ok: false, error: "Not signed in." });
        return json(res, 200, { ok: true, subscribers: stripe.subs() });
    }
    if (p === "/api/admin/email") {
        if (!isAuthed(req)) return json(res, 401, { ok: false, error: "Not signed in." });
        if (req.method === "GET") { const c = mailer.cfg(); return json(res, 200, { ok: true, configured: mailer.configured(), config: { from: c.from, fromName: c.fromName, replyTo: c.replyTo, host: c.host, hasToken: !!c.token } }); }
        if (req.method === "POST") {
            const b = await jsonBody(req); const c = mailer.cfg();
            if (typeof b.token === "string" && b.token.trim()) c.token = b.token.trim();   // keep existing if blank
            if (typeof b.from === "string") c.from = b.from.trim();
            if (typeof b.fromName === "string") c.fromName = b.fromName.trim();
            if (typeof b.replyTo === "string") c.replyTo = b.replyTo.trim();
            if (typeof b.host === "string" && b.host.trim()) c.host = b.host.trim();
            mailer.saveCfg(c); return json(res, 200, { ok: true });
        }
    }
    if (p === "/api/admin/email/test" && req.method === "POST") {
        if (!isAuthed(req)) return json(res, 401, { ok: false, error: "Not signed in." });
        const b = await jsonBody(req); const to = String(b.to || "").trim();
        if (!to) return json(res, 400, { ok: false, error: "Provide a 'to' address." });
        try { await mailer.sendLicenseEmail({ email: to, licenseKey: b.key || "HB-TEST-TEST-TEST-TEST" }); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === "/api/admin/email/resend" && req.method === "POST") {
        if (!isAuthed(req)) return json(res, 401, { ok: false, error: "Not signed in." });
        const b = await jsonBody(req); const key = String(b.key || "").trim();
        const rec = stripe.subs().find(x => x.licenseKey && x.licenseKey.toUpperCase() === key.toUpperCase());
        if (!rec || !rec.email) return json(res, 404, { ok: false, error: "No subscriber with that key (or no email on file)." });
        try { await mailer.sendLicenseEmail(rec); stripe.markEmailed(rec.licenseKey); return json(res, 200, { ok: true, sentTo: rec.email }); }
        catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === "/admin") { return serveStatic(req, res, "/admin.html"); }
    if (p === "/buy.html") { return serveStatic(req, res, "/index.html"); }   // the landing page is the buy page

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    serveStatic(req, res, p);
};

// Serve HTTPS when a cert is available (so the hostname works over https with no warning, since this
// cert is already trusted on the dev box); otherwise plain HTTP. Search: ./certs, then cardcloud-local.
function loadTls() {
    const pairs = [
        { key: path.join(__dirname, "certs", "server.key"), cert: path.join(__dirname, "certs", "server.crt") },
        { key: "C:/cardcloud-local/certs/server.key", cert: "C:/cardcloud-local/certs/server.crt" }
    ];
    for (const pr of pairs) { try { if (fs.existsSync(pr.key) && fs.existsSync(pr.cert)) return { key: fs.readFileSync(pr.key), cert: fs.readFileSync(pr.cert) }; } catch (e) {} }
    return null;
}
const tls = loadTls();
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
server.listen(PORT, HOST, () => { console.log(`HayBackup website (dev) running on ${tls ? "https" : "http"}://localhost:${PORT}/  (admin at /admin)`); });
