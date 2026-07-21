import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import OpenAI from 'openai';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const OPENWA_API_URL = process.env.OPENWA_API_URL || 'http://localhost:2785';
const OPENWA_API_KEY = process.env.OPENWA_API_KEY || '';
const SESSION_ID = process.env.OPENWA_SESSION_ID || '';

const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY
});

// Load knowledge base
let knowledgeBase = '';
try {
    const dataPath = fs.existsSync('data.private.md') ? 'data.private.md' : 'data.md';
    knowledgeBase = fs.readFileSync(dataPath, 'utf-8');
} catch (error) {
    console.error("Could not read knowledge base:", error.message);
}

// Load system prompt template
let systemPromptTemplate = '';
try {
    const promptPath = fs.existsSync('system_prompt.private.txt') ? 'system_prompt.private.txt' : 'system_prompt.txt';
    systemPromptTemplate = fs.readFileSync(promptPath, 'utf-8');
} catch (error) {
    console.error("Could not read system prompt template:", error.message);
}

// Generate dynamic system prompt based on chat state
const getSystemPrompt = (isFirstMessage) => {
    const greeting = isFirstMessage 
        ? '5. INITIAL GREETING MANDATE: You MUST begin your response with EXACTLY: "আসসালামু আলাইকুম! আমি ওলামা, বে রাইডের একজন এআই সহকারী। চাঁদের গাড়ি বা বাইক ভাড়া বিষয়ে আমি সাহায্য করতে পারি।"' 
        : '5. Do not re-introduce yourself. Answer the user directly.';
    
    return systemPromptTemplate
        .replace('{{INITIAL_GREETING}}', greeting)
        .replace('{{KNOWLEDGE_BASE}}', knowledgeBase);
};

// Shared AI engine processing function
async function processChatMessage(chatId, messageText, historySource, replyCallback) {
    try {
        console.log(`\n[AI Engine] Processing message from ${chatId}: "${messageText}"`);
        const history = await historySource();

        // Filter only text messages with content and ignore booking confirmation replies
        const textHistory = history.filter(h => h.type === 'text' && h.body && !(h.fromMe && h.body.includes('ধন্যবাদ! আমাদের একজন')));

        // Determine if this is a brand new conversation
        const isFirstMessage = textHistory.length <= 1;

        const messages = [{ role: 'system', content: getSystemPrompt(isFirstMessage) }];

        for (const h of textHistory) {
            messages.push({
                role: h.fromMe ? 'assistant' : 'user',
                content: h.body
            });
        }

        if (!messages.find(m => m.content === messageText && m.role === 'user')) {
            messages.push({ role: 'user', content: messageText });
        }

        console.log(`Sending to OpenAI API with ${messages.length} messages...`);
        console.log("Context Messages:", JSON.stringify(messages, null, 2));

        const chatCompletion = await openai.chat.completions.create({
            messages,
            model: 'meta-llama/llama-3.3-70b-instruct',
            temperature: 0.3, // Lowered temperature to prevent hallucination 
            max_tokens: 2048,
        });

        const choice = chatCompletion.choices[0];
        const aiReply = choice?.message?.content;
        console.log(`[AI Reply]: "${aiReply}"`);
        console.log(`Finish Reason: ${choice?.finish_reason}, Usage: ${JSON.stringify(chatCompletion.usage)}`);
        
        if (aiReply) {
            await replyCallback(aiReply);
        }
    } catch (error) {
        console.error("Error processing message:", error);
    }
}

// === WhatsApp (OpenWA) Webhook & Helpers ===

async function getChatHistory(chatId) {
    if (!SESSION_ID || !OPENWA_API_KEY) return [];
    try {
        const url = `${OPENWA_API_URL}/api/sessions/${SESSION_ID}/messages/${chatId}/history?limit=10`;
        const res = await fetch(url, { headers: { 'x-api-key': OPENWA_API_KEY } });
        if (!res.ok) return [];
        return await res.json();
    } catch (err) {
        return [];
    }
}

