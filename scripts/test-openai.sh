#!/usr/bin/env bash
# Usage:
#   export OPENAI_API_KEY=sk-...
#   ./scripts/test-openai.sh huis vooral uitgelicht duurzaam afleiding
#
# Prints JSON for each word: translation + Dutch example sentence + English translation.

set -euo pipefail

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    echo "Set OPENAI_API_KEY in your shell first." >&2
    exit 1
fi

MODEL="${OPENAI_MODEL:-gpt-4o-mini}"

for word in "$@"; do
    body=$(cat <<EOF
{
  "model": "$MODEL",
  "response_format": {"type": "json_object"},
  "temperature": 0.6,
  "messages": [
    {"role": "system", "content": "You help Dutch vocabulary learners. Respond with JSON only."},
    {"role": "user", "content": "For the Dutch word \"$word\", return JSON with: english (a short English gloss / translation, 1-3 words), dutch (one short natural Dutch sentence, max 12 words, that uses the word in context), english_translation (the English translation of that sentence)."}
  ]
}
EOF
)

    echo "=== $word ==="
    curl -s https://api.openai.com/v1/chat/completions \
        -H "Authorization: Bearer $OPENAI_API_KEY" \
        -H "Content-Type: application/json" \
        -d "$body" \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['choices'][0]['message']['content']) if 'choices' in d else print(json.dumps(d, indent=2))"
    echo
done
