# SalonBill — Quick Billing for salons

Offline-first point-of-sale for Indian salons. Bill in seconds at the counter, keep working
with no internet, and have every bill copied to the salon cloud so the whole team shares one
book of business.

Built for a real counter: fast staff sign-in, per-service commission, GST receipts, WhatsApp
PDF sharing, and CSV exports your accountant can actually open.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) (SSR, file-based routes) |
| UI | React 19, Tailwind CSS 4, Radix UI, lucide-react |
| Local data | Dexie / IndexedDB (`salonbill` database) |
| Server | Nitro → Cloudflare Workers (workerd) |
| Cloud sync | Cloudflare D1 (SQLite) via TanStack server functions |
| Nightly backup | Cloudflare R2 |
| Print / PDF | jsPDF + html2canvas-pro |
| Tests | Vitest + Testing Library (jsdom) |

---

## Getting started

```sh
npm i
npm run dev          # Vite dev server (fast UI iteration)
```

> **Sync needs the Cloudflare runtime.** Plain `npm run dev` serves the SSR bundle from Node,
> where there is no `env.DB` binding — so the app connects but reports
> *"Cloud database is not available on this server"*. To exercise cloud sync, billing gates or
> exports against a real D1, run:
>
> ```sh
> npm run dev:worker   # builds, then serves on http://localhost:8787 with local D1 + R2
> ```
>
> `dev:worker` builds once and then serves; re-run it after edits.

### Requirements

- Node.js **22+** (Wrangler 4.x refuses to start below 22)
- npm 10+

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server — UI only, no D1 binding |
| `npm run dev:worker` | `vite build` then `wrangler dev` on `:8787` with local D1 + R2 |
| `npm run build` | Production build into `.output/` |
| `npm test` | Full Vitest suite |
| `npm run lint` | ESLint |
| `npm run format` | Prettier write |
| `node scripts/sync-deploy.cjs <dir>` | Package `.output` for a Sites deploy |

---

## Project layout

```
src/
  routes/          File-based pages: / (billing), /bills, /earnings, /catalog, /settings
  components/      AppShell, StaffGate (identity), SyncGate (cloud gate), ReceiptView, ui/
  lib/             db (Dexie + commitSale), billing (totals), earnings (commission),
                   attribution (stylist rules), export (CSV), lease (unique ids), syncClient
  server/          syncCore (protocol), d1Store (D1), memoryStore (tests), backup (R2)
  syncFns.ts       TanStack server functions — the only client→server surface
  server.ts        SSR entry; renders an error page on catastrophic failures
```

---

## Two identities, never mixed

This is the rule the whole app is built around:

| | Stored | Meaning |
| --- | --- | --- |
| **Stylist** | per line — `stylistId`, `stylistName` | **Who performed the service.** Drives commission. |
| **Cashier** | per bill — `cashierId`, `cashierName` | **Who was signed in** and rang the sale up. |

Consequences:

- A **signed-in stylist** gets their own identity pre-filled on every service line they add.
- The **owner** gets *no* default — they must pick a stylist on every service line, and saving
  is blocked until each one is attributed. Guessing would silently bill someone's commission
  to the wrong person.
- Any line can be reassigned before saving.
- Earnings cards, the bill-details screen and the CSV all read the **same per-line value**, so
  the three always agree to the rupee.
- Bills also carry `deviceName`, set the first time a device connects ("Counter",
  "Owner phone"). Bills from before multi-device support show **"Unknown device"** rather than
  borrowing another device's name.

The rules live in [`src/lib/attribution.ts`](src/lib/attribution.ts) so they are unit-tested
and cannot drift from the UI.

---

## Bill integrity

- **Append-only after save.** Cancel sets `status`, `cancelReason`, `cancelledBy`,
  `cancelledAt` and restores product stock — the original lines, totals, receipt, cashier and
  device are never rewritten or deleted. Cancelling requires the owner PIN and a reason, and
  writes to the audit log.
- **Globally unique bill numbers.** Devices lease disjoint blocks (`SB-0001`…) from the
  server, so two counters billing **offline at the same time** can never issue the same
  number. Offline allocation falls back to local max + 1 when the network is down, and the
  server floors every new block above the highest number it has already seen.
- **Stored on every bill:** `createdAt` (epoch, used for range maths) + `createdAtIso`
  (ISO-8601 with the IST offset), payment mode(s), every line with qty/rate/amount, discount,
  GST split, tip, total, customer, status.

---

## Cloud sync & offline safety

- **Salon PIN is 6–8 digits** (4 digits is brute-forceable from a phone). The server stores
  only a salt + SHA-256 hash.
- **Lockout:** 5 wrong attempts locks the salon PIN for 5 minutes, enforced *server-side* so a
  client cannot reset the counter. A successful auth clears it.
- **Never lock a returning device out.** Once a device has connected successfully even once,
  it is latched in — losing the network or a failed background sync never puts the counter
  back behind the connect screen. A first sync that never finished retries in the background
  with a banner, instead of blocking billing.
