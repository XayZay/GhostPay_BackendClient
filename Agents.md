# Ghost Pay — Backend / Orchestration (Dev B)

## Stack
- Firebase Cloud Functions v2, TypeScript
- Firestore for state (transactions, merchant profiles, FCM tokens)
- Firebase Storage for YarnGPT audio files
- No Express — use native Cloud Functions request/response

## Functions
- /voice-ingest — main entry: audio → Whisper → Gemini → Kora → WhatsApp → FCM
- /kora-webhook — receives Kora payment events, updates Firestore
- /query-charge — fallback polling if webhook hasn't fired in 2 minutes

## API keys (always use env vars — never hardcode)
- OPENAI_API_KEY (Whisper)
- GEMINI_API_KEY
- YARNGPT_API_KEY
- KORA_SECRET_KEY
- KORA_PUBLIC_KEY
- WHATSAPP_TOKEN
- WHATSAPP_PHONE_NUMBER_ID
- JWT_SECRET

## JSON contract (frozen — do not change field names)
Return shape from /voice-ingest:
{ status: "success", payload: { kora_url, whatsapp_sent, parsed_data: { amount, customer, item }, audio_feedback_url } }

## Gemini parsed intent shape (internal)
{ amount: number, description: string, customer_phone: string (E.164 format) }

## Security
- All functions except /kora-webhook must verify JWT in Authorization header
- /kora-webhook must verify Kora signature header before processing
- Firestore rules: merchants read/write own data only

## Code style
- Async/await throughout — no raw Promise chains
- All external API calls wrapped in try/catch, log errors with structured logging
- Functions should be under 80 lines — extract helpers if larger