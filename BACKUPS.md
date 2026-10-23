# SalonBill — data protection & backups

Salon data lives in **three** places on purpose. Any one of them can be lost;
all three going down at once is what "backup" means here.

| Layer | Where | When it runs | How to use it |
| --- | --- | --- | --- |
| 1. Cloud sync copy | Cloudflare **D1** (sync store) | Continuous (every edit syncs) | Automatic |
| 2. Nightly cloud snapshot | Cloudflare **R2** bucket `BACKUPS` | Daily (first sync of the day) | Settings → *Cloud backup* |
| 3. Off-platform copy | Your email / Google Drive | Monthly (you press the button) | Settings → *Monthly off-platform copy* |

Plus: **D1 Time Travel** (platform-level point-in-time restore) and the
device-local IndexedDB backup in Settings.

---

## 1. Mandatory cloud copy (device gate)

- Billing stays **locked** until the device has the salon PIN and its **first
  sync succeeds**. First device in the salon sets the PIN; every other device
  uses the same one.
- The status pill top-right shows reality:
  `Online · last sync 2 min ago` or `Offline · 4 bills waiting`.
- A red banner appears if the counter **hasn't synced for 24 h**.
- Offline billing still works (that's the point of the local database) — it is
  simply flagged until it reaches the cloud.

## 2. Staff identity

- Settings → **Staff & PINs**: give each staff member their own 4-digit PIN.
- Every bill is stamped with the signed-in **cashier** (bill, receipt, PDF,
  monthly totals). Staff without a PIN are not prompted.
- **Owner PIN** is required for: cancelling bills, monthly totals, exports,
  restore, and Settings. Change the default `1234` before going live.

## 3. Nightly cloud snapshot (R2)

- Triggered automatically by the first successful sync of each day
  (the deploy platform has no cron trigger; sync traffic drives it — the salon
  app is open daily, so the snapshot is taken daily).
- Files in the `BACKUPS` R2 bucket:
  - `daily/salonbill-YYYY-MM-DD.json` — full restore-ready JSON
  - `daily/salonbill-YYYY-MM-DD-bills.csv` — bills spreadsheet
  - `monthly/salonbill-YYYY-MM.json` — rolling monthly snapshot
  - `meta/last.json` — when the last backup ran
- **Retention: 13 months** (files older than 400 days are deleted automatically).
- Settings → *Cloud backup* shows the last run and has a **Back up now** button.

## 4. D1 Time Travel (point-in-time restore)

Cloudflare keeps a short history of the D1 database itself (retention depends
on your Workers plan — check the Workers dashboard or:

```sh
npx wrangler d1 time-travel info <DB_NAME> --remote
```

Use it when rows were corrupted/deleted in the *last few days* — it restores
the whole database to an exact timestamp:

```sh
npx wrangler d1 time-travel restore <DB_NAME> <TIMESTAMP_UTC> --remote
```

For anything older than the retention window, restore from an R2 snapshot
(layer 2) instead.

## 5. Off-platform copy (layer 3 — do this monthly)

On the owner device: **Settings → Backups → Monthly off-platform copy**. It
downloads two files (JSON + bills CSV). Email them to yourself or drop them in
Google Drive. This is the copy that survives losing the phone/tablet *and* the
Cloudflare account. Settings reminds you when 30 days pass without one.

## 6. Restore drill (every 3 months)

A backup you never restored is not proven.

1. **Settings → Backups → Run restore drill** — it exports this device,
   validates the export, restores it and compares bill counts. A pass is
   recorded; Settings nags after 90 days.
2. **Quarterly, also do the real drill** on a second device/browser:
   download the JSON backup → open the app there → Settings →
   *Restore from file…* → confirm the bill count matches. Nothing else
   exercises the path your disaster would use.

## 7. Device hygiene (the counter tablet/phone)

- **Never** browse in Incognito/Private mode (the app warns if you do).
- **Never** use “Clear site data” / “Reset browser data” on this device.
- The app requests **persistent storage** so the browser won't auto-evict it,
  and can be **installed as an app** (Settings → Device safety).
- Don't clear the app from *recent apps* while a bill is open — drafts are
  autosaved, but a normal tab close is always safer.

## 8. Deploy rule (Dexie schema / sync changes)

Before every deploy that touches `src/lib/db.ts`, `src/lib/lease.ts`,
`src/lib/syncClient.ts`, `src/syncFns.ts` or `src/server/*`:

1. Take a **JSON backup** on the owner device (Settings → Backups) and keep it
   off the device.
2. Run the deploy with the acknowledgement flag:
   `node scripts/sync-deploy.cjs <dir> --ack-export`
   (the script refuses otherwise; `git`-less environments skip the check).
3. Migrations must be **additive** — new Dexie `version()` blocks that add
   tables/fields only (see `src/lib/db.ts` v2/v3 as models). Never rewrite
   historical rows in a migration.
