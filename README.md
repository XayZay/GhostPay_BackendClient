# Ghost Pay — Backend / Orchestration (Dev B)

## Overview
This repository contains the backend and orchestration services for the Ghost Pay application. It is built using Firebase Cloud Functions v2 and TypeScript. 

## Stack
- **Compute:** Firebase Cloud Functions v2, TypeScript
- **Database / State:** Firestore (for transactions, merchant profiles, FCM tokens)
- **Storage:** Firebase Storage (for YarnGPT audio files)
- **Routing:** Native Cloud Functions request/response (No Express used)

## Cloud Functions

| Function | Method | Auth | Description |
|---|---|---|---|
| `/merchantAuth` | POST | None | Merchant signup/login. Returns JWT. |
| `/voiceIngest` | POST | JWT | Main pipeline: audio → Whisper → Gemini → Kora → WhatsApp → FCM |
| `/verifyAccount` | POST | JWT | Verify bank account via Kora resolve API |
| `/createMerchant` | POST | JWT | Save merchant payout bank details |
| `/merchantFcm` | POST | JWT | Store/update FCM push notification token |
| `/koraWebhook` | POST | Kora HMAC | Receives Kora payment events, updates Firestore |
| `/queryCharge` | Scheduled | N/A | Fallback polling if webhook hasn't fired in 2 minutes |

## API Contracts

### POST `/merchantAuth`
**Request:**
```json
{ "name": "Mama Chisom", "phone": "08031234567" }
```
**Response:**
```json
{ "token": "eyJ...", "merchantId": "+2348031234567" }
```

### POST `/voiceIngest` (JWT required)
**Request:** `multipart/form-data` with audio file  
**Response:**
```json
{
  "status": "success",
  "payload": {
    "kora_url": "https://...",
    "whatsapp_sent": true,
    "parsed_data": { "amount": 100, "customer": "+2348031234567", "item": "Coffee" },
    "audio_feedback_url": "https://..."
  }
}
```

### POST `/verifyAccount` (JWT required)
**Request:**
```json
{ "account_number": "2158634852", "bank_code": "033" }
```
**Response:**
```json
{
  "account_name": "EBUKA CIROMA OLADEMJI",
  "bank_name": "United Bank for Africa",
  "account_number": "2158634852",
  "bank_code": "033"
}
```

### POST `/createMerchant` (JWT required)
**Request:**
```json
{ "account_number": "2158634852", "bank_code": "033", "account_name": "EBUKA CIROMA" }
```
**Response:**
```json
{ "status": "success", "merchantId": "+2348031234567" }
```

### POST `/merchantFcm` (JWT required)
**Request:**
```json
{ "fcm_token": "eABC123..." }
```
**Response:**
```json
{ "status": "success" }
```

### Gemini parsed intent shape (internal)
```json
{ "amount": 100, "description": "Item description", "customer_phone": "+1234567890" }
```

## API Keys & Environment Variables 
*(Always use env vars — never hardcode these)*
- `OPENAI_API_KEY` (Whisper)
- `GEMINI_API_KEY`
- `YARNGPT_API_KEY`
- `KORA_SECRET_KEY`
- `KORA_PUBLIC_KEY`
- `KORA_WEBHOOK_URL` (public deployed URL for `/koraWebhook`)
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `JWT_SECRET`

## External Service Setup
- Kora checkout initialization requires `KORA_SECRET_KEY` and `KORA_WEBHOOK_URL`.
- Kora bank account resolution uses `KORA_SECRET_KEY`.
- WhatsApp sends use the `ghost_pay_payment_link` template with English (`en`) language code.
- The WhatsApp template body expects two text parameters: item description, then Kora checkout URL.

## Security
- All functions except `/koraWebhook` and `/merchantAuth` must verify JWT in the Authorization header.
- `/koraWebhook` must verify the Kora signature header before processing.
- `/merchantAuth` is the only unauthenticated endpoint (it issues JWTs).
- Firestore rules limit read/write access so merchants can only access their own data.

## Code Style
- Use `async/await` throughout — no raw Promise chains.
- All external API calls must be wrapped in `try/catch` and log errors with structured logging.
- Functions should run under 80 lines. Extract helpers if they grow larger.

## Deploy
```bash
cd functions
npm run build
firebase deploy --only functions,firestore:rules,firestore:indexes,storage
```

## Dev 2 Endpoint URLs (after deploy)
```
MERCHANT_AUTH_URL=https://<region>-<project>.cloudfunctions.net/merchantAuth
VOICE_INGEST_URL=https://<region>-<project>.cloudfunctions.net/voiceIngest
VITE_VERIFY_ACCOUNT_URL=https://<region>-<project>.cloudfunctions.net/verifyAccount
VITE_CREATE_MERCHANT_URL=https://<region>-<project>.cloudfunctions.net/createMerchant
MERCHANT_FCM_URL=https://<region>-<project>.cloudfunctions.net/merchantFcm
```
