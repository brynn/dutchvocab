CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dutch TEXT NOT NULL,
    english TEXT NOT NULL,
    exampleDutch TEXT NOT NULL DEFAULT '',
    exampleEnglish TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL,
    nextReview INTEGER NOT NULL,
    stability REAL NOT NULL DEFAULT 0,
    difficulty REAL NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    lastReview INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cards_nextReview ON cards(nextReview);
