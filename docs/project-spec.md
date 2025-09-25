# Kazuki Finance Platform - Functional Specification

_Last updated: 2025-09-22_

This document captures the working specification of the Kazuki finance platform based on the current codebase. It is intended for engineers, designers, and product owners who need an authoritative reference on how the system behaves today and where to extend it next.

## 1. Product Overview

The application digitises expense paperwork for multi-store businesses. It centralises scanned receipts and passbook images, extracts structured data with OCR, and supports downstream review and approval. Core value propositions:

- Let store operators upload receipts quickly from a dashboard.
- Detect duplicates and enrich documents with AI to reduce manual processing.
- Give finance reviewers a single workspace to validate, lock, and export records.
- Provide administrative tooling to manage store memberships, shared payment cards, and vendor catalogues.

## 2. Personas & Permissions

Access control is enforced via Firebase Authentication plus Firestore-driven permission flags. The UI reacts to the following concepts (see `useUserPermissions`):

- **Store memberships** - users operate on specific store IDs; onboarding redirects if none exist.
- **Permission flags** (examples):
  - `perm.upload`: upload receipts and manage supplemental assets.
  - `perm.lock` / `perm.unlock`: transition receipts between reviewed and locked states.
  - `perm.manageCards`: maintain the shared credit card registry.
  - `perm.manageVendors`: curate the vendor catalogue.
- **Role templates & optimistic membership patches** allow server-pushed permissions and in-flight invite flows.

Personas mapped onto flags:

| Persona | Typical flags | Responsibilities |
| --- | --- | --- |
| Store uploader | `perm.upload` | Submit receipts, attach item photos, supply vendor context. |
| Reviewer / Accountant | `perm.upload`, `perm.lock`, `perm.unlock` | Validate OCR results, adjust payment metadata, lock records. |
| Admin / Operations | All flags above + membership management via invites | Maintain store roster, card & vendor catalogues. |

## 3. Feature Flags & Environment Variables

Key environment toggles (read from `process.env`):
- `NEXT_PUBLIC_APPFLAG_RECEIPTS` - gate the receipts feature set (upload/dashboard/settings/receipts pages).
- `NEXT_PUBLIC_APPFLAG_GEMINI_NORMALIZE` - enable Gemini-powered OCR enhancement.
- `NEXT_PUBLIC_RECEIPT_ITEM_MAX` - cap the number of supplemental item photos per receipt (default 5).

The project expects Firebase client configuration in `.env.local` and a service account JSON for server routes (see `finance-platform-*.json`).

## 4. System Architecture

### 4.1 Frontend
- **Framework**: Next.js 15 (App Router) with React 19; heavy use of client components for interactive flows.
- **Styling**: Tailwind utility classes (see `globals.css`).
- **State**: Redux Toolkit slices under `src/lib/state` plus a dedicated `userPermissionsStore` for real-time Firestore sync and optimistic updates.
- **Routing**: Authentication guard at `/splash`; feature pages under `/dashboard/*`, `/stores/*`, `/invites/*`, `/developer/*`.

### 4.2 Backend Integration
- **Firebase Authentication** - email/password or external providers handled via splash page listeners.
- **Firestore** - primary datastore for receipts (`/receipts`), assets (`/receipts/{id}/assets`), vendors, credit cards, role templates, invites, and user permissions.
- **Firebase Storage** - stores original uploads, web-friendly derivatives, thumbnails, and asset metadata JSON.
- **Server Actions / Route Handlers** - Next.js API routes (see Section 6) perform privileged operations using Firebase Admin SDK credentials.

### 4.3 AI & OCR
- **Baseline OCR**: stored in `receipt.ocr` fields (source `vision`, `manual`, etc.).
- **Enhancement**: `/api/ocr/enhance` triggers Gemini normalization when feature flag is on.
- **Duplicate Detection**: SHA-256 for exact matches; perceptual hash (pHash) with configurable Hamming threshold for near duplicates.

## 5. User Experience Flows

### 5.1 Authentication & Splash (`/splash`)
- Listens to Firebase auth state, loads Firestore role memberships, hydrates Redux slices, and routes users to their requested `next` path (default `/dashboard/upload`).
- Chooses an initial active store based on role priority (admin > manager > staff) and cached preference.

### 5.2 Onboarding (`/onboarding`)
- Shown when authenticated users lack store memberships.
- Allows store creation or invite acceptance (see invites API). Redirects to dashboard once membership exists.

### 5.3 Dashboard Modules

#### Upload (`/dashboard/upload`)
- **Store Selector**: derived from confirmed + optimistic memberships; can honour a `store` query param.
- **File Intake**: drag-and-drop or file picker; resets input after each selection.
- **Validation**: rejects oversized files (>20MB), warns on large resolutions, runs EXIF extraction and orientation adjustments.
- **Pre-processing**: generates WebP view/thumbnail, calculates SHA-256 and pHash, extracts shot timestamp.
- **Duplicate Detection**: compares against recent uploads per store and cached session data. Exact matches are blocked; likely duplicates flagged but allowed.
- **Upload Queue**: concurrency-limited (semaphore of 3); tracks progress, cancellation, and toasts.
- **Commit**: after Storage upload, calls `/api/receipts/assets/commit` to create receipt records and asset documents.
- **Recent Activity**: displays in-session history with status badges.