async function sendMessage(chatId, text) {
    if (!SESSION_ID || !OPENWA_API_KEY) return;
    try {
        const url = `${OPENWA_API_URL}/api/sessions/${SESSION_ID}/messages/send-text`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': OPENWA_API_KEY },
            body: JSON.stringify({ chatId, text })
        });
        if (!res.ok) {
            console.error(`Failed to send message: ${res.status} ${res.statusText}`);
        } else {
            console.log(`Reply successfully sent to ${chatId}`);
        }
    } catch (err) {
        console.error("Error sending message:", err);
    }
}

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const { event, data: msg } = req.body;

    if (event === 'message.received' && !msg.fromMe && !msg.isGroup && !msg.isStatusBroadcast) {
        const mediaTypes = ['image', 'video', 'audio', 'voice', 'document', 'sticker', 'location'];
        
        if (msg.type !== 'text') {
            // Only send the fallback if it's actual user media (image, audio, voice, etc.)
            if (mediaTypes.includes(msg.type)) {
                await sendMessage(msg.from, "আমি ওলামা, বে রাইডের একজন এআই সহকারী। আমি অডিও বা ছবি দেখতে পারি না। একজন হিউম্যান ম্যানেজার শীঘ্রই আপনাকে সাহায্য করবেন।");
            }
            // Completely ignore system notifications, revoked messages, and other events
            return;
        }

        await processChatMessage(
            msg.from,
            msg.body,
            () => getChatHistory(msg.from),
            (reply) => sendMessage(msg.from, reply)
        );
    }
});

// === Facebook Messenger Webhook & Helpers ===

const messengerHistory = {};

function getMessengerHistory(senderId) {
    if (!messengerHistory[senderId]) {
        messengerHistory[senderId] = [];
    }
    return messengerHistory[senderId];
}

function addMessengerHistory(senderId, body, fromMe) {
    const history = getMessengerHistory(senderId);
    history.push({
        type: 'text',
        body: body,
        fromMe: fromMe
    });
    // Limit history to last 10 messages
    if (history.length > 10) {
        history.shift();
    }
}

app.get('/messenger-webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.MESSENGER_VERIFY_TOKEN) {
            console.log('Messenger Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

app.post('/messenger-webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED');

        for (const entry of body.entry) {
            const webhookEvent = entry.messaging[0];
            const senderId = webhookEvent.sender.id;
            const message = webhookEvent.message;

            if (message && message.text) {
                const userMessage = message.text;
                console.log(`\n[Messenger Webhook] Received message from ${senderId}: "${userMessage}"`);

                await processChatMessage(
                    senderId,
                    userMessage,
                    async () => {
                        const history = getMessengerHistory(senderId);
                        // Add the user message to history before processing (to mimic WhatsApp's behavior)
                        if (!history.find(h => h.body === userMessage && !h.fromMe)) {
                            addMessengerHistory(senderId, userMessage, false);
                        }
                        return getMessengerHistory(senderId);
                    },
                    async (reply) => {
                        await sendMessengerMessage(senderId, reply);
                        addMessengerHistory(senderId, reply, true);
                    }
                );
            }
        }
    } else {
        res.sendStatus(404);
    }
});

async function sendMessengerMessage(recipientId, text) {
    const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
    if (!PAGE_ACCESS_TOKEN) {
        console.error("MESSENGER_PAGE_ACCESS_TOKEN is not configured.");
        return;
    }
    try {
        const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: recipientId },
                message: { text: text }
            })
        });
        if (!res.ok) {
            const errBody = await res.text();
            console.error(`Failed to send Messenger message: ${res.status} ${res.statusText}`, errBody);
        } else {
            console.log(`Messenger reply successfully sent to ${recipientId}`);
        }
    } catch (err) {
        console.error("Error sending Messenger message:", err);
    }
}

// === Server Startup ===

app.listen(PORT, () => {
    console.log(`AI Bot listening on port ${PORT}`);
});