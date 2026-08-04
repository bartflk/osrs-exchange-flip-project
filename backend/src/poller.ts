import { fetchMapping, fetchLatest, fetchWindow } from "./wiki.js";
import { upsertItems, upsertSnapshots } from "./db.js";

export async function pollMapping() {
  const mapping = await fetchMapping();
  upsertItems(
    mapping.map((m) => ({
      id: m.id,
      name: m.name,
      examine: m.examine ?? null,
      members: m.members ? 1 : 0,
      lowalch: m.lowalch ?? null,
      highalch: m.highalch ?? null,
      buy_limit: m.limit ?? null,
      value: m.value ?? 0,
      icon: m.icon ?? "",
    }))
  );
  console.log(`[poller] mapping refreshed: ${mapping.length} items`);
}

export async function pollPrices() {
  const [latest, win5m, win1h] = await Promise.all([
    fetchLatest(),
    fetchWindow("5m"),
    fetchWindow("1h"),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const ids = new Set([...Object.keys(latest), ...Object.keys(win5m), ...Object.keys(win1h)]);

  const rows = [...ids].map((idStr) => {
    const id = Number(idStr);
    const l = latest[idStr];
    const w5 = win5m[idStr];
    const w1 = win1h[idStr];
    return {
      item_id: id,
      high: l?.high ?? null,
      high_time: l?.highTime ?? null,
      low: l?.low ?? null,
      low_time: l?.lowTime ?? null,
      avg_high_5m: w5?.avgHighPrice ?? null,
      avg_low_5m: w5?.avgLowPrice ?? null,
      vol_high_5m: w5?.highPriceVolume ?? 0,
      vol_low_5m: w5?.lowPriceVolume ?? 0,
      avg_high_1h: w1?.avgHighPrice ?? null,
      avg_low_1h: w1?.avgLowPrice ?? null,
      vol_high_1h: w1?.highPriceVolume ?? 0,
      vol_low_1h: w1?.lowPriceVolume ?? 0,
      updated_at: now,
    };
  });

  upsertSnapshots(rows);
  console.log(`[poller] prices refreshed: ${rows.length} items @ ${new Date().toISOString()}`);
}

export function startPolling() {
  // mapping changes rarely -- once at boot, then once a day
  pollMapping().catch((err) => console.error("[poller] mapping error", err));
  setInterval(() => {
    pollMapping().catch((err) => console.error("[poller] mapping error", err));
  }, 24 * 60 * 60 * 1000);

  // prices: poll every 60s
  pollPrices().catch((err) => console.error("[poller] prices error", err));
  setInterval(() => {
    pollPrices().catch((err) => console.error("[poller] prices error", err));
  }, 60 * 1000);
}
