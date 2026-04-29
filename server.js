const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Your iKhokha credentials - set these in Render environment variables
const IKHOKHA_APP_ID = process.env.IK46NDKL1J3S4VJWO7XXCRD4F8P3KQAN;
const IKHOKHA_SECRET = process.env.pe09mzC6QwkaQGMA72CVq9SeAvtsXoxK;

// Generate signature for iKhokha API
function generateSignature(payload, secret) {
    const stringToSign = JSON.stringify(payload) + secret;
    return crypto.createHash('sha256').update(stringToSign).digest('hex');
}

// Endpoint to create payment link
app.post('/create-payment', async (req, res) => {
    const { amount, orderId, customerEmail } = req.body;
    
    // Convert amount to cents (R179.99 = 17999)
    const amountInCents = Math.round(amount * 100);
    
    const payload = {
        amount: amountInCents,
        currency: "ZAR",
        mode: "TEST",  // Change to "PRODUCTION" when ready
        transactionType: "SALE",
        merchantOrderID: orderId || "ORDER_" + Date.now(),
        customerEmail: customerEmail || "customer@example.com",
        returnUrl: "https://mryoungfargo.github.io/Duets-merch-store/success.html",
        cancelUrl: "https://mryoungfargo.github.io/Duets-merch-store/cancel.html",
        notifyUrl: "https://your-backend-url.onrender.com/webhook"
    };
    
    const signature = generateSignature(payload, IKHOKHA_SECRET);
    
    try {
        const response = await fetch('https://sandbox.ikhokha.com/v1/payments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Application-Id': IKHOKHA_APP_ID,
                'X-Signature': signature
            },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        
        if (data.paymentUrl) {
            res.json({ 
                success: true, 
                paymentUrl: data.paymentUrl,
                paymentId: data.paymentId 
            });
        } else {
            res.json({ 
                success: false, 
                error: data.message || "Payment creation failed" 
            });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Webhook endpoint for payment confirmation
app.post('/webhook', (req, res) => {
    const { paymentId, status, amount } = req.body;
    
    if (status === "SUCCESS") {
        console.log(`✅ Payment successful! Payment ID: ${paymentId}, Amount: R${amount/100}`);
        // Here you can add logic to:
        // - Send email confirmation
        // - Update order database
        // - Trigger the ZIP file download
    } else {
        console.log(`❌ Payment failed: ${status}`);
    }
    
    res.status(200).send("OK");
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
