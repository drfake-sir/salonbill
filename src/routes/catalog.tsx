import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, Percent } from "lucide-react";
import { toast } from "sonner";
import { db, logAudit } from "@/lib/db";
import { OwnerOnly } from "@/components/PinGate";

export const Route = createFileRoute("/catalog")({
  head: () => ({
    meta: [
      { title: "Catalog — SalonBill" },
      { name: "description", content: "Edit salon services, prices, products and stylists." },
      { property: "og:title", content: "Catalog — SalonBill" },
      { property: "og:description", content: "Owner-editable services, products and stylists." },
    ],
  }),
  component: () => (
    <OwnerOnly>
      <Catalog />
    </OwnerOnly>
  ),
});

const cell =
  "h-11 min-w-0 rounded-xl border border-input bg-card px-3 outline-none focus:ring-2 focus:ring-ring";
const num = `${cell} w-full sm:w-24`;
const pill = "tap shrink-0 rounded-xl bg-secondary px-3 text-sm";

function Catalog() {
  const cats = useLiveQuery(() => db.categories.orderBy("order").toArray(), []) ?? [];
  const services = useLiveQuery(() => db.services.toArray(), []) ?? [];
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const stylists = useLiveQuery(() => db.stylists.toArray(), []) ?? [];
  const [tab, setTab] = useState<"services" | "products" | "stylists">("services");

  const setPrice = async (id: number, name: string, old: number, price: number) => {
    if (price === old) return;
    if (!Number.isFinite(price) || price < 0) {
      toast.error("Price must be zero or more");
      return;
    }
    await db.services.update(id, { price });
    await logAudit("service.price", `${name}: ${old} → ${price}`);
    toast.success(`${name} now ₹${price} (future bills only)`);
  };
  const bulk = async (categoryId: number) => {
    const pct = Number(prompt("Change prices in this category by % (e.g. 10 or -5)"));
    if (!Number.isFinite(pct) || !pct) return;
    await db.services
      .where("categoryId")
      .equals(categoryId)
      .modify((s) => {
        s.price = Math.max(0, Math.round(s.price * (1 + pct / 100)));
      });
    await logAudit("service.bulk", `category ${categoryId}: ${pct}%`);
    toast.success(`Prices updated by ${pct}%`);
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-extrabold tracking-tight">Catalog</h1>
        <div className="flex rounded-2xl bg-card p-1 shadow-soft">
          {(["services", "products", "stylists"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`tap rounded-xl px-4 py-2 text-sm font-semibold capitalize ${tab === t ? "bg-primary text-primary-foreground" : ""}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "services" && (
        <div className="space-y-6">
          {cats.map((c) => (
            <section key={c.id} className="rounded-3xl bg-card p-4 shadow-soft sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold">{c.name}</h2>
                <div className="flex gap-2">
                  <button
                    onClick={() => bulk(c.id!)}
                    className={`tap flex items-center gap-1 ${pill}`}
                  >
                    <Percent className="size-4" />
                    Bulk price
                  </button>
                  <button
                    onClick={() =>
                      db.services.add({
                        name: "New service",
                        categoryId: c.id!,
                        price: 0,
                        duration: 30,
                        gstRate: 18,
                        commissionPct: 10,
                        active: true,
                      })
                    }
                    className="tap flex shrink-0 items-center gap-1 rounded-xl bg-accent px-3 text-sm font-semibold text-accent-foreground"
                  >
                    <Plus className="size-4" />
                    Add
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {services
                  .filter((s) => s.categoryId === c.id)
                  .map((s) => (
                    <div
                      key={s.id}
                      className={`flex flex-wrap items-center gap-2 ${s.active ? "" : "opacity-50"}`}
                    >
                      <input
                        defaultValue={s.name}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v) db.services.update(s.id!, { name: v });
                        }}
                        className={`${cell} w-full basis-48 sm:flex-1`}
                      />
                      <input
                        type="number"
                        min={0}
                        defaultValue={s.price}
                        onBlur={(e) => setPrice(s.id!, s.name, s.price, Number(e.target.value))}
                        className={num}
                        aria-label="Price"
                      />
                      <input
                        type="number"
                        min={0}
                        defaultValue={s.duration}
                        onBlur={(e) => {
                          const v = Math.max(0, Number(e.target.value));
                          if (Number.isFinite(v)) db.services.update(s.id!, { duration: v });
                        }}
                        className={num}
                        aria-label="Minutes"
                      />
                      <button
                        onClick={() => db.services.update(s.id!, { active: !s.active })}
                        className={pill}
                      >
                        {s.active ? "Disable" : "Enable"}
                      </button>
                    </div>
                  ))}
              </div>
            </section>
          ))}
          <button
            onClick={() => {
              const name = prompt("Category name?");
              if (name) db.categories.add({ name, order: cats.length });
            }}
            className="tap w-full rounded-3xl border-2 border-dashed py-3 text-muted-foreground"
          >
            + Add category
          </button>
        </div>
      )}

      {tab === "products" && (
        <section className="space-y-2 rounded-3xl bg-card p-4 shadow-soft sm:p-5">
          {products.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2">
              <input
                defaultValue={p.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v) db.products.update(p.id!, { name: v });
                }}
                className={`${cell} w-full basis-48 sm:flex-1`}
              />
              <input
                type="number"
                min={0}
                defaultValue={p.price}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0) db.products.update(p.id!, { price: v });
                }}
                className={num}
                aria-label="Price"
              />
              <input
                type="number"
                min={0}
                defaultValue={p.stock}
                onBlur={(e) => {
                  const v = Math.max(0, Math.floor(Number(e.target.value)));
                  if (Number.isFinite(v)) db.products.update(p.id!, { stock: v });
                }}
                className={`${num} ${p.stock <= p.lowStock ? "border-destructive text-destructive" : ""}`}
                aria-label="Stock"
              />
              <button
                onClick={() => db.products.update(p.id!, { active: !p.active })}
                className={pill}
              >
                {p.active ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
          <button
            onClick={() =>
              db.products.add({
                name: "New product",
                price: 0,
                stock: 0,
                lowStock: 2,
                gstRate: 18,
                active: true,
              })
            }
            className="tap mt-2 rounded-xl bg-accent px-4 py-2 font-semibold text-accent-foreground"
          >
            + Add product
          </button>
        </section>
      )}

      {tab === "stylists" && (
        <section className="space-y-2 rounded-3xl bg-card p-4 shadow-soft sm:p-5">
          {stylists.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2">
              <input
                defaultValue={s.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v) db.stylists.update(s.id!, { name: v });
                }}
                className={`${cell} w-full basis-40 sm:flex-1`}
              />
              <input
                defaultValue={s.phone}
                onBlur={(e) => db.stylists.update(s.id!, { phone: e.target.value.trim() })}
                className={`${cell} w-full basis-36 sm:w-36`}
                aria-label="Phone"
              />
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={s.commissionPct}
                onBlur={(e) => {
                  const v = Math.min(100, Math.max(0, Number(e.target.value) || 0));
                  db.stylists.update(s.id!, { commissionPct: v });
                }}
                className={num}
                aria-label="Commission %"
              />
              <button
                onClick={() => db.stylists.update(s.id!, { active: !s.active })}
                className={pill}
              >
                {s.active ? "Disable" : "Enable"}
              </button>
              <Link
                to="/earnings"
                search={{ stylist: s.id ?? 0 }}
                className="tap shrink-0 rounded-xl bg-accent px-3 text-sm font-semibold text-accent-foreground"
              >
                Earnings
              </Link>
            </div>
          ))}
          <button
            onClick={() =>
              db.stylists.add({ name: "New stylist", phone: "", commissionPct: 10, active: true })
            }
            className="tap mt-2 rounded-xl bg-accent px-4 py-2 font-semibold text-accent-foreground"
          >
            + Add stylist
          </button>
        </section>
      )}
    </div>
  );
}
