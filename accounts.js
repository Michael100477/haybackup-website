// Customer accounts for HayBackup. A "user" = a registered customer; their record lives in the SAME
// data/subscribers.json store as Stripe subscription data, keyed by email, so one record holds both the
// login (passwordHash) and the license/subscription. Zero dependency (Node crypto + fs).
//
// Record shape: { email, name?, passwordHash, passwordSalt, createdAt, resetToken?, resetExpires?,
//                 licenseKey?, customerId?, subscriptionId?, status?, currentPeriodEnd?, emailedKeyAt? }
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA, "subscribers.json");
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } }
function save(a) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(a, null, 2)); } catch (e) {} }
function norm(e) { return String(e || "").trim().toLowerCase(); }
function hash(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }

function findByEmail(email) { const e = norm(email); return load().find(x => x.email && x.email.toLowerCase() === e) || null; }

function sanitize(rec) {
    if (!rec) return null;
    return { email: rec.email, name: rec.name || "", hasPassword: !!rec.passwordHash,
             licenseKey: rec.licenseKey || "", status: rec.status || "",
             subscriptionId: rec.subscriptionId || "", currentPeriodEnd: rec.currentPeriodEnd || null,
             createdAt: rec.createdAt || null };
}
function listUsers() { return load().map(sanitize); }

// Create an account (or attach a password to an existing purchaser record with that email).
function register({ email, password, name }) {
    email = String(email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Please enter a valid email address.");
    if (String(password || "").length < 8) throw new Error("Password must be at least 8 characters.");
    const list = load();
    let rec = list.find(x => x.email && x.email.toLowerCase() === email.toLowerCase());
    if (rec && rec.passwordHash) throw new Error("An account with that email already exists — please sign in.");
    if (!rec) { rec = { email, createdAt: new Date().toISOString() }; list.push(rec); }
    const salt = crypto.randomBytes(16).toString("hex");
    rec.passwordSalt = salt; rec.passwordHash = hash(password, salt);
    if (name) rec.name = String(name).trim();
    save(list);
    return sanitize(rec);
}

function verify(email, password) {
    const rec = findByEmail(email);
    if (!rec || !rec.passwordHash) return false;
    try { return crypto.timingSafeEqual(Buffer.from(hash(password, rec.passwordSalt)), Buffer.from(rec.passwordHash)); }
    catch { return false; }
}

// Create a single-use reset token (1h). Returns the token, or null if no such user.
function createReset(email) {
    const list = load();
    const rec = list.find(x => x.email && x.email.toLowerCase() === norm(email));
    if (!rec) return null;
    const token = crypto.randomBytes(24).toString("hex");
    rec.resetToken = token; rec.resetExpires = Date.now() + RESET_TTL_MS;
    save(list);
    return token;
}
function emailForReset(token) {
    token = String(token || ""); if (!token) return null;
    const rec = load().find(x => x.resetToken === token);
    if (!rec || !rec.resetExpires || rec.resetExpires < Date.now()) return null;
    return rec.email;
}
function resetPassword(token, password) {
    if (String(password || "").length < 8) throw new Error("Password must be at least 8 characters.");
    const list = load();
    const rec = list.find(x => x.resetToken === String(token || ""));
    if (!rec || !rec.resetExpires || rec.resetExpires < Date.now()) return false;
    const salt = crypto.randomBytes(16).toString("hex");
    rec.passwordSalt = salt; rec.passwordHash = hash(password, salt);
    rec.resetToken = null; rec.resetExpires = null;
    save(list);
    return true;
}

module.exports = { load, save, findByEmail, sanitize, listUsers, register, verify, createReset, emailForReset, resetPassword };
