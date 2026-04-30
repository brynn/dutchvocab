// Cloudflare Worker: dutchvocab-proxy
// Accepts POST { word: "..." } and forwards to OpenAI using the OPENAI_API_KEY secret.
// Restrict by Origin to mitigate abuse.

const ALLOWED_ORIGINS = new Set([
    'https://brynn.github.io',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
]);

const MODEL = 'gpt-4o-mini';

function corsHeaders(origin) {
    const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://brynn.github.io';
    return {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const headers = corsHeaders(origin);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers });
        }

        if (!ALLOWED_ORIGINS.has(origin)) {
            return new Response('Forbidden', { status: 403, headers });
        }

        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405, headers });
        }

        let body;
        try { body = await request.json(); }
        catch { return json({ error: 'Invalid JSON' }, 400, headers); }

        const word = (body.word || '').toString().trim();
        if (!word || word.length > 100) {
            return json({ error: 'Invalid word' }, 400, headers);
        }

        const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: MODEL,
                response_format: { type: 'json_object' },
                temperature: 0.6,
                messages: [
                    {
                        role: 'system',
                        content: 'You help Dutch vocabulary learners. Respond with JSON only.'
                    },
                    {
                        role: 'user',
                        content: `For the Dutch word "${word}", return JSON with: english (a short English gloss, 1-3 words), dutch (one short natural Dutch sentence, max 12 words, that uses the word in context), english_translation (English translation of that sentence).`
                    }
                ]
            })
        });

        if (!openAiResponse.ok) {
            const errText = await openAiResponse.text().catch(() => '');
            return json({ error: `OpenAI ${openAiResponse.status}`, detail: errText.slice(0, 300) }, 502, headers);
        }

        const data = await openAiResponse.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) return json({ error: 'Empty OpenAI response' }, 502, headers);

        let parsed;
        try { parsed = JSON.parse(content); }
        catch { return json({ error: 'Could not parse OpenAI response' }, 502, headers); }

        return json({
            english: (parsed.english || '').toString().trim(),
            dutch: (parsed.dutch || '').toString().trim(),
            english_translation: (parsed.english_translation || '').toString().trim()
        }, 200, headers);
    }
};

function json(obj, status, headers) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json' }
    });
}
