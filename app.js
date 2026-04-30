// Dutch Vocab App

// Database
// Bump this on each deploy so the visible UI version matches the service worker cache version.
const APP_VERSION = '2026.04.30.11';
// Cloudflare Worker proxy that holds the OpenAI key. Update after deploying worker/.
const WORKER_URL = 'https://dutchvocab-proxy.dutchvocab.workers.dev';
const DB_NAME = 'DutchVocabDB';
const DB_VERSION = 2;
const STORE_NAME = 'flashcards';
const DAILY_REVIEW_HOUR = 7;

let db = null;
let pendingCard = null;
let reviewQueue = [];
let currentReviewIndex = 0;

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
    initVersionBadge();
    await initDB();
    initTabs();
    initAddForm();
    initReview();
    initCardList();
    initBackupControls();
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
            // v2: wipe and recreate the store so every card starts with the OpenAI schema.
            if (database.objectStoreNames.contains(STORE_NAME)) {
                database.deleteObjectStore(STORE_NAME);
            }
            const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            store.createIndex('dutch', 'dutch', { unique: false });
            store.createIndex('nextReview', 'nextReview', { unique: false });
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
            exampleDutch: card.exampleDutch || '',
            exampleEnglish: card.exampleEnglish || '',
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

async function replaceAllCards(cards) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const clearRequest = store.clear();
        clearRequest.onerror = () => reject(clearRequest.error);
        clearRequest.onsuccess = () => {
            cards.forEach((card) => {
                store.put(card);
            });
        };

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
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

    // For "Again" (rating 1), re-show in the same session and schedule next day at 7am.
    // All persisted reviews are aligned to the daily morning review slot.
    if (rating === 1) {
        interval = 1;
    } else {
        interval = Math.max(1, interval);
    }
    interval = Math.round(interval * 1000) / 1000;

    return {
        ...card,
        stability,
        difficulty,
        reps: reps + 1,
        lastReview: now,
        nextReview: getNextMorningTimestamp(now, interval)
    };
}

function getNextMorningTimestamp(fromTimestamp, intervalDays) {
    const nextDate = new Date(fromTimestamp);
    nextDate.setDate(nextDate.getDate() + Math.max(1, Math.ceil(intervalDays)));
    nextDate.setHours(DAILY_REVIEW_HOUR, 0, 0, 0);
    return nextDate.getTime();
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

function initVersionBadge() {
    document.getElementById('app-version').textContent = `v${APP_VERSION}`;
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
                exampleDutch: result.exampleDutch,
                exampleEnglish: result.exampleEnglish
            };

            // Show preview
            previewCard.querySelector('.dutch-word').textContent = result.dutch;
            previewCard.querySelector('.english-word').textContent = result.english;
            renderExample(previewCard, result.exampleDutch, result.exampleEnglish);
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

// All translation + example sentence generation goes through the Cloudflare Worker proxy.
async function translateWord(word) {
    const response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word })
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Translation service error (${response.status}): ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    if (!data.english) throw new Error('Translation service returned no result');

    return {
        dutch: word,
        english: String(data.english).trim(),
        exampleDutch: data.dutch ? String(data.dutch).trim() : '',
        exampleEnglish: data.english_translation ? String(data.english_translation).trim() : ''
    };
}

