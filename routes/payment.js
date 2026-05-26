// routes/payment.js
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const axios   = require('axios');

// Safe import of verifyToken
let verifyToken;
try {
  verifyToken = require('../middleware/auth').verifyToken;
} catch(e) {
  verifyToken = (req, res, next) => next(); // fallback: no auth
}

// ── Cashfree config ──────────────────────────────────────────────────────────
function getCashfreeConfig() {
  const appId     = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  const env       = process.env.CASHFREE_ENV || 'PRODUCTION'; // 'SANDBOX' for testing

  if (!appId || !secretKey || appId === 'your_cashfree_app_id_here') {
    throw new Error('Cashfree not configured yet');
  }

  const baseURL = env === 'SANDBOX'
    ? 'https://sandbox.cashfree.com/pg'
    : 'https://api.cashfree.com/pg';

  return {
    appId,
    secretKey,
    baseURL,
    env: env.toLowerCase(),
    headers: {
      'x-api-version': '2023-08-01',
      'x-client-id':     appId,
      'x-client-secret': secretKey,
      'Content-Type':    'application/json'
    }
  };
}

const PLANS = {
  pro:        { amount: 499,  name: 'CheckAI Pro',        description: '5,000 scans/month' },
  enterprise: { amount: 2999, name: 'CheckAI Enterprise', description: 'Unlimited scans'   }
};

// ── POST /api/payment/create-order ───────────────────────────────────────────
router.post('/create-order', verifyToken, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

    const cfg     = getCashfreeConfig();
    const orderId = `checkai_${plan}_${Date.now()}`;

    const payload = {
      order_id:       orderId,
      order_amount:   PLANS[plan].amount,
      order_currency: 'INR',
      order_note:     PLANS[plan].description,
      customer_details: {
        customer_id:    req.uid || 'guest_' + Date.now(),
        customer_email: req.email || 'user@checkai.in',
        customer_phone: '9999999999'   // Cashfree requires a phone — update if you collect it
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL}?order_id={order_id}&plan=${plan}`,
        notify_url: `${process.env.FRONTEND_URL?.replace('https://checkai.in', '')}/api/payment/webhook`
      }
    };

    const response = await axios.post(
      `${cfg.baseURL}/orders`,
      payload,
      { headers: cfg.headers }
    );

    const order = response.data;

    res.json({
      success:          true,
      orderId:          order.order_id,
      paymentSessionId: order.payment_session_id,
      amount:           order.order_amount,
      currency:         'INR',
      plan,
      mode:             cfg.env   // 'production' or 'sandbox' — used by frontend SDK
    });

  } catch (err) {
    if (err.message === 'Cashfree not configured yet') {
      return res.status(503).json({ error: 'Payments not configured yet' });
    }
    console.error('[Cashfree create-order]', err?.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payment/verify ─────────────────────────────────────────────────
// Called by frontend after checkout completes
router.post('/verify', verifyToken, async (req, res) => {
  try {
    const { orderId, plan } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const cfg = getCashfreeConfig();

    // Fetch order status directly from Cashfree
    const response = await axios.get(
      `${cfg.baseURL}/orders/${orderId}`,
      { headers: cfg.headers }
    );

    const order = response.data;

    if (order.order_status !== 'PAID') {
      return res.status(400).json({ error: `Payment not completed. Status: ${order.order_status}` });
    }

    // Update Firestore
    if (req.uid) {
      try {
        const { admin } = require('../middleware/auth');
        if (admin.apps.length) {
          await admin.firestore().collection('users').doc(req.uid).set({
            plan,
            planActivatedAt: new Date().toISOString(),
            paymentId:       order.cf_order_id,
            orderId:         orderId
          }, { merge: true });
        }
      } catch(e) { /* non-fatal */ }
    }

    res.json({ success: true, message: 'Payment verified. Plan activated!', plan });

  } catch (err) {
    console.error('[Cashfree verify]', err?.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payment/webhook ─────────────────────────────────────────────────
// Cashfree server-to-server webhook — backup activation in case user closes tab
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const cfg       = getCashfreeConfig();
    const rawBody   = req.body.toString();
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];

    // Verify webhook signature
    const signedPayload = timestamp + rawBody;
    const expected = crypto
      .createHmac('sha256', cfg.secretKey)
      .update(signedPayload)
      .digest('base64');

    if (expected !== signature) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = JSON.parse(rawBody);

    if (event?.data?.order?.order_status === 'PAID') {
      const orderId = event.data.order.order_id;
      // orderId format: checkai_pro_1234567890
      const planMatch = orderId.match(/^checkai_(\w+)_/);
      const plan      = planMatch ? planMatch[1] : null;
      const uid       = event.data.order.customer_details?.customer_id;

      if (uid && plan && !uid.startsWith('guest_')) {
        try {
          const { admin } = require('../middleware/auth');
          if (admin.apps.length) {
            await admin.firestore().collection('users').doc(uid).set({
              plan,
              planActivatedAt: new Date().toISOString(),
              paymentId:       event.data.payment?.cf_payment_id,
              orderId
            }, { merge: true });
          }
        } catch(e) { console.error('[Webhook Firestore]', e.message); }
      }
    }

    res.json({ success: true });

  } catch (err) {
    console.error('[Cashfree webhook]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/payment/plans — public ──────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({
    plans: [
      { id: 'free',       name: 'Free',       price: 0,    scans: 50,   currency: 'INR' },
      { id: 'pro',        name: 'Pro',        price: 499,  scans: 5000, currency: 'INR' },
      { id: 'enterprise', name: 'Enterprise', price: 2999, scans: -1,   currency: 'INR' }
    ]
  });
});

module.exports = router;
