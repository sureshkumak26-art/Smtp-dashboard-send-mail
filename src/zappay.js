const crypto = require("crypto");

const ZAP_BASE = "https://zappay-beta.vercel.app";

function cleanAmount(value) {
  const amount = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) ? amount : NaN;
}

function cleanMobile(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{10}$/.test(raw)) return raw;
  if (/^91\d{10}$/.test(raw)) return raw.slice(2);
  if (/^\+91\d{10}$/.test(raw)) return raw.slice(3);
  if (/^0\d{10}$/.test(raw)) return raw.slice(1);
  return "";
}

function friendly(status, message) {
  const m = String(message || "");
  if (status === 401 && /Missing ZapAPI key/i.test(m)) return "ZapPay API key is missing. Add ZAP_API_KEY to the server .env file and restart the panel.";
  if (status === 401 && /Invalid ZapAPI key/i.test(m)) return "ZapPay API key is invalid. Copy the current key from ZapPay Developer Portal → Zap API and update ZAP_API_KEY.";
  if (status === 403) return "Your ZapPay account is suspended. Contact ZapPay support; this cannot be fixed from the panel.";
  if (status === 400 && /Validation failed/i.test(m)) return "ZapPay rejected the payment details. Check the amount is between ₹1 and ₹5,000 and the mobile number contains only valid digits.";
  if (status === 400 && /wallet is full/i.test(m)) return "Your ZapPay wallet has reached its Live Mode limit. Increase the wallet limit or contact ZapPay support.";
  if (status === 404) return "ZapPay order was not found. Do not reuse an old order ID; start the checkout again.";
  if (status === 429) return "ZapPay rate limit reached. Please wait and try again. Payment status polling must not run faster than every 2.5 seconds.";
  if (status === 503) return "ZapPay payment system is under maintenance. Please try again later.";
  if (/fetch|network|ECONN|ETIMEDOUT/i.test(m)) return "Unable to reach ZapPay right now. Check the server network connection and try again.";
  return m || "ZapPay request failed. Please try again.";
}

module.exports = function registerZapPay({ app, db, adminOnly }) {
  db.exec(`CREATE TABLE IF NOT EXISTS payment_orders(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkout_token TEXT UNIQUE NOT NULL,
    zap_order_id TEXT UNIQUE,
    plan TEXT NOT NULL,
    amount REAL NOT NULL,
    domain TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_mobile TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT
  )`);

  app.get("/api/zappay/config", adminOnly, (req, res) => {
    const key = String(process.env.ZAP_API_KEY || "").trim();
    res.json({ enabled: !!key, zap_api: key || null });
  });

  app.post("/api/zappay/checkout-session", adminOnly, (req, res) => {
    const amount = cleanAmount(req.body.amount);
    const plan = String(req.body.plan || "").trim();
    const domain = String(req.body.domain || "").trim().toLowerCase();
    const email = String(req.body.email || "").trim().toLowerCase();
    const mobile = cleanMobile(req.body.customer_mobile);

    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) {
      return res.status(400).json({ error: "Invalid payment amount. Enter an amount between ₹1 and ₹5,000." });
    }
    if (!plan) return res.status(400).json({ error: "Please select an Email Hosting plan." });
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      return res.status(400).json({ error: "Enter a valid domain, for example example.com." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid customer email address." });
    }
    if (req.body.customer_mobile && !mobile) {
      return res.status(400).json({ error: "Invalid mobile number. Use 10 digits, optionally prefixed with +91, 91, or 0." });
    }

    const checkoutToken = crypto.randomBytes(24).toString("hex");
    db.prepare(`INSERT INTO payment_orders(checkout_token,plan,amount,domain,customer_email,customer_mobile)
      VALUES(?,?,?,?,?,?)`).run(checkoutToken, plan, amount, domain, email, mobile);

    res.json({ success: true, checkout_token: checkoutToken, amount, plan });
  });

  app.post("/api/zappay/verify", adminOnly, async (req, res) => {
    const token = String(req.body.checkout_token || "").trim();
    const orderId = String(req.body.order_id || "").trim();
    if (!token || !orderId) return res.status(400).json({ error: "Missing checkout token or ZapPay order ID." });

    const local = db.prepare("SELECT * FROM payment_orders WHERE checkout_token=?").get(token);
    if (!local) return res.status(404).json({ error: "Checkout session not found. Start the order again." });

    const key = String(process.env.ZAP_API_KEY || "").trim();
    if (!key) return res.status(503).json({ error: "ZapPay API key is not configured on the server. Add ZAP_API_KEY to .env and restart the panel." });

    try {
      const r = await fetch(`${ZAP_BASE}/api/developer/order-status/${encodeURIComponent(orderId)}`, {
        headers: { "X-ZapAPI-Key": key },
        signal: AbortSignal.timeout(15000)
      });
      let data = {};
      try { data = await r.json(); } catch (_) {}
      const message = data.message || r.statusText;

      if (!r.ok || data.success !== true) {
        return res.status(r.status || 502).json({ error: friendly(r.status, message), code: r.status });
      }

      const remote = data.data || {};
      const remoteAmount = cleanAmount(remote.amount);

      if (remoteAmount !== local.amount) {
        return res.status(400).json({ error: "Payment amount does not match this order. Nothing has been unlocked." });
      }

      db.prepare("UPDATE payment_orders SET zap_order_id=?,status=? WHERE checkout_token=?")
        .run(orderId, remote.status, token);

      if (remote.status === "success") {
        db.prepare("UPDATE payment_orders SET paid_at=CURRENT_TIMESTAMP WHERE checkout_token=?")
          .run(token);
        return res.json({ confirmed: true, status: "success", order_id: orderId, amount: local.amount, plan: local.plan, domain: local.domain, customer_email: local.customer_email });
      }

      if (remote.status === "pending") {
        return res.json({ confirmed: false, status: "pending", order_id: orderId, message: "Payment is still pending. Please wait for the payment status to update." });
      }

      return res.json({ confirmed: false, status: "failed", order_id: orderId, message: "ZapPay reports that this payment failed." });
    } catch (e) {
      return res.status(502).json({ error: friendly(502, e.message) });
    }
  });
};