// Review System
function initReview() {
    const reviewCard = document.getElementById('review-card');
    const reviewButtons = document.getElementById('review-buttons');

    reviewCard.addEventListener('click', () => {
        if (reviewCard.classList.contains('switching')) {
            return;
        }
        reviewCard.classList.toggle('flipped');
        if (reviewCard.classList.contains('flipped')) {
            reviewButtons.classList.remove('hidden');
        } else {
            reviewButtons.classList.add('hidden');
        }
    });

    // Rating buttons
    ['wrong', 'hard', 'good', 'easy'].forEach((rating, index) => {
        document.getElementById(`${rating}-btn`).addEventListener('click', async () => {
            const card = reviewQueue[currentReviewIndex];
            const updated = calculateNextReview(card, index);
            await updateCard(updated);

            // If "Again" (wrong), put card back at end of queue for immediate re-review
            if (index === 0) {
                reviewQueue.push(updated);
                document.getElementById('total-cards').textContent = reviewQueue.length;
            }

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

    // Disable the flip animation while resetting to the front side so the old
    // answer never flashes during the next card swap.
    reviewCard.classList.add('switching', 'no-animate');
    reviewCard.classList.remove('flipped');
    reviewButtons.classList.add('hidden');
    reviewCard.querySelector('.dutch-word').textContent = card.dutch;
    reviewCard.querySelector('.english-word').textContent = card.english;
    renderExample(reviewCard, card.exampleDutch, card.exampleEnglish);

    document.getElementById('current-card').textContent = currentReviewIndex + 1;
    progressFill.style.width = `${((currentReviewIndex) / reviewQueue.length) * 100}%`;

    void reviewCard.offsetHeight;

    requestAnimationFrame(() => {
        reviewCard.classList.remove('no-animate', 'switching');
    });
}

// Card List
function initCardList() {
    loadCardList();
}

function initBackupControls() {
    const exportBtn = document.getElementById('export-db-btn');
    const importBtn = document.getElementById('import-db-btn');
    const importInput = document.getElementById('import-db-input');

    exportBtn.addEventListener('click', exportBackup);
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', importBackup);
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

    listContainer.innerHTML = cards.map(card => {
        const exampleDutch = card.exampleDutch ? `<div class="list-card-example-dutch">${escapeHtml(card.exampleDutch)}</div>` : '';
        const exampleEnglish = card.exampleEnglish ? `<div class="list-card-example-english">${escapeHtml(card.exampleEnglish)}</div>` : '';
        return `
        <div class="list-card" data-id="${card.id}">
            <div class="list-card-content">
                <div class="list-card-dutch">${escapeHtml(card.dutch)}</div>
                <div class="list-card-english">${escapeHtml(card.english)}</div>
                ${exampleDutch}
                ${exampleEnglish}
            </div>
            <button class="list-card-delete" onclick="handleDeleteCard(${card.id})">🗑️</button>
        </div>`;
    }).join('');
}

function renderExample(cardEl, exampleDutch, exampleEnglish) {
    const dutchEl = cardEl.querySelector('.example-dutch');
    const englishEl = cardEl.querySelector('.example-english');
    if (!dutchEl || !englishEl) return;
    if (exampleDutch && exampleEnglish) {
        dutchEl.textContent = exampleDutch;
        englishEl.textContent = exampleEnglish;
        dutchEl.classList.remove('hidden');
        englishEl.classList.remove('hidden');
    } else {
        dutchEl.textContent = '';
        englishEl.textContent = '';
        dutchEl.classList.add('hidden');
        englishEl.classList.add('hidden');
    }
}

async function exportBackup() {
    const cards = await getAllCards();
    const payload = {
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        cards
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `dutch-vocab-backup-${timestamp}.json`;
    link.click();

    URL.revokeObjectURL(url);
    showToast(`Exported ${cards.length} cards`, 'success');
}

async function importBackup(event) {
    const file = event.target.files[0];
    event.target.value = '';

    if (!file) {
        return;
    }

    try {
        const text = await file.text();
        const payload = JSON.parse(text);

        if (!payload || !Array.isArray(payload.cards)) {
            throw new Error('Invalid backup file');
        }

        const existingCards = await getAllCards();
        if (existingCards.length > 0 && !confirm('Import will replace your current cards. Continue?')) {
            return;
        }

        await replaceAllCards(payload.cards.map(normalizeImportedCard));
        await loadCardList();
        await loadReviewCards();
        showToast(`Imported ${payload.cards.length} cards`, 'success');
    } catch (error) {
        showToast(error.message || 'Import failed', 'error');
    }
}

function normalizeImportedCard(card) {
    return {
        id: card.id,
        dutch: card.dutch || '',
        english: card.english || '',
        exampleDutch: card.exampleDutch || '',
        exampleEnglish: card.exampleEnglish || '',
        createdAt: Number(card.createdAt) || Date.now(),
        nextReview: Number(card.nextReview) || Date.now(),
        stability: Number(card.stability) || 0,
        difficulty: Number(card.difficulty) || 0,
        reps: Number(card.reps) || 0,
        lastReview: card.lastReview ? Number(card.lastReview) : null
    };
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
