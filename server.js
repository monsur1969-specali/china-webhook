const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'globalchinatrading2024';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_URL = process.env.SHEET_URL;

// ── Product cache (10 min) ─────────────────────────────
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
      name:     r[0] || '',
      price:    r[1] || '',
      discount: r[2] || (r[1] ? Math.round(parseFloat(r[1]) * 0.95) + '৳' : ''),
      desc:     r[3] || '',
      image:    r[4] || '',
      video:    r[5] || ''
    }));
    lastFetch = Date.now();
    console.log(`✅ ${cachedProducts.length} products loaded from Sheet`);
  } catch (e) {
    console.error('Sheet fetch error:', e.message);
  }
  return cachedProducts;
}

// ── Conversation memory (per user) ────────────────────
const conversations = {};

// ── Gemini AI reply ───────────────────────────────────
async function getAIReply(senderId, userMsg) {
  const products = await getProducts();

  const productContext = products.length > 0
    ? '\n\nPRODUCT DATABASE (Google Sheet থেকে):\n' +
      products.map(p =>
        `পণ্য: ${p.name} | দাম: ${p.price}৳ | ডিসকাউন্ট: ${p.discount} | বিবরণ: ${p.desc} | ছবি: ${p.image} | ভিডিও: ${p.video}`
      ).join('\n')
    : '\n\nNote: এখন কোনো product sheet connect করা নেই।';

  const systemPrompt = `তুমি "Global China Trading" Facebook Page-এর AI Sales Assistant।

ভাষার নিয়ম:
- Customer যেভাবে লেখে সেভাবে reply দাও (বাংলা/English/Banglish)
- সংক্ষিপ্ত, বন্ধুত্বপূর্ণ এবং sales-focused থাকো

পণ্য দেখানোর format (অবশ্যই এই format ব্যবহার করো):
📦 পণ্যের নাম: [name]
💰 দাম: [price]৳
🔥 ডিসকাউন্ট (5% ছাড়): [discount]
📝 বিবরণ: [desc]
🖼️ ছবি: [image]
🎥 ভিডিও: [video]
👉 Order করতে চান?

Order intent detect হলে (order, নিব, কিনব, buy, চাই, নেব):
🛒 Global China Trading
অর্ডার কনফার্ম করতে নিচের তথ্য দিন:
নাম:
ফোন:
জেলা:
থানা:
বিস্তারিত ঠিকানা:

নিয়ম:
- একসাথে সর্বোচ্চ ৩টা পণ্য দেখাও
- সবসময় order-এর দিকে guide করো
- পণ্য না পেলে: "দুঃখিত, এই পণ্যটি নেই। অন্য কিছু দেখাবো?"
- পণ্য দেখানোর পর ১টা related পণ্য suggest করো
- reply সংক্ষিপ্ত রাখো${productContext}`;

  // conversation history (last 10 turns)
  if (!conversations[senderId]) conversations[senderId] = [];
  conversations[senderId].push({ role: 'user', parts: [{ text: userMsg }] });
  if (conversations[senderId].length > 10) conversations[senderId].splice(0, 2);

  const requestBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: conversations[senderId]
  };

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    requestBody,
    { headers: { 'Content-Type': 'application/json' } }
  );

  const reply = res.data.candidates[0].content.parts[0].text;
  conversations[senderId].push({ role: 'model', parts: [{ text: reply }] });
  return reply;
}

// ── Facebook send message ─────────────────────────────
async function sendMessage(recipientId, messageText) {
  // Facebook max 2000 chars — split if needed
  const chunks = messageText.match(/.{1,1900}(\s|$)/gs) || [messageText];
  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
        {
          recipient: { id: recipientId },
          message: { text: chunk.trim() }
        }
      );
      console.log(`✅ Message sent to ${recipientId}`);
    } catch (error) {
      console.error('Send error:', error.response?.data || error.message);
    }
  }
}

// ── Webhook verify ────────────────────────────────────
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

// ── Webhook receive ───────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED'); // quick response to Facebook

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

// ── Health check ──────────────────────────────────────
app.get('/', (req, res) => {
  res.send('🚀 Global China Trading AI Bot is running! ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  getProducts(); // preload products on start
});
