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

        try {
            console.log(`\n[Webhook] Received message from ${msg.from}: "${msg.body}"`);
            const history = await getChatHistory(msg.from);

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

            if (!messages.find(m => m.content === msg.body && m.role === 'user')) {
                messages.push({ role: 'user', content: msg.body });
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
            if (aiReply) await sendMessage(msg.from, aiReply);

        } catch (error) {
            console.error("Error processing message:", error);
        }
    }
});

app.listen(PORT, () => {
    console.log(`AI Bot listening on port ${PORT}`);
});