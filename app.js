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
    initCardList();
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
            exampleTranslation: card.exampleTranslation || '',
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

        setLoading(true);

        try {
            const result = await translateWord(word);
            pendingCard = {
                dutch: result.dutch,
                english: result.english,
                example: result.example,
                exampleTranslation: result.exampleTranslation
            };

            // Show preview
            previewCard.querySelector('.dutch-word').textContent = result.dutch;
            previewCard.querySelector('.english-word').textContent = result.english;
            previewCard.querySelector('.example-sentence').textContent = result.example;
            previewCard.querySelector('.example-translation').textContent = result.exampleTranslation;
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

// Translation API (MyMemory - free, no API key required)
async function translateWord(word) {
    // Get translation from MyMemory API
    const translationUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=nl|en`;
    const response = await fetch(translationUrl);

    if (!response.ok) {
        throw new Error('Translation service unavailable');
    }

    const data = await response.json();

    if (data.responseStatus !== 200) {
        throw new Error(data.responseDetails || 'Translation failed');
    }

    const english = data.responseData.translatedText;

    // Fetch real example sentence from Tatoeba (with English translation)
    let example = '';
    let exampleTranslation = '';
    try {
        const exampleData = await fetchExampleSentence(word);
        example = exampleData.dutch;
        exampleTranslation = exampleData.english;
    } catch {
        example = `Ik heb "${word}" vandaag geleerd.`;
        exampleTranslation = `I learned "${word}" today.`;
    }

    return {
        dutch: word,
        english: english,
        example: example,
        exampleTranslation: exampleTranslation
    };
}

// Fetch example sentence from Tatoeba (free sentence database)
async function fetchExampleSentence(word) {
    // Include translations in the response
    const url = `https://tatoeba.org/en/api_v0/search?from=nld&to=eng&query=${encodeURIComponent(word)}&limit=10&trans_filter=limit`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error('Could not fetch example');
    }

    const data = await response.json();

    if (data.results && data.results.length > 0) {
        // Find sentences that contain the exact word and have English translations
        const wordLower = word.toLowerCase();
        const matching = data.results.filter(r =>
            r.text.toLowerCase().includes(wordLower) &&
            r.translations && r.translations.length > 0 &&
            r.translations[0].length > 0
        );

        if (matching.length > 0) {
            // Pick a random matching sentence
            const sentence = matching[Math.floor(Math.random() * matching.length)];
            const englishTranslation = sentence.translations[0][0].text;
            return {
                dutch: sentence.text,
                english: englishTranslation
            };
        }
    }

    throw new Error('No examples found');
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
    reviewCard.querySelector('.example-translation').textContent = card.exampleTranslation || '';

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

// Settings - removed, no longer needed

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
