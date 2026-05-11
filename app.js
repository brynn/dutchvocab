// Dutch Vocab App

const APP_VERSION = '2026.05.11.15';
// Cloudflare Worker that proxies OpenAI and stores cards in D1.
const WORKER_URL = 'https://dutchvocab-proxy.dutchvocab.workers.dev';
const DAILY_REVIEW_HOUR = 7;

let pendingCard = null;
let reviewQueue = [];
let currentReviewIndex = 0;
let currentReviewMode = 'all';

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
    initVersionBadge();
    initTabs();
    initAddForm();
    initReview();
    initCardList();
    initBackupControls();
    initLegend();
    initCardViewModal();
    initStarterWords();
});

// Card CRUD operations - all backed by the Worker / D1.
async function workerFetch(path, options = {}) {
    const response = await fetch(`${WORKER_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const error = new Error(data.message || `${response.status} ${response.statusText}`);
        error.code = data.error;
        throw error;
    }
    if (response.status === 204) return null;
    return response.json();
}

async function saveCard(card) {
    const now = Date.now();
    const payload = {
        dutch: card.dutch,
        english: card.english,
        partOfSpeech: card.partOfSpeech || 'other',
        exampleDutch: card.exampleDutch || '',
        exampleEnglish: card.exampleEnglish || '',
        createdAt: now,
        nextReview: now,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lastReview: null
    };
    const created = await workerFetch('/cards', { method: 'POST', body: JSON.stringify(payload) });
    return created.id;
}

// Generate additional drill cards for nouns (de/het) and verbs (tenses)
async function generateDrillCards(card) {
    const drillCards = [];

    // For nouns: create a de/het drill card
    if (card.partOfSpeech === 'noun' && card.article) {
        drillCards.push({
            dutch: `de of het? ${card.dutch}`,
            english: `${card.article} ${card.dutch} (${card.english})`,
            partOfSpeech: 'article-drill',
            exampleDutch: '',
            exampleEnglish: ''
        });
    }

    // For verbs: create tense drill cards
    if (card.partOfSpeech === 'verb' && card.conjugations) {
        const { present, presentExample, presentExampleEnglish, past, pastExample, pastExampleEnglish, perfect, perfectExample, perfectExampleEnglish } = card.conjugations;
        // Only mark past and perfect as irregular (present tense follows regular patterns)
        const irregularSuffix = card.isIrregular ? '-irregular' : '';

        if (present) {
            drillCards.push({
                dutch: `tegenwoordige tijd (present): ${card.dutch}`,
                english: present,
                partOfSpeech: 'verb-present',
                exampleDutch: presentExample || '',
                exampleEnglish: presentExampleEnglish || ''
            });
        }
        if (past) {
            drillCards.push({
                dutch: `verleden tijd (past): ${card.dutch}`,
                english: past,
                partOfSpeech: `verb-past${irregularSuffix}`,
                exampleDutch: pastExample || '',
                exampleEnglish: pastExampleEnglish || ''
            });
        }
        if (perfect) {
            drillCards.push({
                dutch: `voltooid deelwoord (perfect): ${card.dutch}`,
                english: perfect,
                partOfSpeech: `verb-perfect${irregularSuffix}`,
                exampleDutch: perfectExample || '',
                exampleEnglish: perfectExampleEnglish || ''
            });
        }
    }

    // Save all drill cards
    for (const drillCard of drillCards) {
        try {
            await saveCard(drillCard);
        } catch (e) {
            // Ignore duplicates for drill cards
            if (e.code !== 'duplicate') throw e;
        }
    }

    return drillCards.length;
}

async function getAllCards() {
    return workerFetch('/cards');
}

async function replaceAllCards(cards) {
    return workerFetch('/cards/bulk-replace', {
        method: 'POST',
        body: JSON.stringify({ cards })
    });
}

async function getCardsForReview() {
    const allCards = await getAllCards();
    const now = Date.now();
    return allCards.filter(card => card.nextReview <= now);
}

async function updateCard(card) {
    if (!card.id) throw new Error('updateCard requires card.id');
    return workerFetch(`/cards/${card.id}`, { method: 'PUT', body: JSON.stringify(card) });
}

async function deleteCard(id) {
    return workerFetch(`/cards/${id}`, { method: 'DELETE' });
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
    const previewContainer = document.getElementById('preview-cards-container');
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
                partOfSpeech: result.partOfSpeech,
                exampleDutch: result.exampleDutch,
                exampleEnglish: result.exampleEnglish,
                article: result.article,
                conjugations: result.conjugations,
                isIrregular: result.isIrregular
            };

            // Build list of all cards that will be created
            const allCards = [pendingCard];

            // Add drill cards for nouns
            if (result.partOfSpeech === 'noun' && result.article) {
                allCards.push({
                    dutch: `de of het? ${result.dutch}`,
                    english: `${result.article} ${result.dutch} (${result.english})`,
                    partOfSpeech: 'article-drill',
                    exampleDutch: '',
                    exampleEnglish: ''
                });
            }

            // Add drill cards for verbs
            if (result.partOfSpeech === 'verb' && result.conjugations) {
                const { present, presentExample, presentExampleEnglish, past, pastExample, pastExampleEnglish, perfect, perfectExample, perfectExampleEnglish } = result.conjugations;
                // Only mark past and perfect as irregular (present tense follows regular patterns)
                const irregularSuffix = result.isIrregular ? '-irregular' : '';

                if (present) {
                    allCards.push({
                        dutch: `tegenwoordige tijd (present): ${result.dutch}`,
                        english: present,
                        partOfSpeech: 'verb-present',
                        exampleDutch: presentExample || '',
                        exampleEnglish: presentExampleEnglish || ''
                    });
                }
                if (past) {
                    allCards.push({
                        dutch: `verleden tijd (past): ${result.dutch}`,
                        english: past,
                        partOfSpeech: `verb-past${irregularSuffix}`,
                        exampleDutch: pastExample || '',
                        exampleEnglish: pastExampleEnglish || ''
                    });
                }
                if (perfect) {
                    allCards.push({
                        dutch: `voltooid deelwoord (perfect): ${result.dutch}`,
                        english: perfect,
                        partOfSpeech: `verb-perfect${irregularSuffix}`,
                        exampleDutch: perfectExample || '',
                        exampleEnglish: perfectExampleEnglish || ''
                    });
                }
            }

            // Render all preview cards
            renderPreviewCards(previewContainer, allCards);
            previewContainer.classList.remove('hidden');
            previewActions.classList.remove('hidden');

            input.value = '';
        } catch (error) {
            showToast(error.message || 'Failed to translate word', 'error');
        } finally {
            setLoading(false);
        }
    });

    saveBtn.addEventListener('click', async () => {
        if (pendingCard) {
            setSaveLoading(true);
            try {
                await saveCard(pendingCard);
                const drillCount = await generateDrillCards(pendingCard);
                const totalCards = 1 + drillCount;
                showToast(`${totalCards} card${totalCards > 1 ? 's' : ''} saved!`, 'success');
                previewContainer.classList.add('hidden');
                previewActions.classList.add('hidden');
                pendingCard = null;
            } catch (error) {
                if (error.code === 'duplicate') {
                    showToast('This word is already in your deck', 'error');
                } else {
                    showToast(error.message || 'Failed to save card', 'error');
                }
            } finally {
                setSaveLoading(false);
            }
        }
    });

    discardBtn.addEventListener('click', () => {
        previewContainer.classList.add('hidden');
        previewActions.classList.add('hidden');
        pendingCard = null;
    });
}

function renderPreviewCards(container, cards) {
    container.innerHTML = cards.map((card, i) => {
        const posClass = `pos-${card.partOfSpeech}`;
        const isIrregular = card.partOfSpeech.includes('-irregular');
        const exampleHtml = card.exampleDutch ? `
            <p class="example-dutch">${escapeHtml(card.exampleDutch)}</p>
            <p class="example-english">${escapeHtml(card.exampleEnglish)}</p>
        ` : '';

        return `
        <div class="preview-card-mini ${posClass}" data-index="${i}">
            ${isIrregular ? '<span class="irregular-badge-mini">irregular</span>' : ''}
            <div class="preview-card-front">
                <span class="pos-badge-mini">${getSimplePosLabel(card.partOfSpeech)}</span>
                <p class="preview-dutch">${escapeHtml(card.dutch)}</p>
            </div>
            <div class="preview-card-back">
                <p class="preview-english">${escapeHtml(card.english)}</p>
                ${exampleHtml}
            </div>
        </div>`;
    }).join('');
}

function setLoading(loading) {
    const btn = document.getElementById('add-btn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoading = btn.querySelector('.btn-loading');

    btn.disabled = loading;
    btnText.classList.toggle('hidden', loading);
    btnLoading.classList.toggle('hidden', !loading);
}

function setSaveLoading(loading) {
    const btn = document.getElementById('save-card-btn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoading = btn.querySelector('.btn-loading');
    const discardBtn = document.getElementById('discard-card-btn');

    btn.disabled = loading;
    discardBtn.disabled = loading;
    btnText.classList.toggle('hidden', loading);
    btnLoading.classList.toggle('hidden', !loading);
}

// All translation + example sentence generation goes through the Cloudflare Worker proxy.
async function translateWord(word) {
    const data = await workerFetch('/translate', {
        method: 'POST',
        body: JSON.stringify({ word })
    });
    if (!data.english) throw new Error('Translation service returned no result');

    // For nouns, use the singular form if provided
    let dutchWord = word;
    if (data.partOfSpeech === 'noun' && data.singular) {
        dutchWord = data.singular;
    }

    const result = {
        dutch: dutchWord,
        english: String(data.english).trim(),
        partOfSpeech: data.partOfSpeech || 'other',
        exampleDutch: data.dutch ? String(data.dutch).trim() : '',
        exampleEnglish: data.english_translation ? String(data.english_translation).trim() : ''
    };
    // Include article for nouns
    if (data.article) {
        result.article = data.article;
    }
    // Include conjugations and isIrregular for verbs
    if (data.conjugations) {
        result.conjugations = data.conjugations;
        result.isIrregular = data.isIrregular;
    }
    return result;
}

// Review System
function initReview() {
    const reviewCard = document.getElementById('review-card');
    const reviewButtons = document.getElementById('review-buttons');

    // Review mode selector
    const modeButtons = document.querySelectorAll('.review-mode-btn');
    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            modeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentReviewMode = btn.dataset.mode;
            loadReviewCards();
        });
    });

    reviewCard.addEventListener('click', () => {
        if (reviewCard.classList.contains('switching')) {
            return;
        }
        reviewCard.classList.toggle('flipped');
        if (reviewCard.classList.contains('flipped')) {
            reviewButtons.classList.remove('hidden');
            // Hide tap hint after first flip (persisted)
            hideTapHint();
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

    // Check if user has flipped before
    if (localStorage.getItem('hasFlippedCard')) {
        document.querySelectorAll('.tap-hint').forEach(el => el.classList.add('hidden-hint'));
    }
}

function hideTapHint() {
    if (!localStorage.getItem('hasFlippedCard')) {
        localStorage.setItem('hasFlippedCard', 'true');
        document.querySelectorAll('.tap-hint').forEach(el => el.classList.add('hidden-hint'));
    }
}

function filterCardsByMode(cards, mode) {
    if (mode === 'all') {
        return cards;
    } else if (mode === 'de-het') {
        return cards.filter(c => c.partOfSpeech === 'article-drill');
    } else if (mode === 'verb-tenses') {
        return cards.filter(c => c.partOfSpeech.startsWith('verb-present') ||
                                 c.partOfSpeech.startsWith('verb-past') ||
                                 c.partOfSpeech.startsWith('verb-perfect'));
    }
    return cards;
}

async function loadReviewCards() {
    const loadingState = document.getElementById('review-loading');
    const emptyState = document.getElementById('review-empty');
    const reviewArea = document.getElementById('review-area');

    // Show loading, hide others
    loadingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
    reviewArea.classList.add('hidden');

    let allCards = await getCardsForReview();
    reviewQueue = filterCardsByMode(allCards, currentReviewMode);
    currentReviewIndex = 0;

    // Hide loading
    loadingState.classList.add('hidden');

    if (reviewQueue.length === 0) {
        emptyState.classList.remove('hidden');
        if (currentReviewMode !== 'all') {
            emptyState.querySelector('p').textContent = `No ${currentReviewMode === 'de-het' ? 'de/het' : 'verb tense'} cards to review!`;
        } else {
            emptyState.querySelector('p').textContent = 'No cards to review!';
        }
        reviewArea.classList.add('hidden');
    } else {
        emptyState.classList.add('hidden');
        reviewArea.classList.remove('hidden');
        document.getElementById('total-cards').textContent = reviewQueue.length;
        showNextCard();
    }
}

// Format verb tense card front for display
function formatVerbTenseFront(card) {
    const pos = card.partOfSpeech;
    if (!pos.startsWith('verb-present') && !pos.startsWith('verb-past') && !pos.startsWith('verb-perfect')) {
        return null; // Not a verb tense card
    }

    // Extract verb name from dutch field (e.g., "tegenwoordige tijd (present): lopen" -> "lopen")
    const match = card.dutch.match(/:\s*(.+)$/);
    const verbName = match ? match[1] : card.dutch;

    let tenseLabel, tenseEnglish, tenseClass;
    if (pos.startsWith('verb-present')) {
        tenseLabel = 'Tegenwoordige tijd';
        tenseEnglish = 'Present tense';
        tenseClass = 'present';
    } else if (pos.startsWith('verb-past')) {
        tenseLabel = 'Verleden tijd';
        tenseEnglish = 'Past tense';
        tenseClass = 'past';
    } else {
        tenseLabel = 'Voltooid deelwoord';
        tenseEnglish = 'Perfect tense';
        tenseClass = 'perfect';
    }

    return { verbName, tenseLabel, tenseEnglish, tenseClass };
}

// Format conjugations for table display
function formatConjugationsTable(card) {
    const pos = card.partOfSpeech;
    const conjugations = card.english;

    // Split by comma and clean up
    const parts = conjugations.split(',').map(p => p.trim());

    if (pos.startsWith('verb-present')) {
        // Present: typically "ik form, jij form, wij form" or similar
        if (parts.length >= 3) {
            return `<table class="conjugation-table">
                <tr><td class="conj-label">ik</td><td class="conj-value">${parts[0]}</td></tr>
                <tr><td class="conj-label">jij/hij/zij</td><td class="conj-value">${parts[1]}</td></tr>
                <tr><td class="conj-label">wij/jullie/zij</td><td class="conj-value">${parts[2]}</td></tr>
            </table>`;
        } else if (parts.length === 2) {
            return `<table class="conjugation-table">
                <tr><td class="conj-label">singular</td><td class="conj-value">${parts[0]}</td></tr>
                <tr><td class="conj-label">plural</td><td class="conj-value">${parts[1]}</td></tr>
            </table>`;
        }
    } else if (pos.startsWith('verb-past')) {
        // Past: typically "singular, plural"
        if (parts.length >= 2) {
            return `<table class="conjugation-table">
                <tr><td class="conj-label">singular</td><td class="conj-value">${parts[0]}</td></tr>
                <tr><td class="conj-label">plural</td><td class="conj-value">${parts[1]}</td></tr>
            </table>`;
        }
    } else if (pos.startsWith('verb-perfect')) {
        // Perfect: typically "heb/ben + participle"
        return `<div class="conjugation-perfect">${conjugations}</div>`;
    }

    // Fallback: just return the text
    return `<div class="conjugation-fallback">${conjugations}</div>`;
}

// Format de/het card for display
function formatDeHetCard(card) {
    if (card.partOfSpeech !== 'article-drill') {
        return null;
    }

    // Extract noun from "de of het? [noun]"
    const match = card.dutch.match(/de of het\?\s+(.+)/i);
    const nounWord = match ? match[1] : card.dutch;

    // Parse the answer: "de/het noun (english)"
    const answerMatch = card.english.match(/^(de|het)\s+\S+\s*\((.+)\)$/i);
    const article = answerMatch ? answerMatch[1] : card.english.split(' ')[0];
    const englishTranslation = answerMatch ? answerMatch[2] : '';

    return { nounWord, article, englishTranslation };
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
    applyPosClass(reviewCard, card.partOfSpeech);

    // Check if this is a verb tense card or de/het card for special formatting
    const verbTenseInfo = formatVerbTenseFront(card);
    const deHetInfo = formatDeHetCard(card);
    const dutchWordEl = reviewCard.querySelector('.dutch-word');
    const englishWordEl = reviewCard.querySelector('.english-word');

    if (verbTenseInfo) {
        // Verb tense card: show formatted front with tense indicator dot
        dutchWordEl.innerHTML = `<span class="verb-tense-label">${verbTenseInfo.tenseLabel}<span class="tense-indicator ${verbTenseInfo.tenseClass}"></span></span>
            <span class="verb-tense-english">${verbTenseInfo.tenseEnglish}</span>
            <span class="verb-name">${escapeHtml(verbTenseInfo.verbName)}</span>`;

        // Formatted conjugation table on back
        englishWordEl.innerHTML = formatConjugationsTable(card);
    } else if (deHetInfo) {
        // de/het card: show noun prominently
        dutchWordEl.innerHTML = `<span class="dehet-noun">${escapeHtml(deHetInfo.nounWord)}</span>`;

        // Show article + noun with translation on back
        englishWordEl.innerHTML = `<span class="dehet-answer">${escapeHtml(deHetInfo.article)} ${escapeHtml(deHetInfo.nounWord)}</span>
            ${deHetInfo.englishTranslation ? `<span class="dehet-english">${escapeHtml(deHetInfo.englishTranslation)}</span>` : ''}`;
    } else {
        // Regular card
        dutchWordEl.textContent = card.dutch;
        englishWordEl.textContent = card.english;
    }

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

function initLegend() {
    const legendBtn = document.getElementById('legend-btn');
    const legendModal = document.getElementById('legend-modal');
    const legendCloseBtn = document.getElementById('legend-close-btn');

    legendBtn.addEventListener('click', () => legendModal.classList.remove('hidden'));
    legendCloseBtn.addEventListener('click', () => legendModal.classList.add('hidden'));
    legendModal.addEventListener('click', (e) => {
        if (e.target === legendModal) legendModal.classList.add('hidden');
    });
}

function initCardViewModal() {
    const modal = document.getElementById('card-view-modal');
    const closeBtn = document.getElementById('close-card-view');
    const viewCard = document.getElementById('view-card');
    const overlay = modal.querySelector('.card-view-overlay');

    closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        viewCard.classList.remove('flipped');
    });

    overlay.addEventListener('click', () => {
        modal.classList.add('hidden');
        viewCard.classList.remove('flipped');
    });

    viewCard.addEventListener('click', () => {
        viewCard.classList.toggle('flipped');
        if (viewCard.classList.contains('flipped')) {
            hideTapHint();
        }
    });
}

function initStarterWords() {
    document.querySelectorAll('.starter-word').forEach(btn => {
        btn.addEventListener('click', () => {
            const word = btn.dataset.word;
            // Switch to Add tab and fill in the word
            document.querySelector('[data-tab="add"]').click();
            const input = document.getElementById('word-input');
            input.value = word;
            input.focus();
            // Trigger form submit
            document.getElementById('add-form').dispatchEvent(new Event('submit'));
        });
    });
}

function showCardViewModal(card) {
    const modal = document.getElementById('card-view-modal');
    const viewCard = document.getElementById('view-card');

    applyPosClass(viewCard, card.partOfSpeech);
    viewCard.classList.remove('flipped');

    const dutchWordEl = viewCard.querySelector('.dutch-word');
    const englishWordEl = viewCard.querySelector('.english-word');

    // Check for special card types
    const verbTenseInfo = formatVerbTenseFront(card);
    const deHetInfo = formatDeHetCard(card);

    if (verbTenseInfo) {
        dutchWordEl.innerHTML = `<span class="verb-tense-label">${verbTenseInfo.tenseLabel}<span class="tense-indicator ${verbTenseInfo.tenseClass}"></span></span>
            <span class="verb-tense-english">${verbTenseInfo.tenseEnglish}</span>
            <span class="verb-name">${escapeHtml(verbTenseInfo.verbName)}</span>`;
        englishWordEl.innerHTML = formatConjugationsTable(card);
    } else if (deHetInfo) {
        dutchWordEl.innerHTML = `<span class="dehet-noun">${escapeHtml(deHetInfo.nounWord)}</span>`;
        englishWordEl.innerHTML = `<span class="dehet-answer">${escapeHtml(deHetInfo.article)} ${escapeHtml(deHetInfo.nounWord)}</span>
            ${deHetInfo.englishTranslation ? `<span class="dehet-english">${escapeHtml(deHetInfo.englishTranslation)}</span>` : ''}`;
    } else {
        dutchWordEl.textContent = card.dutch;
        englishWordEl.textContent = card.english;
    }

    renderExample(viewCard, card.exampleDutch, card.exampleEnglish);
    modal.classList.remove('hidden');
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

    // Store cards for click handler
    window.cardListData = cards;

    listContainer.innerHTML = cards.map((card, index) => {
        const posClass = `pos-${card.partOfSpeech || 'other'}`;
        const exampleDutch = card.exampleDutch ? `<div class="list-card-example-dutch">${escapeHtml(card.exampleDutch)}</div>` : '';
        const exampleEnglish = card.exampleEnglish ? `<div class="list-card-example-english">${escapeHtml(card.exampleEnglish)}</div>` : '';
        return `
        <div class="list-card ${posClass}" data-id="${card.id}" data-index="${index}">
            <div class="list-card-content">
                <div class="list-card-dutch">${escapeHtml(card.dutch)}</div>
                <div class="list-card-english">${escapeHtml(card.english)}</div>
                ${exampleDutch}
                ${exampleEnglish}
            </div>
            <button class="list-card-delete" onclick="event.stopPropagation(); handleDeleteCard(${card.id})">🗑️</button>
        </div>`;
    }).join('');

    // Add click handlers to list cards
    listContainer.querySelectorAll('.list-card').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('list-card-delete')) return;
            const index = parseInt(el.dataset.index);
            showCardViewModal(window.cardListData[index]);
        });
    });
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
        partOfSpeech: card.partOfSpeech || 'other',
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

function applyPosClass(element, partOfSpeech) {
    // Remove any existing pos-* class
    element.classList.forEach(cls => {
        if (cls.startsWith('pos-')) element.classList.remove(cls);
    });
    const pos = partOfSpeech || 'other';
    element.classList.add(`pos-${pos}`);
    // Update badge text if present - show simplified category
    const badge = element.querySelector('.pos-badge');
    if (badge) badge.textContent = getSimplePosLabel(pos);
}

// Get simplified part of speech label for display
function getSimplePosLabel(pos) {
    if (pos.startsWith('verb-present') || pos.startsWith('verb-past') || pos.startsWith('verb-perfect')) {
        return 'verb';
    }
    if (pos === 'article-drill') {
        return 'de/het';
    }
    return pos.replace('-irregular', '');
}

// Register service worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.log('ServiceWorker registration failed:', err);
        });
    });
}
