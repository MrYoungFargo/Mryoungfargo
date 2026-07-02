const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// ==============================================================
// ENVIRONMENT VARIABLES
// ==============================================================
const IKHOKHA_APP_ID = process.env.IKHOKHA_APP_ID;
const IKHOKHA_SECRET = process.env.IKHOKHA_SECRET;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const ADMIN_EMAIL = 'mryoungfargo@gmail.com';

console.log('Brevo API Key present:', BREVO_API_KEY ? 'YES' : 'NO');
console.log('Admin email:', ADMIN_EMAIL);

// ==============================================================
// SUPABASE CLIENTS
// ==============================================================
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const supabasePublic = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

global.sessions = new Map();
global.resetTokens = {};

// ==============================================================
// HELPER: Get or create user_store_data row
// ==============================================================
async function getUserStoreData(userId) {
  let { data, error } = await supabaseAdmin
    .from('user_store_data')
    .select('*')
    .eq('id', userId)
    .single();

  if (error && error.code === 'PGRST116') {
    const { data: newData, error: insertError } = await supabaseAdmin
      .from('user_store_data')
      .insert([{ id: userId, cart: [], has_purchased_mixtape: false }])
      .select()
      .single();
    if (insertError) throw insertError;
    return newData;
  }
  if (error) throw error;
  return data;
}

// ==============================================================
// HELPER: Send order confirmation email via Brevo
// ==============================================================
async function sendOrderConfirmationEmail(order) {
  console.log('Attempting to send email for order:', order.order_id);
  if (!BREVO_API_KEY) {
    console.log('Brevo API key missing, skipping email');
    return;
  }
  
  const itemsHtml = order.items.map(item => `
    <tr>
      <td style="padding: 8px; border: 1px solid #ddd;">${item.name}</td>
      <td style="padding: 8px; border: 1px solid #ddd;">${item.size || 'N/A'}</td>
      <td style="padding: 8px; border: 1px solid #ddd;">${item.color || 'N/A'}</td>
      <td style="padding: 8px; border: 1px solid #ddd;">${item.qty}</td>
      <td style="padding: 8px; border: 1px solid #ddd;">R${item.price.toFixed(2)}</td>
     </tr>
  `).join('');
  
  let paxiHtml = '';
  if (order.paxi_store_name) {
    paxiHtml = `
      <h3>📦 COLLECTION POINT (PAXI)</h3>
      <p><strong>Store:</strong> ${order.paxi_store_name}</p>
      <p><strong>Address:</strong> ${order.paxi_store_address}</p>
      <p><strong>PAXI Code:</strong> ${order.paxi_store_code || 'N/A'}</p>
      <hr>
    `;
  }
  
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #3b82f6;">🛍️ New Order!</h2>
      <p><strong>Order ID:</strong> ${order.order_id}</p>
      <p><strong>Customer:</strong> ${order.customer_email}</p>
      <p><strong>Total:</strong> <span style="font-size: 1.2rem; color: #10b981;">R${order.total_amount.toFixed(2)}</span></p>
      ${paxiHtml}
      <h3>Items Purchased:</h3>
      <table style="width:100%; border-collapse: collapse;">...${itemsHtml}...</table>
      <hr><p style="color:#666;font-size:12px;">MrYoungFargo Store</p>
    </div>
  `;
  
  const customerEmailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; text-align: center;">
      <h2 style="color: #3b82f6;">Thank You for Your Order!</h2>
      <p>Your order <strong>#${order.order_id}</strong> has been received.</p>
      <p><strong>Total:</strong> R${order.total_amount.toFixed(2)}</p>
      ${order.paxi_store_name ? `<p><strong>Collection Point:</strong> ${order.paxi_store_name}</p>` : ''}
      <p>For questions, reply to this email.</p>
      <p>💿 <strong>MrYoungFargo</strong></p>
    </div>
  `;
  
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: 'MrYoungFargo Store', email: 'noreply@mryoungfargo.com' },
        to: [{ email: ADMIN_EMAIL }],
        subject: `New Order #${order.order_id} - R${order.total_amount.toFixed(2)}`,
        htmlContent: emailHtml
      })
    });
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: 'MrYoungFargo Store', email: 'noreply@mryoungfargo.com' },
        to: [{ email: order.customer_email }],
        subject: `Thank you for your order #${order.order_id}`,
        htmlContent: customerEmailHtml
      })
    });
    console.log(`Order confirmation emails sent for #${order.order_id}`);
  } catch (error) {
    console.error('Failed to send order email:', error);
  }
}

