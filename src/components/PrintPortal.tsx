import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders its children as a direct child of <body>, hidden on screen and shown
 * only by the print stylesheet. Printing from deep inside the app layout (fixed
 * nav, scrollable panels, open bottom sheets) otherwise creates blank pages or
 * clipped receipts, especially on phones and tablets.
 */
export function PrintPortal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.body);
  }, []);
  if (!host) return null;
  return createPortal(<div id="receipt-print">{children}</div>, host);
}
