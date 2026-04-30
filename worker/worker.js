// Cloudflare Worker: dutchvocab-proxy
// Routes:
//   POST   /translate           -> OpenAI proxy (translation + example sentence)
//   GET    /cards                -> list all cards
//   POST   /cards                -> create a card (body: card without id), returns full card
//   PUT    /cards/:id            -> update a card
//   DELETE /cards/:id            -> delete a card
//   POST   /cards/bulk-replace   -> replace ALL cards (for backup import)

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
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const headers = corsHeaders(origin);
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers });
        }

        if (!ALLOWED_ORIGINS.has(origin)) {
            return new Response('Forbidden', { status: 403, headers });
        }

        try {
            if (url.pathname === '/translate' && request.method === 'POST') {
                return await handleTranslate(request, env, headers);
            }
            if (url.pathname === '/cards' && request.method === 'GET') {
                return await listCards(env, headers);
            }
            if (url.pathname === '/cards' && request.method === 'POST') {
                return await createCard(request, env, headers);
            }
            if (url.pathname === '/cards/bulk-replace' && request.method === 'POST') {
                return await bulkReplaceCards(request, env, headers);
            }
            const cardMatch = url.pathname.match(/^\/cards\/(\d+)$/);
            if (cardMatch) {
                const id = Number(cardMatch[1]);
                if (request.method === 'PUT') return await updateCard(id, request, env, headers);
                if (request.method === 'DELETE') return await deleteCard(id, env, headers);
            }
            return new Response('Not found', { status: 404, headers });
        } catch (err) {
            return json({ error: err.message || 'Internal error' }, 500, headers);
        }
    }
};

async function handleTranslate(request, env, headers) {
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
                { role: 'system', content: 'You help Dutch vocabulary learners. Respond with JSON only.' },
                { role: 'user', content: `For the Dutch word "${word}", return JSON with: english (a short English gloss, 1-3 words), dutch (one short natural Dutch sentence, max 12 words, that uses the word in context), english_translation (English translation of that sentence).` }
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

async function listCards(env, headers) {
    const result = await env.DB.prepare('SELECT * FROM cards ORDER BY createdAt DESC').all();
    return json(result.results || [], 200, headers);
}

async function createCard(request, env, headers) {
    const body = await request.json();
    const card = sanitizeCard(body);
    const result = await env.DB.prepare(
        'INSERT INTO cards (dutch, english, exampleDutch, exampleEnglish, createdAt, nextReview, stability, difficulty, reps, lastReview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
    ).bind(
        card.dutch, card.english, card.exampleDutch, card.exampleEnglish,
        card.createdAt, card.nextReview, card.stability, card.difficulty, card.reps, card.lastReview
    ).first();
    return json(result, 200, headers);
}

async function updateCard(id, request, env, headers) {
    const body = await request.json();
    const card = sanitizeCard(body);
    const result = await env.DB.prepare(
        'UPDATE cards SET dutch=?, english=?, exampleDutch=?, exampleEnglish=?, createdAt=?, nextReview=?, stability=?, difficulty=?, reps=?, lastReview=? WHERE id=? RETURNING *'
    ).bind(
        card.dutch, card.english, card.exampleDutch, card.exampleEnglish,
        card.createdAt, card.nextReview, card.stability, card.difficulty, card.reps, card.lastReview,
        id
    ).first();
    if (!result) return json({ error: 'Card not found' }, 404, headers);
    return json(result, 200, headers);
}

async function deleteCard(id, env, headers) {
    await env.DB.prepare('DELETE FROM cards WHERE id=?').bind(id).run();
    return json({ ok: true }, 200, headers);
}

async function bulkReplaceCards(request, env, headers) {
    const body = await request.json();
    if (!Array.isArray(body.cards)) {
        return json({ error: 'Body must be { cards: [...] }' }, 400, headers);
    }
    const stmts = [env.DB.prepare('DELETE FROM cards')];
    const insert = env.DB.prepare(
        'INSERT INTO cards (dutch, english, exampleDutch, exampleEnglish, createdAt, nextReview, stability, difficulty, reps, lastReview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const raw of body.cards) {
        const c = sanitizeCard(raw);
        stmts.push(insert.bind(c.dutch, c.english, c.exampleDutch, c.exampleEnglish, c.createdAt, c.nextReview, c.stability, c.difficulty, c.reps, c.lastReview));
    }
    await env.DB.batch(stmts);
    return json({ ok: true, count: body.cards.length }, 200, headers);
}

function sanitizeCard(raw) {
    const now = Date.now();
    return {
        dutch: String(raw.dutch || '').trim(),
        english: String(raw.english || '').trim(),
        exampleDutch: String(raw.exampleDutch || '').trim(),
        exampleEnglish: String(raw.exampleEnglish || '').trim(),
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
        nextReview: Number.isFinite(raw.nextReview) ? raw.nextReview : now,
        stability: Number.isFinite(raw.stability) ? raw.stability : 0,
        difficulty: Number.isFinite(raw.difficulty) ? raw.difficulty : 0,
        reps: Number.isFinite(raw.reps) ? raw.reps : 0,
        lastReview: Number.isFinite(raw.lastReview) ? raw.lastReview : null
    };
}

function json(obj, status, headers) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json' }
    });
}
