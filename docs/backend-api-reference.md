# Backend API Reference

This document provides a comprehensive reference for all backend API routes in the SupportMe platform.

## Base URL

```
http://localhost:4000 (development)
https://your-api-domain.com (production)
```

## Authentication

Most API endpoints require authentication via a JWT token in the `Authorization` header:

```
Authorization: Bearer <token>
```

Tokens are obtained through the authentication endpoints (`/api/auth/challenge` and `/api/auth/verify` for wallet-based auth, `/api/auth/magic-link` for email-based auth).

## Response Format

All endpoints return JSON responses. Successful responses typically follow this structure:

```json
{
  "data": { ... },
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

Error responses follow this structure:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

---

## Authentication

### POST /api/auth/challenge

Request a sign-in challenge for a wallet address (SEP-0043/SEP-0053).

**Auth Required:** No

**Request Body:**
```json
{
  "walletAddress": "G..."
}
```

**Response:**
```json
{
  "message": "Sign in to SupportMe\n\nAddress: G...\nNonce: abc123...\nIssued At: 2024-01-01T00:00:00.000Z"
}
```

**Notes:**
- The challenge message is valid for 5 minutes
- The message must be signed by the wallet's private key
- Use the signed message in `/api/auth/verify`

---

### POST /api/auth/verify

Verify the signed challenge and sign in (wallet-based authentication).

**Auth Required:** No

**Request Body:**
```json
{
  "walletAddress": "G...",
  "signedMessage": "base64-encoded-signature"
}
```

**Response:**
```json
{
  "user": {
    "id": 1,
    "walletAddress": "G..."
  },
  "token": "jwt-token-here",
  "hasProfile": true,
  "username": "creatorname"
}
```

**Notes:**
- Returns a JWT token valid for 7 days
- Creates a user account if one doesn't exist
- `hasProfile` indicates whether the user has created a creator profile

---

### POST /api/auth/magic-link

Request a magic link for email-only sign-in.

**Auth Required:** No

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "message": "If that email is valid, a sign-in link has been sent."
}
```

**Notes:**
- Rate-limited to prevent email enumeration
- Same response for new and existing emails for privacy
- Magic link is sent to the provided email address

---

### POST /api/auth/magic-link/verify

Verify a magic link token and complete sign-in.

**Auth Required:** No

**Request Body:**
```json
{
  "token": "magic-link-token"
}
```

**Response:**
```json
{
  "user": {
    "id": 1,
    "walletAddress": null,
    "email": "user@example.com"
  },
  "token": "jwt-token-here",
  "hasProfile": false,
  "username": null
}
```

---

### GET /api/auth/twitter

Initiate Twitter/X OAuth sign-in.

**Auth Required:** No

**Response:**
```json
{
  "redirectUrl": "https://twitter.com/oauth/authorize?..."
}
```

**Notes:**
- Returns the Twitter OAuth authorization URL
- Frontend should redirect the user to this URL

---

### GET /api/auth/twitter/callback

Complete Twitter/X OAuth sign-in after redirect.

**Auth Required:** No

**Query Parameters:**
- `code`: OAuth authorization code
- `state`: OAuth state parameter

**Response:**
```json
{
  "user": {
    "id": 1,
    "walletAddress": null,
    "twitterId": "123456789"
  },
  "token": "jwt-token-here",
  "hasProfile": false,
  "username": null
}
```

---

## Creators

### GET /api/creators

List all creators with search and pagination.

**Auth Required:** No

