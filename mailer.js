// Outbound email for the HayBackup site — sends the customer their license key on purchase.
// Railway blocks SMTP, so this uses the ZeptoMail HTTP API (zero dependency, Node https + crypto only).
//
// Config (env vars first — 12-factor — then data/email-config.json via admin):
//   ZEPTOMAIL_TOKEN   the ZeptoMail "Send Mail" token (sent as: Authorization: Zoho-enczapikey <token>)
//   MAIL_FROM         the from address (must be a ZeptoMail-verified sender domain), e.g. noreply@reponis.com
//   MAIL_FROM_NAME    display name, default "HayBackup"
//   MAIL_REPLY_TO     optional reply-to (e.g. support@reponis.com)
//   ZEPTOMAIL_HOST    API host, default api.zeptomail.com (use api.zeptomail.eu for EU accounts)
const https = require("https");
const fs = require("fs");
const path = require("path");

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const CFG = path.join(DATA, "email-config.json");

function cfg() {
    let f = {}; try { f = JSON.parse(fs.readFileSync(CFG, "utf8")); } catch (e) {}
    return {
        token: process.env.ZEPTOMAIL_TOKEN || f.token || "",
        from: process.env.MAIL_FROM || f.from || "",
        fromName: process.env.MAIL_FROM_NAME || f.fromName || "HayBackup",
        replyTo: process.env.MAIL_REPLY_TO || f.replyTo || "",
        host: process.env.ZEPTOMAIL_HOST || f.host || "api.zeptomail.com"
    };
}
function saveCfg(c) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); } catch (e) {} }
function configured() { const c = cfg(); return !!(c.token && c.from); }

// Low-level send via ZeptoMail. Resolves on 2xx, rejects with the API error otherwise.
function send({ to, toName, subject, html, text }) {
    return new Promise((resolve, reject) => {
        const c = cfg();
        if (!c.token || !c.from) return reject(new Error("Email not configured (token/from missing)."));
        const payload = {
            from: { address: c.from, name: c.fromName || "HayBackup" },
            to: [{ email_address: { address: to, name: toName || to } }],
            subject: subject,
            htmlbody: html || "",
            textbody: text || ""
        };
        if (c.replyTo) payload.reply_to = [{ address: c.replyTo, name: c.fromName || "HayBackup" }];
        const body = Buffer.from(JSON.stringify(payload));
        const req = https.request({ host: c.host, path: "/v1.1/email", method: "POST", timeout: 20000,
            headers: { "Authorization": "Zoho-enczapikey " + c.token, "Content-Type": "application/json", "Accept": "application/json", "Content-Length": body.length } },
            res => { let d = ""; res.on("data", x => d += x); res.on("end", () => {
                let j = {}; try { j = JSON.parse(d); } catch (e) {}
                if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j);
                const msg = (j && j.message) || (j && j.error && j.error.message) || ("ZeptoMail HTTP " + res.statusCode);
                const detail = (j && j.error && j.error.details && j.error.details[0] && j.error.details[0].message) || "";
                reject(new Error(msg + (detail ? (" — " + detail) : "") + (d && res.statusCode >= 400 ? (" :: " + d.slice(0, 300)) : "")));
            }); });
        req.on("timeout", () => req.destroy(new Error("ZeptoMail request timed out")));
        req.on("error", reject);
        req.end(body);
    });
}

