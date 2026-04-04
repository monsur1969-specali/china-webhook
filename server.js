const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'globalchinatrading2024';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SHEET_URL = process.env.SHEET_URL;

let cachedProducts = [];
let lastFetch = 0;

// ✅ Safe Product Fetch
async function getProducts() {
  if (!SHEET_URL) return [];

  if (Date.now() - lastFetch < 10 * 60 * 1000) {
    return cachedProducts;
  }

  try {
    const res = await axios.get(SHEET_URL);

    const rows = res.data.trim().split('\n')
      .map(r => r.split(',').map(c => c.replace(/^"|"$/g, '').trim()));

    cachedProducts = rows.slice(1).filter(r => r[0]).map(r => ({
      name: r[0] || '',
      price: r[1] || '',
      discount: r[2] || (r[1] ? Math.round(parseFloat(r[1]) * 0.95) + '' : ''),
      desc: r[3] || '',
      image: r[4] || '',
      video: r[5] || ''
    }));

    lastFetch = Date.now();
    console.log(`✅ ${cachedProducts.length} products loaded`);

  } catch (e) {
    console.error('❌ Sheet fetch error:', e.message);
  }

  return cachedProducts;
}

const conversations = {};

// ✅ Safe AI Reply
async function getAIReply(senderId, userMsg) {
  try {
    const products = await getProducts();

    const productContext = products.length > 0
      ? '\n\nPRODUCT DATABASE:\n' + products.map(p =>
          `Name: ${p.name} | Price: ${p.price}TK | Discount: ${p.discount}TK | Desc: ${p.desc}`
        ).join('\n')
      : '';

    const systemPrompt = `You are a friendly AI sales assistant for "Global China Trading".

- Reply in same language (Bangla/English/Banglish)
- Show product clearly
- Max 3 products
- If not found say sorry
- Guide user to order${productContext}`;

    if (!conversations[senderId]) conversations[senderId] = [];

    conversations[senderId].push({ role: 'user', content: userMsg });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversations[senderId]
    ];

    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const reply = res.data.choices[0].message.content;

    conversations[senderId].push({ role: 'assistant', content: reply });

    return reply;

  } catch (e) {
    console.error('❌ AI Error:', e.message);
    return "দুঃখিত, একটু সমস্যা হয়েছে। আবার চেষ্টা করুন 🙏";
  }
}

// ✅ Send Message Safe
async function sendMessage(recipientId, messageText) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: messageText }
      }
    );
  } catch (error) {
    console.error('❌ Send error:', error.response?.data || error.message);
  }
}

// ✅ Webhook Verify
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ✅ Receive Message
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'page') return;

    for (const entry of body.entry) {
      for (const event of entry.messaging) {

        const senderId = event.sender.id;
        const messageText = event.message?.text;

        if (!messageText) continue;

        console.log(`📩 ${senderId}: ${messageText}`);

        const reply = await getAIReply(senderId, messageText);
        await sendMessage(senderId, reply);
      }
    }

  } catch (e) {
    console.error('❌ Webhook error:', e.message);
  }
});

// ✅ Root Route
app.get('/', (req, res) => {
  res.send('🚀 Bot is LIVE ✅');
});

// ✅ Start Server (FIXED)
const PORT = process.env.PORT;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Safe background load
  getProducts().catch(err => {
    console.error('❌ Initial product load failed:', err.message);
  });
});
