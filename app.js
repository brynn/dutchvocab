// Dutch Vocab App

// Database
const DB_NAME = 'DutchVocabDB';
const DB_VERSION = 1;
const STORE_NAME = 'flashcards';

let db = null;
let pendingCard = null;
let reviewQueue = [];
let currentReviewIndex = 0;

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    initTabs();
    initAddForm();
    initReview();
    initSettings();
    initCardList();

    // Check for API key on first load
    const apiKey = localStorage.getItem('claude_api_key');
    if (!apiKey) {
        showToast('Please set your Claude API key in settings', 'error');
        document.getElementById('settings-modal').classList.remove('hidden');
    }
});

// IndexedDB Setup
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('dutch', 'dutch', { unique: false });
                store.createIndex('nextReview', 'nextReview', { unique: false });
            }
        };
    });
}

// Card CRUD Operations
async function saveCard(card) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const cardData = {
            dutch: card.dutch,
            english: card.english,
            example: card.example,
            createdAt: Date.now(),
            nextReview: Date.now(),
            interval: 1, // days
            easeFactor: 2.5,
            repetitions: 0
        };

        const request = store.add(cardData);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getAllCards() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getCardsForReview() {
    const allCards = await getAllCards();
    const now = Date.now();
    return allCards.filter(card => card.nextReview <= now);
}

async function updateCard(card) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(card);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function deleteCard(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Spaced Repetition (SM-2 algorithm simplified)
function calculateNextReview(card, quality) {
    // quality: 0 = again, 1 = hard, 2 = good, 3 = easy
    let { interval, easeFactor, repetitions } = card;

    if (quality < 2) {
        // Failed - reset
        repetitions = 0;
        interval = 1;
    } else {
        // Passed
        if (repetitions === 0) {
            interval = 1;
        } else if (repetitions === 1) {
            interval = 6;
        } else {
            interval = Math.round(interval * easeFactor);
        }
        repetitions++;

        // Adjust ease factor
        easeFactor = easeFactor + (0.1 - (3 - quality) * (0.08 + (3 - quality) * 0.02));
        easeFactor = Math.max(1.3, easeFactor);
    }

    // Bonus for easy
    if (quality === 3) {
        interval = Math.round(interval * 1.3);
    }

    return {
        ...card,
        interval,
        easeFactor,
        repetitions,
        nextReview: Date.now() + interval * 24 * 60 * 60 * 1000
    };
}

// Tab Navigation
function initTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;

            // Update button states
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(`${tabName}-tab`).classList.add('active');

            // Refresh content
            if (tabName === 'review') {
                loadReviewCards();
            } else if (tabName === 'list') {
                loadCardList();
            }
        });
    });
}

// Add Word Form
function initAddForm() {
    const form = document.getElementById('add-form');
    const previewCard = document.getElementById('preview-card');
    const previewActions = document.getElementById('preview-actions');
    const saveBtn = document.getElementById('save-card-btn');
    const discardBtn = document.getElementById('discard-card-btn');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('word-input');
        const word = input.value.trim();

        if (!word) return;

        const apiKey = localStorage.getItem('claude_api_key');
        if (!apiKey) {
            showToast('Please set your API key in settings', 'error');
            document.getElementById('settings-modal').classList.remove('hidden');
            return;
        }

        setLoading(true);

        try {
            const result = await translateWord(word, apiKey);
            pendingCard = {
                dutch: result.dutch,
                english: result.english,
                example: result.example
            };

            // Show preview
            previewCard.querySelector('.dutch-word').textContent = result.dutch;
            previewCard.querySelector('.english-word').textContent = result.english;
            previewCard.querySelector('.example-sentence').textContent = result.example;
            previewCard.classList.remove('hidden', 'flipped');
            previewActions.classList.remove('hidden');

            input.value = '';
        } catch (error) {
            showToast(error.message || 'Failed to translate word', 'error');
        } finally {
            setLoading(false);
        }
    });

    previewCard.addEventListener('click', () => {
        previewCard.classList.toggle('flipped');
    });

    saveBtn.addEventListener('click', async () => {
        if (pendingCard) {
            await saveCard(pendingCard);
            showToast('Card saved!', 'success');
            previewCard.classList.add('hidden');
            previewActions.classList.add('hidden');
            pendingCard = null;
        }
    });

    discardBtn.addEventListener('click', () => {
        previewCard.classList.add('hidden');
        previewActions.classList.add('hidden');
        pendingCard = null;
    });
}