// ==============================================================
// HEALTH CHECK
// ==============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ==============================================================
// AUTH ENDPOINTS
// ==============================================================
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
  try {
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (authError) throw authError;
    const storeData = await getUserStoreData(authUser.user.id);
    res.json({ success: true, user: { email: authUser.user.email, cart: storeData.cart || [], hasPurchasedMixtape: storeData.has_purchased_mixtape || false } });
  } catch (error) {
    console.error('Registration error:', error);
    res.json({ success: false, error: error.message || 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
  try {
    const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
    if (error) return res.json({ success: false, error: 'Invalid email or password' });
    const sessionToken = crypto.randomBytes(32).toString('hex');
    global.sessions.set(sessionToken, { userId: data.user.id, email: data.user.email });
    const storeData = await getUserStoreData(data.user.id);
    res.json({ success: true, sessionToken, user: { email: data.user.email, cart: storeData.cart || [], hasPurchasedMixtape: storeData.has_purchased_mixtape || false } });
  } catch (error) {
    console.error('Login error:', error);
    res.json({ success: false, error: error.message || 'Login failed' });
  }
});

app.post('/api/verify', async (req, res) => {
  const { sessionToken } = req.body;
  if (!sessionToken || !global.sessions.has(sessionToken)) return res.json({ success: false, error: 'Invalid session' });
  const session = global.sessions.get(sessionToken);
  try {
    const storeData = await getUserStoreData(session.userId);
    res.json({ success: true, user: { email: session.email, cart: storeData.cart || [], hasPurchasedMixtape: storeData.has_purchased_mixtape || false } });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/update-cart', async (req, res) => {
  const { sessionToken, cart } = req.body;
  if (!sessionToken || !global.sessions.has(sessionToken)) return res.json({ success: false, error: 'Invalid session' });
  const session = global.sessions.get(sessionToken);
  try {
    await supabaseAdmin.from('user_store_data').update({ cart, updated_at: new Date() }).eq('id', session.userId);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/mark-mixtape', async (req, res) => {
  const { sessionToken } = req.body;
  if (!sessionToken || !global.sessions.has(sessionToken)) return res.json({ success: false, error: 'Invalid session' });
  const session = global.sessions.get(sessionToken);
  try {
    await supabaseAdmin.from('user_store_data').update({ has_purchased_mixtape: true, updated_at: new Date() }).eq('id', session.userId);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/logout', (req, res) => {
  const { sessionToken } = req.body;
  if (sessionToken && global.sessions) global.sessions.delete(sessionToken);
  res.json({ success: true });
});

// ==============================================================
// SAVE ORDER
// ==============================================================
app.post('/api/save-order', async (req, res) => {
  const { sessionToken, orderId, items, total, customerEmail, paxi_store_name, paxi_store_address, paxi_store_code } = req.body;
  if (!sessionToken || !global.sessions.has(sessionToken)) return res.json({ success: false, error: 'Invalid session' });
  try {
    const { data, error } = await supabaseAdmin.from('orders').insert([{
      order_id: orderId, customer_email: customerEmail, items, total_amount: total, payment_status: 'pending',
      paxi_store_name: paxi_store_name || null, paxi_store_address: paxi_store_address || null, paxi_store_code: paxi_store_code || null
    }]).select().single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (error) {
    console.error('Save order error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/update-order-status', async (req, res) => {
  const { orderId, paymentId } = req.body;
  try {
    const { data, error } = await supabaseAdmin.from('orders').update({ payment_status: 'paid', payment_id: paymentId, updated_at: new Date() }).eq('order_id', orderId).select().single();
    if (error) throw error;
    await sendOrderConfirmationEmail(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Update order status error:', error);
    res.json({ success: false, error: error.message });
  }
});

// ==============================================================
// FORGOT & RESET PASSWORD
// ==============================================================
app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ success: false, error: 'Email required' });
  const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
  if (listError) return res.json({ success: false, error: listError.message });
  const user = users.find(u => u.email === email);
  if (!user) return res.json({ success: false, error: 'Email not found' });
  if (!BREVO_API_KEY) return res.json({ success: false, error: 'Email service not configured' });
  const resetToken = crypto.randomBytes(32).toString('hex');
  global.resetTokens[email] = { token: resetToken, expires: Date.now() + 3600000 };
  const resetLink = `https://mryoungfargo.github.io/Mryoungfargo/?token=${resetToken}&email=${encodeURIComponent(email)}`;
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: 'MrYoungFargo', email: 'noreply@mryoungfargo.com' },
        to: [{ email }],
        subject: 'Reset your MrYoungFargo password',
        htmlContent: `<div><h2>Reset Your Password</h2><a href="${resetLink}">Click here to reset your password</a><p>This link expires in 1 hour.</p></div>`
      })
    });
    res.json({ success: response.ok, message: response.ok ? 'Reset email sent' : (await response.json()).message });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.post('/reset-password', async (req, res) => {
  const { email, token, newPassword } = req.body;
  if (!email || !token || !newPassword) return res.json({ success: false, error: 'Email, token, and new password are required' });
  if (!global.resetTokens[email] || global.resetTokens[email].token !== token || global.resetTokens[email].expires < Date.now()) {
    return res.json({ success: false, error: 'Invalid or expired reset token' });
  }
  try {
    const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) throw listError;
    const user = users.find(u => u.email === email);
    if (!user) return res.json({ success: false, error: 'User not found' });
    await supabaseAdmin.auth.admin.updateUserById(user.id, { password: newPassword });
    delete global.resetTokens[email];
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.json({ success: false, error: error.message || 'Failed to reset password' });
  }
});

// ==============================================================
// IKHOKHA PAYMENT (UPDATED URLs)
// ==============================================================
const IKHOKHA_API_ENDPOINT = 'https://api.ikhokha.com/public-api/v1/api/payment';

function jsStringEscape(str) { return str.replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0'); }
function createPayloadToSign(urlPath, body) {
  const basePath = new URL(urlPath).pathname;
  return jsStringEscape(basePath + body);
}
function generateSignature(payloadToSign, secret) {
  return crypto.createHmac('sha256', secret).update(payloadToSign).digest('hex');
}

app.post('/create-payment', async (req, res) => {
  const { amount, orderId } = req.body;
  if (!amount || amount <= 0) return res.json({ success: false, error: 'Invalid amount' });
  if (!IKHOKHA_APP_ID || !IKHOKHA_SECRET) return res.json({ success: false, error: 'iKhokha API keys not configured' });
  const amountInCents = Math.round(amount * 100);
  const requestPayload = {
    entityID: IKHOKHA_APP_ID,
    amount: amountInCents,
    currency: 'ZAR',
    requesterUrl: 'https://mryoungfargo.github.io/Mryoungfargo/',
    mode: 'TEST',
    externalTransactionID: orderId || 'ORDER_' + Date.now(),
    urls: {
      callbackUrl: 'https://mryoungfargo-payment.onrender.com/webhook',
      successPageUrl: 'https://mryoungfargo.github.io/Mryoungfargo/?payment=success',
      failurePageUrl: 'https://mryoungfargo.github.io/Mryoungfargo/?payment=failed',
      cancelUrl: 'https://mryoungfargo.github.io/Mryoungfargo/?payment=cancel'
    }
  };
  const requestBodyStr = JSON.stringify(requestPayload);
  const payloadToSign = createPayloadToSign(IKHOKHA_API_ENDPOINT, requestBodyStr);
  const signature = generateSignature(payloadToSign, IKHOKHA_SECRET);
  try {
    const response = await fetch(IKHOKHA_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'IK-APPID': IKHOKHA_APP_ID, 'IK-SIGN': signature },
      body: requestBodyStr
    });
    const data = await response.json();
    if (data.paylinkUrl) {
      res.json({ success: true, paymentUrl: data.paylinkUrl, paymentId: data.paylinkID });
    } else {
      res.json({ success: false, error: data.message || 'Payment creation failed' });
    }
  } catch (error) {
    console.error('iKhokha error:', error);
    res.json({ success: false, error: error.message });
  }
});

