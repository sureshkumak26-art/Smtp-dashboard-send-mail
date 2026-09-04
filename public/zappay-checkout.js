(() => {
  const $ = (id) => document.getElementById(id);
  let activeCheckout = null;

  function amountFrom(value) {
    const amount = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(amount) ? amount : NaN;
  }

  function mobileFrom(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^\d{10}$/.test(raw)) return raw;
    if (/^91\d{10}$/.test(raw)) return raw.slice(2);
    if (/^\+91\d{10}$/.test(raw)) return raw.slice(3);
    if (/^0\d{10}$/.test(raw)) return raw.slice(1);
    return "";
  }

  function notify(message) {
    if (typeof window.toast === "function") window.toast(message);
    else alert(message);
  }

  function setStatus(message, ok = false) {
    const el = $("zapPayStatus");
    if (!el) return;
    el.textContent = message;
    el.style.color = ok ? "#43e39a" : "#9fb4d0";
  }

  function ensureModal() {
    if ($("zapPayModal")) return;
    const wrap = document.createElement("div");
    wrap.id = "zapPayModal";
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(2,8,23,.78);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px";
    wrap.innerHTML = `<div class="card" style="width:min(500px,100%);position:relative;border-color:#2b69ad">
      <button id="zapPayClose" class="btn secondary" style="position:absolute;right:14px;top:14px;padding:7px 10px">✕</button>
      <h2>💳 Secure UPI Checkout</h2>
      <p class="muted" id="zapPayPlan"></p>
      <div class="field"><label>Customer Email</label><input id="zapPayEmail" type="email" placeholder="customer@example.com" required></div>
      <div class="field"><label>Domain</label><input id="zapPayDomain" placeholder="example.com" required></div>
      <div class="field"><label>Mobile <span class="muted">(optional)</span></label><input id="zapPayMobile" inputmode="numeric" placeholder="9876543210"></div>
      <div id="zapPayStatus" class="muted" style="margin:12px 0;line-height:1.5"></div>
      <button id="zapPayStart" class="btn" style="width:100%">Pay with ZapPay UPI</button>
    </div>`;
    document.body.appendChild(wrap);
    $("zapPayClose").onclick = () => { wrap.style.display = "none"; activeCheckout = null; };
    $("zapPayStart").onclick = startPayment;
  }

  async function loadWidget() {
    if (window.ZapPay) return true;
    return new Promise((resolve) => {
      const existing = document.querySelector('script[src="https://zappay.shop/zappay-pay.js"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(!!window.ZapPay));
        existing.addEventListener("error", () => resolve(false));
        setTimeout(() => resolve(!!window.ZapPay), 3000);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://zappay.shop/zappay-pay.js";
      script.async = true;
      script.onload = () => resolve(!!window.ZapPay);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  async function openCheckout(button) {
    ensureModal();
    const plan = button.dataset.plan || "Email Hosting";
    const amount = amountFrom(button.dataset.price);
    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) {
      notify("Payment validation failed: the plan amount must be between ₹1 and ₹5,000.");
      return;
    }
    activeCheckout = { plan, amount };
    $("zapPayPlan").textContent = `${plan} Email Hosting — ₹${amount}/month`;
    $("zapPayStatus").textContent = "Enter customer details to continue.";
    $("zapPayModal").style.display = "flex";
    $("zapPayEmail").focus();
  }

  async function startPayment() {
    if (!activeCheckout) return;
    const email = $("zapPayEmail").value.trim().toLowerCase();
    const domain = $("zapPayDomain").value.trim().toLowerCase();
    const mobileRaw = $("zapPayMobile").value.trim();
    const mobile = mobileFrom(mobileRaw);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus("Validation failed: enter a valid customer email address.");
      return;
    }
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      setStatus("Validation failed: enter a valid domain such as example.com.");
      return;
    }
    if (mobileRaw && !mobile) {
      setStatus("Validation failed: mobile must be 10 digits, optionally prefixed with +91, 91, or 0.");
      return;
    }

    const amount = amountFrom(activeCheckout.amount);
    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) {
      setStatus("Validation failed: invalid payment amount.");
      return;
    }

    const start = $("zapPayStart");
    start.disabled = true;
    start.textContent = "Preparing payment…";
    setStatus("Creating secure checkout session…");

    try {
      const cfgRes = await fetch("/api/zappay/config", { credentials: "same-origin" });
      const cfg = await cfgRes.json();
      if (!cfgRes.ok || !cfg.enabled || !cfg.zap_api) {
        throw new Error("ZapPay API key is not configured. Add ZAP_API_KEY to the server .env file and restart the panel.");
      }

      const sessionRes = await fetch("/api/zappay/checkout-session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: activeCheckout.plan,
          amount,
          domain,
          email,
          ...(mobile ? { customer_mobile: mobile } : {})
        })
      });
      const session = await sessionRes.json();
      if (!sessionRes.ok || !session.success) throw new Error(session.error || "Unable to prepare the payment order.");

      const ready = await loadWidget();
      if (!ready) throw new Error("ZapPay checkout could not load. Refresh the page and try again.");

      const checkoutToken = session.checkout_token;
      setStatus("Opening ZapPay UPI checkout…");

      ZapPay.setCallbacks({
        onSuccess: async (order) => {
          setStatus("Payment callback received. Verifying payment with ZapPay server…");
          try {
            const verifyRes = await fetch("/api/zappay/verify", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ checkout_token: checkoutToken, order_id: order.order_id })
            });
            const verified = await verifyRes.json();
            if (!verifyRes.ok) throw new Error(verified.error || "Server verification failed.");
            if (verified.confirmed === true && verified.status === "success") {
              setStatus(`✅ Payment confirmed — ${verified.plan} for ${verified.domain}. Order ID: ${verified.order_id}`, true);
              start.textContent = "Payment Confirmed";
              start.disabled = true;
              notify("Payment confirmed successfully. The order is now marked paid.");
            } else if (verified.status === "pending") {
              setStatus("Payment is still pending. Do not pay again yet; check the order again shortly.");
              start.disabled = false;
              start.textContent = "Check Payment Again";
            } else {
              setStatus(verified.message || "Payment failed. You can retry the checkout.");
              start.disabled = false;
              start.textContent = "Retry Payment";
            }
          } catch (e) {
            setStatus(`Verification/network error: ${e.message}`);
            start.disabled = false;
            start.textContent = "Retry Verification";
          }
        },
        onFailed: (order) => {
          const detail = order && order.error ? ` (${order.error})` : "";
          setStatus(`Payment failed${detail}. Please retry the UPI payment or choose another plan.`);
          start.disabled = false;
          start.textContent = "Retry Payment";
        },
        onTimeout: (order) => {
          setStatus(`Payment timed out or the checkout was closed${order && order.order_id ? ` — Order ID: ${order.order_id}` : ""}. No payment was marked successful. You can retry.`);
          start.disabled = false;
          start.textContent = "Retry Payment";
        }
      });

      ZapPay.createOrder({
        zap_api: cfg.zap_api,
        amount,
        title: `Anime Cloud ${activeCheckout.plan} Email Hosting`,
        ...(mobile ? { customer_mobile: mobile } : {})
      });
    } catch (e) {
      setStatus(e.message || "Unable to start ZapPay checkout.");
      start.disabled = false;
      start.textContent = "Pay with ZapPay UPI";
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest && event.target.closest(".orderBtn");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openCheckout(button);
  }, true);
})();