function setLoading(loading) {
    const btn = document.getElementById('add-btn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoading = btn.querySelector('.btn-loading');

    btn.disabled = loading;
    btnText.classList.toggle('hidden', loading);
    btnLoading.classList.toggle('hidden', !loading);
}

// Claude API
async function translateWord(word, apiKey) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 256,
            messages: [{
                role: 'user',
                content: `Translate the Dutch word "${word}" to English and provide an example sentence in Dutch that uses the word naturally.

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{"dutch":"${word}","english":"[translation]","example":"[Dutch example sentence]"}`
            }]
        })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    try {
        return JSON.parse(text);
    } catch {
        // Try to extract JSON from the response
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]);
        }
        throw new Error('Invalid response from API');
    }
}

// Review System
function initReview() {
    const reviewCard = document.getElementById('review-card');
    const reviewButtons = document.getElementById('review-buttons');

    reviewCard.addEventListener('click', () => {
        reviewCard.classList.toggle('flipped');
        if (reviewCard.classList.contains('flipped')) {
            reviewButtons.classList.remove('hidden');
        }
    });

    // Rating buttons
    ['wrong', 'hard', 'good', 'easy'].forEach((rating, index) => {
        document.getElementById(`${rating}-btn`).addEventListener('click', async () => {
            const card = reviewQueue[currentReviewIndex];
            const updated = calculateNextReview(card, index);
            await updateCard(updated);

            currentReviewIndex++;
            showNextCard();
        });
    });
}

async function loadReviewCards() {
    reviewQueue = await getCardsForReview();
    currentReviewIndex = 0;

    const emptyState = document.getElementById('review-empty');
    const reviewArea = document.getElementById('review-area');

    if (reviewQueue.length === 0) {
        emptyState.classList.remove('hidden');
        reviewArea.classList.add('hidden');
    } else {
        emptyState.classList.add('hidden');
        reviewArea.classList.remove('hidden');
        document.getElementById('total-cards').textContent = reviewQueue.length;
        showNextCard();
    }
}

function showNextCard() {
    const reviewCard = document.getElementById('review-card');
    const reviewButtons = document.getElementById('review-buttons');
    const progressFill = document.querySelector('.progress-fill');

    if (currentReviewIndex >= reviewQueue.length) {
        // Review complete
        showToast('Review session complete!', 'success');
        loadReviewCards();
        return;
    }

    const card = reviewQueue[currentReviewIndex];

    // Update UI
    reviewCard.classList.remove('flipped');
    reviewButtons.classList.add('hidden');
    reviewCard.querySelector('.dutch-word').textContent = card.dutch;
    reviewCard.querySelector('.english-word').textContent = card.english;
    reviewCard.querySelector('.example-sentence').textContent = card.example;

    document.getElementById('current-card').textContent = currentReviewIndex + 1;
    progressFill.style.width = `${((currentReviewIndex) / reviewQueue.length) * 100}%`;
}

// Card List
function initCardList() {
    loadCardList();
}

async function loadCardList() {
    const cards = await getAllCards();
    const listContainer = document.getElementById('card-list');
    const emptyState = document.getElementById('list-empty');

    if (cards.length === 0) {
        emptyState.classList.remove('hidden');
        listContainer.innerHTML = '';
        return;
    }

    emptyState.classList.add('hidden');

    // Sort by creation date (newest first)
    cards.sort((a, b) => b.createdAt - a.createdAt);

    listContainer.innerHTML = cards.map(card => `
        <div class="list-card" data-id="${card.id}">
            <div class="list-card-content">
                <div class="list-card-dutch">${escapeHtml(card.dutch)}</div>
                <div class="list-card-english">${escapeHtml(card.english)}</div>
            </div>
            <button class="list-card-delete" onclick="handleDeleteCard(${card.id})">🗑️</button>
        </div>
    `).join('');
}

async function handleDeleteCard(id) {
    if (confirm('Delete this card?')) {
        await deleteCard(id);
        showToast('Card deleted', 'success');
        loadCardList();
    }
}

// Settings
function initSettings() {
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    const settingsForm = document.getElementById('settings-form');
    const cancelBtn = document.getElementById('cancel-settings');
    const apiKeyInput = document.getElementById('api-key');

    // Load saved key
    const savedKey = localStorage.getItem('claude_api_key');
    if (savedKey) {
        apiKeyInput.value = savedKey;
    }

    settingsBtn.addEventListener('click', () => {
        settingsModal.classList.remove('hidden');
    });

    cancelBtn.addEventListener('click', () => {
        settingsModal.classList.add('hidden');
    });

    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) {
            settingsModal.classList.add('hidden');
        }
    });

    settingsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const apiKey = apiKeyInput.value.trim();

        if (apiKey) {
            localStorage.setItem('claude_api_key', apiKey);
            showToast('API key saved', 'success');
        } else {
            localStorage.removeItem('claude_api_key');
        }

        settingsModal.classList.add('hidden');
    });
}

// Toast Notifications
function showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');

    setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}

// Utility
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Register service worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.log('ServiceWorker registration failed:', err);
        });
    });
}
