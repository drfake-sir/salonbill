/**
 * In-app "send this bill on WhatsApp" dialog for bills whose row has no
 * customer phone (Bills list).
 *
 * Replaces the old `toast.error("This bill has no customer phone number")`
 * dead end: the staff types the number right here (+91 fixed, 10 digits,
 * numeric keypad) and picks what to do with the bill:
 *
 *  - MAIN "WhatsApp": opens the customer's OWN chat directly (wa.me/91… with
 *    the plain-text bill pre-filled) — no "Send to" contact picker, and it
 *    works even when the number is not saved in the phone's contacts;
 *  - smaller "Share PDF": the existing PDF share path, unchanged (a PDF is an
 *    attachment, so it still goes through the native share sheet).
 *
 * Rules:
 *  - never window.prompt;
 *  - the typed number is NEVER written onto the bill row — it only rides
 *    along in memory as the WhatsApp recipient for this one send;
 *  - it reaches the customer record only when the optional box is ticked
 *    ("Save this number to the customer"), shown only for named customers;
 *  - a bill that already has a phone sends as before and can reopen this
 *    dialog via "Change number" (prefilled with the current number).
 */
import { useState } from "react";
import { toast } from "sonner";
import { db, type Bill, type Settings, type Stylist } from "@/lib/db";
import { shareBillPdf } from "@/lib/pdf";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { isValidPhone, normalizePhoneInput, PHONE_ERROR } from "@/lib/phoneInput";
import { waBillMessage, waLink } from "@/lib/billing";

export function SendBillDialog({
  bill,
  settings,
  stylists,
  onClose,
}: {
  bill: Bill;
  settings: Settings;
  stylists: Stylist[];
  onClose: () => void;
}) {
  const [phone, setPhone] = useState(() => normalizePhoneInput(bill.customerPhone ?? ""));
  const [saveToCustomer, setSaveToCustomer] = useState(false);
  const [busy, setBusy] = useState(false);

  const valid = isValidPhone(phone);
  const hasCurrent = Boolean(bill.customerPhone);
  const named = Boolean(bill.customerName);

  // Optional, off by default: only a ticked box saves the number, and
  // only to the customer — never onto the bill itself.
  const persistNumber = async () => {
    if (!saveToCustomer || !named) return;
    if (bill.customerId != null) {
      await db.customers.update(bill.customerId, { phone });
    } else if (bill.customerName) {
      await db.customers.add({ name: bill.customerName, phone, createdAt: Date.now() });
    }
  };

  /** MAIN action: open this customer's own chat with the bill pre-filled. */
  const openWhatsApp = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await persistNumber();
      // waLink() enforces exactly 10 digits (+91) and percent-encodes the
      // text, so every newline reaches WhatsApp as %0A.
      const url = waLink(phone, waBillMessage(bill, settings));
      if (!url) {
        toast.error(PHONE_ERROR);
        return;
      }
      // _blank + noopener: never hijack the POS screen away from the till.
      window.open(url, "_blank", "noopener");
      if (saveToCustomer && named) toast.success(`Number saved to ${bill.customerName}`);
      onClose();
    } catch (e) {
      console.error(e);
      toast.error("Could not open WhatsApp");
    } finally {
      setBusy(false);
    }
  };

  /** Second, smaller action: the existing PDF share path — unchanged. */
  const sharePdf = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await persistNumber();
      // Existing message + PDF share path; the typed number only selects
      // the WhatsApp recipient for this send (in-memory copy of the bill).
      const r = await shareBillPdf({ ...bill, customerPhone: phone }, settings, stylists);
      if (r === "shared") toast.success("Bill PDF shared on WhatsApp");
      else if (r === "downloaded")
        toast.info("Bill PDF saved — attach it in the customer's WhatsApp chat", {
          duration: 6000,
        });
      if (saveToCustomer && named) toast.success(`Number saved to ${bill.customerName}`);
      onClose();
    } catch (e) {
      console.error(e);
      toast.error("Could not create the bill PDF");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send {bill.number} on WhatsApp</DialogTitle>
          <DialogDescription>
            {hasCurrent
              ? `Current number +91 ${bill.customerPhone}. Change it below to send to a different number.`
              : "This bill has no customer number yet — enter it to open the customer's chat."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="flex h-11 shrink-0 items-center rounded-xl border border-input bg-secondary px-3 font-semibold">
              +91
            </span>
            <input
              value={phone}
              onChange={(e) => setPhone(normalizePhoneInput(e.target.value))}
              inputMode="numeric"
              autoComplete="tel-national"
              maxLength={10}
              aria-label="Customer phone"
              placeholder="10-digit number"
              className="h-11 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-base outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {phone.length > 0 && !valid && <p className="text-xs text-destructive">{PHONE_ERROR}</p>}
          {named && (
            <label className="flex cursor-pointer items-center gap-2.5 text-sm">
              <Checkbox
                checked={saveToCustomer}
                onCheckedChange={(v) => setSaveToCustomer(v === true)}
                aria-label="Save this number to the customer"
                className="size-5"
              />
              Save this number to the customer
            </label>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <button
            onClick={onClose}
            className="tap rounded-xl bg-secondary px-4 py-2.5 font-semibold"
          >
            Cancel
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => void sharePdf()}
              disabled={!valid || busy}
              className="tap rounded-xl border border-input bg-secondary px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
            >
              {busy ? "Working…" : "Share PDF"}
            </button>
            <button
              onClick={() => void openWhatsApp()}
              disabled={!valid || busy}
              className="tap rounded-xl bg-primary px-5 py-2.5 font-semibold text-primary-foreground disabled:opacity-60"
            >
              WhatsApp
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
