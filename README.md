# Ghost Pay — Backend / Orchestration (Dev B)

## Overview
This repository contains the backend and orchestration services for the Ghost Pay application. It is built using Firebase Cloud Functions v2 and TypeScript. 

## Stack
- **Compute:** Firebase Cloud Functions v2, TypeScript
- **Database / State:** Firestore (for transactions, merchant profiles, FCM tokens)
- **Storage:** Firebase Storage (for YarnGPT audio files)
- **Routing:** Native Cloud Functions request/response (No Express used)

## Cloud Functions
- `/voice-ingest` — Main entry point: processes audio → Whisper → Gemini → Kora → WhatsApp → FCM
- `/kora-webhook` — Receives Kora payment events, updates Firestore
- `/query-charge` — Fallback polling if the webhook hasn't fired in 2 minutes

## API Keys & Environment Variables 
*(Always use env vars — never hardcode these)*
- `OPENAI_API_KEY` (Whisper)
- `GEMINI_API_KEY`
- `YARNGPT_API_KEY`
- `KORA_SECRET_KEY`
- `KORA_PUBLIC_KEY`
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `JWT_SECRET`

## JSON API Contract (Frozen)
Return shape from `/voice-ingest`:
```json
{
  "status": "success",
  "payload": {
    "kora_url": "https://...",
    "whatsapp_sent": true,
    "parsed_data": {
      "amount": 100,
      "customer": "John Doe",
      "item": "Coffee"
    },
    "audio_feedback_url": "https://..."
  }
}
```

### Gemini parsed intent shape (internal)
```json
{
  "amount": 100,
  "description": "Item description",
  "customer_phone": "+1234567890"
}
```

## Security
- All functions except `/kora-webhook` must verify JWT in the Authorization header.
- `/kora-webhook` must verify the Kora signature header before processing.
- Firestore rules limit read/write access so merchants can only access their own data.

## Code Style
- Use `async/await` throughout — no raw Promise chains.
- All external API calls must be wrapped in `try/catch` and log errors with structured logging.
- Functions should run under 80 lines. Extract helpers if they grow larger.