#### Receipts Detail (`/dashboard/receipts/[id]`)
- **Permission Gate**: denies access without store flag coverage; locked receipts are read-only.
- **Metadata Editing**: update payment method, link credit cards, override vendor name/id.
- **Locking Workflow**: `/api/receipts/lock` & `/unlock` enforce reviewed/locked transitions with audit fields (`lockedBy`, `lockedAt`).
- **Item Photos**: additional images managed separately from the original upload; supports duplicate detection, progress tracking, and Storage cleanup on failure.
- **AI Enhancement**: optional Gemini normalization; updates OCR fields while marking manual edits.
- **Summary Panel**: modular component for structured receipt data (totals, memo, etc.).

#### Settings (`/dashboard/settings`)
- **Tabs**: Payment Cards vs Vendors (only accessible with matching flags).
- **Credit Cards**: CRUD operations on shared cards, filtered by store; ensures last4/brand metadata.
- **Vendors**: Manage canonical vendor entries with normalized names and tags.
- **Sync Banner**: surfaces pending membership sync status when invites or role changes occur.

### 5.4 Stores & Invites
- `/stores/new` - create stores and assign initial members.
- `/invites` - manage outbound invitations; `/api/stores/[storeId]/invites` issue or revoke tokens.
- `/api/invites/accept` - accept invite tokens and attach memberships (requires auth).

### 5.5 Developer Tools (`/developer`)
- Sandbox utilities (feature flag toggles and debug aides) for internal use.

## 6. API Surface (Next.js Route Handlers)

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/users/me` | GET | Returns current user profile, permissions, and store memberships. |
| `/api/stores` | POST | Create stores (auth + admin only). |
| `/api/stores/[storeId]/members` | POST/DELETE | Add or remove store memberships. |
| `/api/stores/[storeId]/invites` | POST | Generate invite links/token; GET (if implemented) lists invites. |
| `/api/stores/[storeId]/invites/[inviteId]` | DELETE | Revoke invite. |
| `/api/invites/accept` | POST | Accept invite using token; writes membership + permissions. |
| `/api/receipts/lock` / `unlock` | POST | Transition receipt status (requires `perm.lock` / `perm.unlock`). |
| `/api/receipts/assets/commit` | POST | Persist uploaded asset metadata and update counts. |
| `/api/receipts/assets/delete` | POST | Remove supplemental asset and decrement counters. |
| `/api/receipts/export` | POST | Batch export receipts (CSV/PDF payload; see implementation). |
| `/api/ocr` | POST | Baseline OCR triggering (Vision pipeline). |
| `/api/ocr/enhance` | POST | Gemini enhancement with guardrails for rate limits and missing data. |
| `/api/ai/summarize` | POST | Summarise receipt data via AI (experimental). |

All APIs authenticate via Firebase ID tokens supplied in the `Authorization: Bearer` header; server-side logic uses Firebase Admin SDK for privileged operations.

## 7. Data Model Snapshot

### 7.1 Receipt (`/receipts/{id}`)
- `storeId`, `uploaderId`, `uploaderName`, `companyName`
- `createdAt`, `updatedAt`, `status` (`draft`, `reviewed`, `locked`)
- `sourceType` (`receipt`, `passbook`, `label`)
- File paths: `filePath`, `viewPath`, `thumbPath` (+ derived `ReceiptFileInfo`)
- `paymentMethod` (`cash`, `credit`, `bank`, `other`; optional `cardId`)
- `summary` & `ocr` structs for extracted data
- `meta` (hashes, dimensions, EXIF timestamp, transcription flags)
- Fraud flags & asset counters (`assetsCount`, `lastAssetAt`)

### 7.2 Receipt Asset (`/receipts/{id}/assets/{assetId}`)
- `kind: "itemPhoto"`
- Storage paths (`filePath`, `viewPath`, `thumbPath`)
- `meta` (sha256, phash, dimensions, EXIF shot time)
- `uploaderId`, `createdAt`

### 7.3 Supporting Collections
- `creditCards` (brand, last4, nickname, store scoping)
- `vendors` (displayName, normalized, tags)
- `userPermissions` (storeIds, flags, activeStoreId)
- `roleTemplates` (predefined flag bundles)
- `userStoreRoles` (per-store role assignments; consumed during splash preload)

## 8. Known Gaps & Future Enhancements

- **Product photos**: the codebase mentions potential item photo extensions but lacks dedicated workflows (e.g., per-product SKUs). Work would involve new asset kinds and upload UI variants.
- **Specification coverage**: this document mirrors current behaviour; keep it updated when flows change (e.g., adding expense categories, reimbursement states, or analytics dashboards).
- **Testing & QA**: limited automated testing detected. Introduce integration tests for upload, invites, and locking logic.
- **Internationalisation**: strings are hard-coded in English; consider locale support for Japanese end users.
- **Mobile ergonomics**: evaluate responsive behaviour for receipt upload on phones/tablets.

## 9. References

- Frontend source: `src/app/**`, `src/lib/**`
- Types: `src/types/**`
- Firebase configuration: `src/lib/firebase`
- Assets & utilities: `src/lib/imageUtil`, `src/lib/storagePaths`, `src/lib/fileNamer`

---
Maintain this specification alongside feature development to ensure product, engineering, and operations share the same mental model of the platform.