- **Error copy is specific:** *"Wrong PIN"*, *"No internet"*,
  *"Cloud database is not available on this server"*, *"Server error, try again"*. The real
  error always goes to the console.
- **Status is visible everywhere:** `Online · last sync 2 min ago` / `Offline · 4 bills
  waiting`. If changes sit unsynced for **more than 3 hours**, a warning banner says how many
  bills are stuck and reminds you they are only on this device.

### Sync protocol

Push/pull is last-writer-wins by server arrival time over a single `sb_rows` table keyed by
`(table, id)` with a server-assigned `server_at`. Deletes are tombstones so devices that
already pulled a row converge. A device's very first sync is *insert-if-absent* so a fresh
phone can never clobber edits that already exist in the cloud.

---

## Exports

Three artefacts, all CSV written as **UTF-8 with BOM** (so Excel reads `₹` and accented names
correctly), CRLF line endings, every field quoted, terminating newline.

**Earnings export** — one row per attributed service line:

```
Stylist, Cashier, Device, Bill No, Date, Time, Service, Qty, Rate, Amount,
Commission %, Commission amount, Tip share, Payment mode, Customer, Status
```

- Owner export ("All stylists") includes every stylist, each row carrying **its own line's**
  stylist.
- A stylist's own export contains **only their own lines**.
- **Cancelled bills never appear** here — `computeEarnings` only counts `paid`.
- Dates are `DD/MM/YYYY`, times zero-padded 24-hour `HH:mm:ss`, both in **IST**.
- Missing commission/cashier/device renders `not recorded`, never a guessed value.

**Bills export** (Settings) — the only file containing cancelled bills, with
`Status = cancelled` plus cancelled reason/by/at.

---

## GST

GST is a per-line rate. `computeTotals` applies any discount first, then adds GST on the
discounted value (exclusive pricing) and splits it equally into CGST + SGST. Toggling GST in
Settings only affects new calculations — historical bills store their own snapshot
(`receipt.gstOn`, per-line `gstRate`, and the computed split), so reprints never change.

---

## Testing

```sh
npm test
```

The suite is deliberately split along the fault lines of the app:

| File | Covers |
| --- | --- |
| `src/lib/attribution.test.ts` | Stylist defaults per login, owner-blocked billing, multi-stylist bills, never inventing a name |
| `src/lib/export.test.ts` | CSV columns, `DD/MM/YYYY` + `HH:mm:ss` IST, UTF-8 BOM, quoting, owner vs stylist export, cancelled-bill separation, append-only cancel, device/cashier stamp |
| `src/lib/earnings.test.ts` | Commission maths, tip split, IST week/month/year boundaries, legacy "not recorded" rows |
| `src/lib/billing.test.ts` | Totals, GST split, discount capping, WhatsApp text/links, bill numbering, backup validation |
| `src/lib/syncSafety.test.ts` | Error-message mapping, offline-after-first-connect latch, 3-hour warning, disjoint bill-number blocks across devices |
| `src/server/syncCore.test.ts` | PIN length, lockout + cooldown, push/pull convergence, tombstones, leases |
| `src/server/backup.test.ts` | D1 → R2 export shape |
| `src/test/app-routing.test.tsx` | Routes match without running loaders |

### Verifying a change

```sh
npm test && npx tsc --noEmit && npm run lint && npm run build
```

All four must pass.

---

## Backups

See [BACKUPS.md](BACKUPS.md). Summary:

- **JSON backup** (Settings → Backups) is the restore format — keep a copy off the device.
- **Nightly D1 → R2 export** runs automatically after the first successful sync of a new day.
- **30-day hygiene reminders** tell you when an off-platform copy is overdue.
- Restores replace local data but keep bill numbering monotonic, so a restore can never cause
  a future duplicate bill number.

---

## Deploying

```sh
npm run build
node scripts/sync-deploy.cjs <deploy-workspace-dir>
```

`scripts/sync-deploy.cjs` sanitises module filenames (Cloudflare rejects `@ + [ ]` in module
names), rewrites import specifiers to match, emits a manifest covering **every** module, and
**refuses to package schema/sync changes** until you pass `--ack-export` after taking a fresh
JSON export — deploys that touch the Dexie schema or sync code should only ship once the
owner's data is safe somewhere off-device.

---

## Notes on this checkout

- Not a git repository (arrived as a source zip) — the pre-deploy export guard falls back to a
  warning instead of failing.
- Local wrangler state lives in `.wrangler/` (D1, R2, KV); build output in `.output/`. Both are
  gitignored and are **not** part of a source archive.
- Seeded demo staff PINs are `1111 / 2222 / 3333 / 4444` and the default owner PIN is `1234`.
  **Change them before going live** (Settings → Staff & PINs / Owner PIN).

---

Built with TanStack Start, React, TypeScript and Tailwind CSS. Originally created in
[Lovable](https://lovable.dev).
