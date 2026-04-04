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

async function getProducts() {
  if (!SHEET_URL) return [];
  if (Date.now() - lastFetch < 10 * 60 * 1000) return cachedProducts;
  try {
    const res = await axios.get(SHEET_URL);
    const rows = res.data.trim().split('\n')
      .map(r => r.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
    cachedProducts = rows.slice(1).filter(r => r[0]).map(r => ({
      name: r[0] || '', price: r[1] || '',
      discount: r[2] || (r[1] ? Math.round(parseFloat(r[1]) * 0.95) + '' : ''),
      desc: r[3] || '', image: r[4] || '', video: r[5] || ''
    }));
    lastFetch = Date.now();
    console.log(`✅ ${cachedProducts.length} products loaded from Sheet`);
  } catch (e) {
    console.error('Sheet fetch error:', e.message);
  }
  return cachedProducts;
}

const conversations = {};

async function getAIReply(senderId, userMsg) {
  const products = await getProducts();
  const productContext = products.length > 0
    ? '\n\nPRODUCT DATABASE:\n' + products.map(p =>
        `Name: ${p.name} | Price: ${p.price}TK | Discount: ${p.discount}TK | Desc: ${p.desc} | Image: ${p.image} | Video: ${p.video}`
      ).join('\n')
    : '';

  const systemPrompt = `You are a friendly AI sales assistant for "Global China Trading" Facebook page.

LANGUAGE RULES:
- Detect language: Bangla, English, or Banglish
- Always reply in the SAME style as the customer

PRODUCT FORMAT (when showing product):
📦 পণ্যের নাম: [name]
💰 দাম: [price]৳
🔥 ডিসকাউন্ট (5% ছাড়): [discount]৳
📝 বিবরণ: [desc]
🖼️ ছবি: [image]
🎥 ভিডিও: [video]
👉 Order করতে চান?

ORDER INTENT (order/নিব/কিনব/buy/চাই):
Reply with:
🛒 Global China Trading
অর্ডার কনফার্ম করতে নিচের তথ্য দিন:
নাম:
ফোন:
জেলা:
থানা:
বিস্তারিত ঠিকানা:

RULES:
- Max 3 products at once
- Always guide toward order
- If not found: "দুঃখিত, এই পণ্যটি নেই। অন্য কিছু দেখাবো?"
- After product, suggest 1 related product
- Keep replies short and sales-focused${productContext}`;

  if (!conversations[senderId]) conversations[senderId] = [];
  conversations[senderId].push({ role: 'user', content: userMsg });
  if (conversations[senderId].length > 10) conversations[senderId].splice(0, 2);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversations[senderId]
  ];

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages, max_tokens: 600, temperature: 0.7 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const reply = res.data.choices[0].message.content;
  conversations[senderId].push({ role: 'assistant', content: reply });
  return reply;
}

async function sendMessage(recipientId, messageText) {
  const chunks = messageText.match(/.{1,1900}(\s|$)/gs) || [messageText];
  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
        { recipient: { id: recipientId }, message: { text: chunk.trim() } }
      );
      console.log(`✅ Message sent to ${recipientId}`);
    } catch (error) {
      console.error('Send error:', error.response?.data || error.message);
    }
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  const body = req.body;
  if (body.object !== 'page') return;
  for (const entry of body.entry) {
    const event = entry.messaging[0];
    if (!event) continue;
    const senderId = event.sender.id;
    const messageText = event.message?.text;
    if (!messageText) continue;
    console.log(`📩 From ${senderId}: ${messageText}`);
    try {
      const reply = await getAIReply(senderId, messageText);
      await sendMessage(senderId, reply);
    } catch (e) {
      console.error('AI Error:', e.response?.data || e.message);
      await sendMessage(senderId, 'দুঃখিত, একটু সমস্যা হয়েছে। আবার চেষ্টা করুন। 🙏');
    }
  }
});

app.get('/', (req, res) => {
  res.send('🚀 Global China Trading AI Bot is running! ✅');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  getProducts();
});