function licenseEmailHtml(rec) {
    const key = rec.licenseKey || "";
    return `<!DOCTYPE html><html><body style="margin:0;background:#070b16;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#e5edf7">
<div style="max-width:560px;margin:0 auto;padding:28px 22px">
  <h1 style="font-size:22px;margin:0 0 6px">Welcome to HayBackup 🎉</h1>
  <p style="color:#9fb0c7;line-height:1.55;margin:0 0 18px">Thanks for subscribing. Your license is active — here is your license key:</p>
  <div style="border:1px solid rgba(34,211,238,.35);background:rgba(34,211,238,.07);border-radius:12px;padding:16px 18px;text-align:center;margin:0 0 20px">
    <div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#7fd6e6;margin-bottom:8px">Your license key</div>
    <div style="font-family:Consolas,'SF Mono',monospace;font-size:22px;font-weight:700;color:#eaf6ff;letter-spacing:.04em">${key}</div>
  </div>
  <p style="color:#eaf6ff;font-weight:700;margin:0 0 6px">Activate HayBackup in 4 steps</p>
  <ol style="color:#c4d2e4;line-height:1.7;padding-left:18px;margin:0 0 18px">
    <li>Open the <b>HayBackup</b> dashboard on your PC.</li>
    <li>Go to <b>Settings &rarr; License</b>.</li>
    <li>Paste the license key above and click <b>Activate</b>.</li>
    <li>The banner turns to <b>&#10003; Active</b> — you're licensed on this PC and any others on your network.</li>
  </ol>
  <p style="color:#9fb0c7;line-height:1.55;font-size:14px;margin:0 0 6px">Manage or cancel your subscription anytime from the <b>Renew / Manage license</b> button in the app.</p>
  <p style="color:#7c8aa0;font-size:13px;margin:14px 0 0">Need help? Just reply to this email.</p>
</div></body></html>`;
}
function licenseEmailText(rec) {
    return "Welcome to HayBackup!\n\nThanks for subscribing. Your license is active.\n\n"
        + "YOUR LICENSE KEY: " + (rec.licenseKey || "") + "\n\n"
        + "Activate in 4 steps:\n"
        + "1) Open the HayBackup dashboard on your PC.\n"
        + "2) Go to Settings -> License.\n"
        + "3) Paste your license key and click Activate.\n"
        + "4) The banner turns to Active - you're licensed on this PC and any others on your network.\n\n"
        + "Manage or cancel anytime from the Renew / Manage license button in the app.\n"
        + "Need help? Just reply to this email.\n";
}
function sendLicenseEmail(rec) {
    if (!rec || !rec.email || !rec.licenseKey) return Promise.resolve(false);
    return send({ to: rec.email, subject: "Your HayBackup license key", html: licenseEmailHtml(rec), text: licenseEmailText(rec) })
        .then(() => true);
}

function passwordResetHtml(link) {
    return `<!DOCTYPE html><html><body style="margin:0;background:#070b16;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#e5edf7">
<div style="max-width:560px;margin:0 auto;padding:28px 22px">
  <h1 style="font-size:22px;margin:0 0 6px">Reset your HayBackup password</h1>
  <p style="color:#9fb0c7;line-height:1.55;margin:0 0 18px">We received a request to reset the password for your HayBackup account. Click the button below to choose a new one. This link expires in 1 hour.</p>
  <p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:linear-gradient(90deg,#22d3ee,#3b82f6);color:#04121f;font-weight:700;text-decoration:none;border-radius:11px;padding:12px 22px">Reset my password</a></p>
  <p style="color:#7c8aa0;font-size:13px;line-height:1.5;margin:0">If the button doesn't work, paste this link into your browser:<br><span style="color:#9fb0c7">${link}</span></p>
  <p style="color:#7c8aa0;font-size:13px;margin:14px 0 0">Didn't request this? You can safely ignore this email — your password won't change.</p>
</div></body></html>`;
}
function sendPasswordReset(email, link) {
    return send({ to: email, subject: "Reset your HayBackup password",
        html: passwordResetHtml(link),
        text: "Reset your HayBackup password\n\nOpen this link (expires in 1 hour) to choose a new password:\n" + link + "\n\nDidn't request this? You can ignore this email.\n" })
        .then(() => true);
}

module.exports = { cfg, saveCfg, configured, send, sendLicenseEmail, sendPasswordReset, licenseEmailHtml, licenseEmailText };