**Query Parameters:**
- `q` (optional): Search query for username or display name
- `sort` (optional): Sort order - `newest` (default) or `most-supported`
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20, max: 100)

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "username": "creatorname",
      "displayName": "Creator Name",
      "bio": "Creator bio",
      "avatarUrl": "https://...",
      "walletAddress": "G...",
      "acceptsXlm": true,
      "acceptsUsdc": true,
      "acceptsUsdt": false,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z",
      "_count": {
        "donations": 42
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

---

### GET /api/creators/me

Get the current user's creator profile.

**Auth Required:** Yes

**Response:**
```json
{
  "id": 1,
  "username": "creatorname",
  "displayName": "Creator Name",
  "bio": "Creator bio",
  "avatarUrl": "https://...",
  "walletAddress": "G...",
  "acceptsXlm": true,
  "acceptsUsdc": true,
  "acceptsUsdt": false,
  "socialLinks": {
    "twitter": "username",
    "github": "username"
  },
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

---

### GET /api/creators/leaderboard

Get leaderboard for creators or supporters by currency.

**Auth Required:** No

**Query Parameters:**
- `type`: Leaderboard type - `creators` or `supporters`
- `currency`: Currency code (e.g., `XLM`, `USDC`)
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20)

**Response (creators):**
```json
{
  "items": [
    {
      "rank": 1,
      "total": 1000.5,
      "donationCount": 42,
      "creator": {
        "id": 1,
        "username": "creatorname",
        "displayName": "Creator Name",
        "avatarUrl": "https://..."
      }
    }
  ],
  "currency": "XLM",
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

**Response (supporters):**
```json
{
  "items": [
    {
      "rank": 1,
      "total": 500.25,
      "donationCount": 25,
      "senderAddress": "G..."
    }
  ],
  "currency": "XLM",
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

**Notes:**
- Leaderboard is cached for 30 seconds
- Returns top creators by total received or top supporters by total given

---

### GET /api/creators/:username

Get a creator by username.

**Auth Required:** No

**Response:**
```json
{
  "id": 1,
  "username": "creatorname",
  "displayName": "Creator Name",
  "bio": "Creator bio",
  "avatarUrl": "https://...",
  "walletAddress": "G...",
  "acceptsXlm": true,
  "acceptsUsdc": true,
  "acceptsUsdt": false,
  "socialLinks": {
    "twitter": "username",
    "github": "username"
  },
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

---

### POST /api/creators/:username/create

Create a creator profile after sign-in (wallet, Twitter, or magic link).

`walletAddress` defaults to the authenticated user's wallet, or `null` if none
is connected. Legacy empty strings are normalized to `null`. Walletless
profiles remain available by username, but are excluded from Discover/search
and creator leaderboards until a payout wallet is connected.

On both creation and update, `avatarUrl` must use HTTPS on
`res.cloudinary.com/<CLOUDINARY_CLOUD_NAME>/...`, matching the backend's
configured cloud name. Avatar writes are rejected if that setting is absent.
Social-link updates accept only the keys `twitter`, `instagram`, `youtube`,
`tiktok`, `github`, `linkedin`, `telegram`, and `website`, with absolute HTTP(S)
URLs or platform handles (LinkedIn: `in/username`; website: full URL required).
Handles are stored as expanded platform URLs. Invalid hosts/schemes or unknown
keys return HTTP 400 with `VALIDATION_ERROR`. An empty social-links object
clears all links.

**Auth Required:** Yes

**Request Body:**
```json
{
  "walletAddress": "G...",
  "displayName": "Creator Name",
  "bio": "Creator bio",
  "avatarUrl": "https://..."
}
```

**Response:**
```json
{
  "id": 1,
  "userId": 1,
  "username": "creatorname",
  "displayName": "Creator Name",
  "bio": "Creator bio",
  "avatarUrl": "https://...",
  "walletAddress": "G...",
  "acceptsXlm": true,
  "acceptsUsdc": true,
  "acceptsUsdt": false,
  "socialLinks": null,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

**Notes:**
- Username must be unique
- Each user can only have one creator profile
- `walletAddress` defaults to the signed-in wallet. Using any other payout wallet requires proof of control: request a message from `POST /api/auth/challenge` for that wallet, sign it, and send the base64 signature as `walletSignature` (single use; `403` without it, `401` if invalid or expired)
- A wallet can be linked to only one creator profile (`409` if already taken)
- Called after wallet sign-in when `hasProfile` is false

---

### PUT /api/creators/:username

Update a creator profile.

**Auth Required:** Yes

**Request Body:**
```json
{
  "displayName": "Updated Name",
  "bio": "Updated bio",
  "avatarUrl": "https://...",
  "walletAddress": "G...",
  "acceptsXlm": true,
  "acceptsUsdc": true,
  "acceptsUsdt": false,
  "socialLinks": {
    "twitter": "username",
    "github": "username"
  }
}
```

**Response:**
```json
{
  "id": 1,
  "username": "creatorname",
  "displayName": "Updated Name",
  "bio": "Updated bio",
  "avatarUrl": "https://...",
  "walletAddress": "G...",
  "acceptsXlm": true,
  "acceptsUsdc": true,
  "acceptsUsdt": false,
  "socialLinks": {
    "twitter": "username",
    "github": "username"
  },
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-02T00:00:00.000Z"
}
```

**Notes:**
- Only the profile owner can update their profile
- `walletAddress` may be changed to the signed-in wallet, or to another wallet only with proof of control: request a message from `POST /api/auth/challenge` for that wallet, sign it, and send the base64 signature as `walletSignature` (single use; `403` without it, `401` if invalid or expired)
- A wallet can be linked to only one creator profile (`409` if already taken)
- All fields are optional; only provided fields are updated

---

## Donations

### GET /api/donations

List donations with filtering and pagination.

**Auth Required:** No

**Query Parameters:**
- `creatorUsername` (optional): Filter by creator username
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20, max: 100)

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "creatorId": 1,
      "senderAddress": "G...",
      "amount": 10.5,
      "currency": "XLM",
      "message": "Great work!",
      "transactionHash": "abc123...",
      "verified": true,
      "eventId": "abc123...:0:0",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

**Notes:**
- Only returns verified donations by default
- `eventId` is the on-chain event identifier for deduplication

---

### POST /api/donations

Record a donation (requires `Idempotency-Key` header).

**Auth Required:** No

**Headers:**
- `Idempotency-Key`: Unique key for idempotency (retained for 24 hours)

**Request Body:**
```json
{
  "creatorUsername": "creatorname",
  "senderAddress": "G...",
  "amount": 10.5,
  "currency": "XLM",
  "message": "Great work!",
  "transactionHash": "abc123..."
}
```

`creatorUsername`, `senderAddress`, `amount` and `transactionHash` are
required; omitting `transactionHash` returns `400 VALIDATION_ERROR`. A report
without a transaction hash cannot be corroborated on-chain, so the API rejects
it rather than recording an unverifiable donation (issue #258).

**Response:**
```json
{
  "id": 1,
  "creatorId": 1,
  "senderAddress": "G...",
  "amount": 10.5,
  "currency": "XLM",
  "message": "Great work!",
  "transactionHash": "abc123...",
  "verified": false,
  "onChainEventId": "abc123...:0:0",
  "operationIndex": 0,
  "eventIndex": 0,
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**Notes:**
- Idempotent on `Idempotency-Key` header
- `transactionHash` is required; the report is upserted on its on-chain identity
- Client-reported rows are always stored `verified: false` — only server-side
  verification (the event listener / subscription executor) can set
  `verified: true`, and unverified rows are excluded from the verified-only
  feed (`GET /api/donations`)
- Triggers email notifications to both creator and supporter

---

## Subscriptions

### GET /api/subscriptions

List subscriptions with filtering.

**Auth Required:** No

**Query Parameters:**
- `creatorUsername` (optional): Filter by creator username
- `supporterAddress` (optional): Filter by supporter wallet address

**Response:**
```json
[
  {
    "id": 1,
    "creatorId": 1,
    "supporterAddress": "G...",
    "token": "CD6T563YCSYQHDMXC7VCFTKMWMXWHFHAU4NO7EAMFK57QLFI7SSXICYY",
    "amount": 5.0,
    "intervalSecs": 604800,
    "onChainId": 1,
    "subscribeTxHash": "abc123...",
    "nextChargeAt": "2024-01-08T00:00:00.000Z",
    "active": true,
    "lastChargeTxHash": null,
    "lastChargedAt": null,
    "lastError": null,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "creator": {
      "username": "creatorname",
      "displayName": "Creator Name",
      "avatarUrl": "https://..."
    }
  }
]
```

---

### POST /api/subscriptions

Record a subscription started on-chain.

**Auth Required:** Yes

**Request Body:**
```json
{
  "creatorUsername": "creatorname",
  "supporterAddress": "G...",
  "token": "CD6T563YCSYQHDMXC7VCFTKMWMXWHFHAU4NO7EAMFK57QLFI7SSXICYY",
  "amount": 5.0,
  "intervalSecs": 604800,
  "onChainId": 1,
  "subscribeTxHash": "abc123..."
}
```

**Response:**
```json
{
  "id": 1,
  "creatorId": 1,
  "supporterAddress": "G...",
  "token": "CD6T563YCSYQHDMXC7VCFTKMWMXWHFHAU4NO7EAMFK57QLFI7SSXICYY",
  "amount": 5.0,
  "intervalSecs": 604800,
  "onChainId": 1,
  "subscribeTxHash": "abc123...",
  "nextChargeAt": "2024-01-08T00:00:00.000Z",
  "active": true,
  "lastChargeTxHash": null,
  "lastChargedAt": null,
  "lastError": null,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

**Notes:**
- Idempotent on `onChainId` (globally unique)
- Only the supporter who signed the transaction can record it
- Caller's wallet must match `supporterAddress`

---

### POST /api/subscriptions/:id/cancel

Mark a subscription cancelled after on-chain cancellation.

**Auth Required:** Yes

**Response:**
```json
{
  "id": 1,
  "creatorId": 1,
  "supporterAddress": "G...",
  "token": "CD6T563YCSYQHDMXC7VCFTKMWMXWHFHAU4NO7EAMFK57QLFI7SSXICYY",
  "amount": 5.0,
  "intervalSecs": 604800,
  "onChainId": 1,
  "subscribeTxHash": "abc123...",
  "nextChargeAt": "2024-01-08T00:00:00.000Z",
  "active": false,
  "lastChargeTxHash": "def456...",
  "lastChargedAt": "2024-01-01T00:00:00.000Z",
  "lastError": null,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-02T00:00:00.000Z"
}
```

**Notes:**
- Only the subscription owner can cancel it
- Reflects the on-chain cancellation (allowance revocation)

---

## Goals

### GET /api/goals/:username

Get a creator's goals.

**Auth Required:** No

**Query Parameters:**
- `status` (optional): Filter by status - `ACTIVE`, `COMPLETED`, or `EXPIRED`

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "creatorId": 1,
      "title": "Monthly Goal",
      "targetAmount": 100.0,
      "currentAmount": 50.0,
      "currency": "XLM",
      "status": "ACTIVE",
      "recurring": true,
      "recurrenceInterval": "MONTHLY",
      "currentPeriodEnd": "2024-02-01T00:00:00.000Z",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### POST /api/goals/:username

Create a goal for a creator.

**Auth Required:** Yes

**Request Body:**
```json
{
  "title": "Monthly Goal",
  "targetAmount": 100.0,
  "currency": "XLM",
  "recurring": true,
  "recurrenceInterval": "MONTHLY"
}
```

**Response:**
```json
{
  "id": 1,
  "creatorId": 1,
  "title": "Monthly Goal",
  "targetAmount": 100.0,
  "currentAmount": 0.0,
  "currency": "XLM",
  "status": "ACTIVE",
  "recurring": true,
  "recurrenceInterval": "MONTHLY",
  "currentPeriodEnd": "2024-02-01T00:00:00.000Z",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

**Notes:**
- Only the creator can create goals for their profile
- `recurrenceInterval` is required if `recurring` is true

---

### PUT /api/goals/:id

Update a goal.

**Auth Required:** Yes

**Request Body:**
```json
{
  "title": "Updated Goal",
  "targetAmount": 150.0,
  "status": "ACTIVE",
  "recurring": true,
  "recurrenceInterval": "WEEKLY"
}
```

**Response:**
```json
{
  "id": 1,
  "creatorId": 1,
  "title": "Updated Goal",
  "targetAmount": 150.0,
  "currentAmount": 50.0,
  "currency": "XLM",
  "status": "ACTIVE",
  "recurring": true,
  "recurrenceInterval": "WEEKLY",
  "currentPeriodEnd": "2024-01-08T00:00:00.000Z",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-02T00:00:00.000Z"
}
```

**Notes:**
- Only the goal owner can update it
- Changing recurrence settings recomputes the period end

---

## Withdrawals

### GET /api/withdrawals

List withdrawals with filtering.

**Auth Required:** No

**Query Parameters:**
- `creatorUsername` (optional): Filter by creator username

**Response:**
```json
[
  {
    "id": 1,
    "creatorId": 1,
    "amountIn": 100.0,
    "amountOut": 95.0,
    "fee": 5.0,
    "currency": "XLM",
    "anchorTxId": "anchor-tx-123",
    "stellarTxId": "stellar-tx-456",
    "status": "completed",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
]
```

---

### POST /api/withdrawals

Record a withdrawal after cash-out via anchor.

**Auth Required:** Yes

**Request Body:**
```json
{
  "creatorUsername": "creatorname",
  "amountIn": 100.0,
  "amountOut": 95.0,
  "fee": 5.0,
  "currency": "XLM",
  "anchorTxId": "anchor-tx-123",
  "stellarTxId": "stellar-tx-456",
  "status": "completed"
}
```

**Response:**
```json
{
  "id": 1,
  "creatorId": 1,
  "amountIn": 100.0,
  "amountOut": 95.0,
  "fee": 5.0,
  "currency": "XLM",
  "anchorTxId": "anchor-tx-123",
  "stellarTxId": "stellar-tx-456",
  "status": "completed",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**Notes:**
- Idempotent on `anchorTxId`
- Only the creator can record withdrawals for their profile
- Used after SEP-24 cash-out completion

---

## Admin

### GET /api/admin/overview

View platform-wide earnings and user data.

**Auth Required:** Yes (Admin only)

**Response:**
```json
{
  "totalSignups": 100,
  "totalCreators": 50,
  "earningsByCurrency": {
    "XLM": 1234.5,
    "USDC": 500.0
  },
  "users": [
    {
      "id": 1,
      "walletAddress": "G...",
      "joinedAt": "2024-01-01T00:00:00.000Z",
      "username": "creatorname",
      "displayName": "Creator Name",
      "earningsByCurrency": {
        "XLM": 100.0,
        "USDC": 50.0
      }
    }
  ]
}
```

**Notes:**
- Requires wallet in `ADMIN_WALLETS` environment variable
- Shows all users and their earnings by currency
- Earnings are never normalized to USD (no price oracle)

---

### GET /api/admin/audit-logs

View recent privileged admin actions.

**Auth Required:** Yes (Admin only)

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20)

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "adminUserId": 1,
      "action": "admin.overview.viewed",
      "targetType": "admin",
      "targetId": "overview",
      "before": null,
      "after": null,
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

**Notes:**
- Requires wallet in `ADMIN_WALLETS` environment variable
- Records all privileged admin actions with before/after snapshots
- Append-only log for audit trail

---

## Account

### GET /api/account/export

Export all user data (GDPR compliance).

**Auth Required:** Yes

**Response:**
```json
{
  "exportedAt": "2024-01-01T00:00:00.000Z",
  "user": {
    "id": 1,
    "walletAddress": "G...",
    "email": "user@example.com",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "deletedAt": null
  },
  "creator": {
    "id": 1,
    "username": "creatorname",
    "displayName": "Creator Name",
    "bio": "Creator bio",
    "avatarUrl": "https://...",
    "walletAddress": "G...",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "donations": {
    "sent": [...],
    "received": [...]
  },
  "subscriptions": {
    "asSupporter": [...],
    "asCreator": [...]
  },
  "withdrawals": [...]
}
```

**Notes:**
- Returns a downloadable JSON file
- Includes all user-associated data
- Used for GDPR data export requests

---

### POST /api/account/delete

Delete user account (GDPR compliance).

**Auth Required:** Yes

**Request Body:**
```json
{
  "confirmation": "DELETE_MY_ACCOUNT"
}
```

**Response:**
```json
{
  "deleted": true,
  "deletedAt": "2024-01-01T00:00:00.000Z",
  "alreadyDeleted": false,
  "anonymized": [
    "email",
    "profile.displayName",
    "profile.bio",
    "profile.avatarUrl",
    "profile.socialLinks",
    "donationMessages.sent",
    "activeSubscriptions.deactivated"
  ],
  "preserved": [
    "walletAddress",
    "onChainDonationRecords",
    "onChainSubscriptionRecords",
    "withdrawalRecords",
    "creator.username"
  ]
}
```

**Notes:**
- Requires typed confirmation string
- Anonymizes personal data while preserving on-chain references
- Deactivates active subscriptions
- Account can be soft-deleted only once

---

## Real-Time Events

### GET /api/events

Server-Sent Events stream of on-chain donation events.

**Auth Required:** No

**Response:** Event stream with `donation` events

**Event Format:**
```
event: donation
data: {
  "donor": "G...",
  "creator": "G...",
  "amount": 10.5,
  "fee_amount": 0.0,
  "memo": "Great work!",
  "timestamp": 1704067200000,
  "txHash": "abc123...",
  "eventId": "abc123...:0:0",
  "currency": "XLM"
}
```

**Notes:**
- Use `EventSource` in frontend to subscribe
- Sends heartbeat every 30 seconds to keep connection alive
- Events are indexed idempotently by transaction hash, operation index, and event index
- Frontend dashboard and profile pages use this for live updates

---

## Health

### GET /health

Operational health check.

**Auth Required:** No

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "soroban": {
    "status": "ok",
    "endpoint": "https://soroban-testnet.stellar.org",
    "lastCheck": "2024-01-01T00:00:00.000Z"
  },
  "executor": {
    "status": "ok",
    "lastRunAt": "2024-01-01T00:00:00.000Z",
    "recentCharges": {
      "success": 10,
      "failure": 0
    }
  }
}
```

**Notes:**
- Checks Soroban RPC connectivity
- Reports subscription executor health
- Returns `unhealthy` if executor hasn't run within expected interval

---

## Error Codes

Common error codes returned by the API:

- `UNAUTHORIZED`: Authentication required or failed
- `FORBIDDEN`: Insufficient permissions
- `NOT_FOUND`: Resource not found
- `CONFLICT`: Resource already exists or conflict with current state
- `BAD_REQUEST`: Invalid request parameters
- `TOO_MANY_REQUESTS`: Rate limit exceeded
- `INTERNAL_ERROR`: Server error

---

## Rate Limiting

Some endpoints are rate-limited to prevent abuse:
- `/api/auth/magic-link`: Rate-limited to prevent email enumeration
- Admin endpoints: Additional rate limiting for privileged operations

Rate limit headers are included in responses:
- `X-RateLimit-Limit`: Request limit per window
- `X-RateLimit-Remaining`: Remaining requests in current window
- `X-RateLimit-Reset`: Unix timestamp when window resets

---

## Pagination

List endpoints support pagination via `page` and `limit` query parameters:
- `page`: Page number (1-indexed, default: 1)
- `limit`: Items per page (default: 20, maximum: 100)

Pagination metadata is included in responses:
```json
{
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```
