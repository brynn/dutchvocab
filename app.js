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
            createdAt: Date.now(),
            nextReview: Date.now(),
            // FSRS parameters
            stability: 0,      // How long memory lasts (days)
            difficulty: 0,     // Card difficulty (1-10)
            reps: 0,           // Number of reviews
            lastReview: null   // Timestamp of last review
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

// FSRS-4.5 Algorithm (Free Spaced Repetition Scheduler)
// Based on memory research - more accurate than SM-2

const FSRS = {
    // Default parameters (from FSRS research)
    w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],

    // Desired retention rate (90% = you'll remember 90% of cards when they come up)
    requestedRetention: 0.9,

    // Calculate initial stability based on first rating
    initStability(rating) {
        // rating: 1=again, 2=hard, 3=good, 4=easy
        return this.w[rating - 1];
    },

    // Calculate initial difficulty based on first rating
    initDifficulty(rating) {
        return Math.min(10, Math.max(1,
            this.w[4] - (rating - 3) * this.w[5]
        ));
    },

    // Update difficulty after review
    nextDifficulty(d, rating) {
        const nextD = d - this.w[6] * (rating - 3);
        // Mean reversion to keep difficulty from extremes
        return Math.min(10, Math.max(1,
            this.w[7] * this.initDifficulty(4) + (1 - this.w[7]) * nextD
        ));
    },

    // Calculate retrievability (probability of recall)
    retrievability(stability, elapsedDays) {
        return Math.pow(1 + elapsedDays / (9 * stability), -1);
    },

    // Calculate next stability after successful recall
    nextStability(d, s, r, rating) {
        const hardPenalty = rating === 2 ? this.w[15] : 1;
        const easyBonus = rating === 4 ? this.w[16] : 1;

        return s * (1 +
            Math.exp(this.w[8]) *
            (11 - d) *
            Math.pow(s, -this.w[9]) *
            (Math.exp((1 - r) * this.w[10]) - 1) *
            hardPenalty *
            easyBonus
        );
    },

    // Calculate stability after forgetting (rating = 1)
    nextStabilityAfterFail(d, s, r) {
        return this.w[11] *
            Math.pow(d, -this.w[12]) *
            (Math.pow(s + 1, this.w[13]) - 1) *
            Math.exp((1 - r) * this.w[14]);
    },

    // Calculate days until next review based on stability
    nextInterval(stability) {
        return stability * 9 * (1 / this.requestedRetention - 1);
    }
};

function calculateNextReview(card, quality) {
    // quality: 0=again, 1=hard, 2=good, 3=easy
    // Convert to FSRS rating: 1=again, 2=hard, 3=good, 4=easy
    const rating = quality + 1;

    const now = Date.now();
    let { stability, difficulty, reps, lastReview } = card;

    // Calculate elapsed time since last review
    const elapsedDays = lastReview ? (now - lastReview) / (24 * 60 * 60 * 1000) : 0;

    if (reps === 0) {
        // First review - initialize FSRS parameters
        stability = FSRS.initStability(rating);
        difficulty = FSRS.initDifficulty(rating);
    } else {
        // Calculate current retrievability
        const r = FSRS.retrievability(stability, elapsedDays);

        // Update difficulty
        difficulty = FSRS.nextDifficulty(difficulty, rating);

        // Update stability based on whether recall was successful
        if (rating === 1) {
            // Forgot - use failure formula
            stability = FSRS.nextStabilityAfterFail(difficulty, stability, r);
        } else {
            // Remembered - use success formula
            stability = FSRS.nextStability(difficulty, stability, r, rating);
        }
    }

    // Calculate next interval
    let interval = FSRS.nextInterval(stability);

    // Minimum 1 day, round to reasonable precision
    interval = Math.max(1, Math.round(interval * 10) / 10);

    return {
        ...card,
        stability,
        difficulty,
        reps: reps + 1,
        lastReview: now,
        nextReview: now + interval * 24 * 60 * 60 * 1000
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
                english: result.english
            };

            // Show preview
            previewCard.querySelector('.dutch-word').textContent = result.dutch;
            previewCard.querySelector('.english-word').textContent = result.english;
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

// Translation API - tries multiple services for best results
async function translateWord(word) {
    let english = null;

    // Try Lingva Translate first (Google Translate mirror)
    try {
        const lingvaUrl = `https://lingva.ml/api/v1/nl/en/${encodeURIComponent(word)}`;
        const lingvaResponse = await fetch(lingvaUrl);
        if (lingvaResponse.ok) {
            const lingvaData = await lingvaResponse.json();
            if (lingvaData.translation) {
                english = lingvaData.translation;
            }
        }
    } catch {
        // Fall through to backup
    }

    // Fallback to MyMemory if Lingva fails
    if (!english) {
        const translationUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=nl|en`;
        const response = await fetch(translationUrl);

        if (!response.ok) {
            throw new Error('Translation service unavailable');
        }

        const data = await response.json();

        if (data.responseStatus !== 200) {
            throw new Error(data.responseDetails || 'Translation failed');
        }

        english = data.responseData.translatedText;
    }

    return {
        dutch: word,
        english: english
    };
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
