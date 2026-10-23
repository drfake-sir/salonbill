import { flushSync } from "react-dom";
import type { Bill } from "./db";

/**
 * Commit the receipt to the DOM synchronously, then print once the browser has
 * laid it out. The old fixed 80 ms delay raced React's render on slower devices
 * (phones/tablets), printing a blank or stale receipt.
 */
export function printBill(setBill: (b: Bill) => void, b: Bill) {
  flushSync(() => setBill(b));
  // rAF is throttled or suspended in a background/throttled tab, so a timer acts
  // as a fallback; a guard keeps the actual print to exactly one call.
  let printed = false;
  const go = () => {
    if (printed) return;
    printed = true;
    window.print();
  };
  requestAnimationFrame(go);
  setTimeout(go, 300);
}
