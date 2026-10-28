/**
 * In-app "send this bill on WhatsApp" dialog for bills whose row has no
 * customer phone (Bills list).
 *
 * Replaces the old `toast.error("This bill has no customer phone number")`
 * dead end: the staff types the number right here (+91 fixed, 10 digits,
 * numeric keypad), hits Send, and the normal PDF/WhatsApp share path runs.
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

  const send = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      // Optional, off by default: only a ticked box saves the number, and
      // only to the customer — never onto the bill itself.
      if (saveToCustomer && named) {
        if (bill.customerId != null) {
          await db.customers.update(bill.customerId, { phone });
        } else if (bill.customerName) {
          await db.customers.add({ name: bill.customerName, phone, createdAt: Date.now() });
        }
      }
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
              : "This bill has no customer number yet — enter it to send the bill PDF."}
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
          <button
            onClick={() => void send()}
            disabled={!valid || busy}
            className="tap rounded-xl bg-primary px-5 py-2.5 font-semibold text-primary-foreground disabled:opacity-60"
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