// ==============================================================
// WEBHOOK - NOW MARKS MIXTAPE PURCHASED
// ==============================================================
app.post('/webhook', async (req, res) => {
  console.log('💰 Webhook received:', req.body);
  const { paylinkID, status, externalTransactionID } = req.body;
  if (status === 'SUCCESS') {
    try {
      // Update order status
      const { data: order, error } = await supabaseAdmin
        .from('orders')
        .update({ payment_status: 'paid', payment_id: paylinkID, updated_at: new Date() })
        .eq('order_id', externalTransactionID)
        .select()
        .single();
      if (error) throw error;
      console.log(`Order ${externalTransactionID} marked as paid`);

      // Check if mixtape was purchased
      const hasMixtape = order.items.some(item => item.id === 99);
      if (hasMixtape) {
        // Find user by email
        const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
        if (listError) throw listError;
        const user = users.find(u => u.email === order.customer_email);
        if (user) {
          await supabaseAdmin
            .from('user_store_data')
            .update({ has_purchased_mixtape: true, updated_at: new Date() })
            .eq('id', user.id);
          console.log(`Mixtape marked as purchased for ${order.customer_email}`);
        }
      }
      // Also send email confirmation
      await sendOrderConfirmationEmail(order);
    } catch (error) {
      console.error('Webhook error:', error);
    }
  }
  res.status(200).send('OK');
});

// ==============================================================
// TEST ENDPOINTS
// ==============================================================
app.get('/test-supabase', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers();
    if (error) throw error;
    res.json({ success: true, users: data.users.length });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/test-email', async (req, res) => {
  if (!BREVO_API_KEY) return res.json({ error: 'BREVO_API_KEY not set' });
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: 'MrYoungFargo', email: 'noreply@mryoungfargo.com' },
        to: [{ email: 'mryoungfargo@gmail.com' }],
        subject: 'Test Email from Your Store',
        htmlContent: '<h1>✅ Test Successful!</h1>'
      })
    });
    res.json({ success: response.ok, status: response.status });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: '✅ Payment API is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Supabase connected: ${SUPABASE_URL ? '✅' : '❌'}`);
  console.log(`Brevo API key: ${BREVO_API_KEY ? '✅' : '❌'}`);
  console.log(`iKhokha keys: ${IKHOKHA_APP_ID ? '✅' : '❌'}`);
});
