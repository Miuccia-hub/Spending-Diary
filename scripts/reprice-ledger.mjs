import { execFileSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const wrangler = "./node_modules/.bin/wrangler";
const database = "liuxue-spending-diary";

function runWrangler(args) {
  return execFileSync(wrangler, args, { encoding: "utf8", maxBuffer: 10_000_000 });
}

function query(sql) {
  const output = runWrangler(["d1", "execute", database, "--remote", "--command", sql, "--json"]);
  const batches = JSON.parse(output);
  return batches.flatMap(batch => batch.results || []);
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const rateCache = new Map();
async function rateFor(currency, requestedDate) {
  const base = String(currency || "AUD").toUpperCase();
  const key = `${base}:${requestedDate}`;
  if (rateCache.has(key)) return rateCache.get(key);
  if (base === "CNY") {
    const identity = { rate: 1, rateDate: requestedDate, source: "identity" };
    rateCache.set(key, identity);
    return identity;
  }
  if (!["AUD", "USD", "GBP"].includes(base)) throw new Error(`Unsupported currency ${base}`);
  const response = await fetch(`https://api.frankfurter.dev/v1/${requestedDate}?base=${encodeURIComponent(base)}&symbols=CNY`);
  if (!response.ok) throw new Error(`Rate lookup failed for ${key}: ${response.status}`);
  const result = await response.json();
  const rate = Number(result?.rates?.CNY);
  const rateDate = String(result?.date || "");
  if (!Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) throw new Error(`Invalid rate for ${key}`);
  const quote = { rate, rateDate, source: "Frankfurter daily reference rate" };
  rateCache.set(key, quote);
  return quote;
}

const ledgers = query("SELECT user_id, entries_json, assets_json FROM ledgers");
const summaries = [];
for (const ledger of ledgers) {
  const entries = JSON.parse(ledger.entries_json || "[]");
  const assets = JSON.parse(ledger.assets_json || "[]");
  const originalCount = entries.length;
  const originalAmount = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const originalCny = entries.reduce((sum, entry) => sum + Number(entry.cny || 0), 0);
  let repriced = 0;
  for (const entry of entries) {
    const date = String(entry.date || "").replaceAll(".", "-");
    const amount = Number(entry.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount)) throw new Error(`Entry ${entry.id} has an invalid date or amount`);
    const quote = await rateFor(entry.currency || "AUD", date);
    entry.cny = amount * quote.rate;
    entry.exchangeRate = quote.rate;
    entry.rateDate = quote.rateDate;
    entry.rateSource = quote.source;
    repriced += 1;
  }
  const byEntryId = new Map(entries.map(entry => [String(entry.id), entry]));
  for (const asset of assets) {
    const entry = byEntryId.get(String(asset.entryId));
    if (entry) asset.cny = `¥${Number(entry.cny).toFixed(2)}`;
  }
  const finalAmount = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const finalCny = entries.reduce((sum, entry) => sum + Number(entry.cny || 0), 0);
  if (entries.length !== originalCount || Math.abs(finalAmount - originalAmount) > 0.000001) throw new Error("Safety check failed: entry count or original-currency total changed");
  summaries.push({ entries: originalCount, repriced, assetsUpdated: assets.filter(asset => byEntryId.has(String(asset.entryId))).length, datesAndCurrencies: rateCache.size, originalAmount: Number(originalAmount.toFixed(2)), originalCny: Number(originalCny.toFixed(2)), finalCny: Number(finalCny.toFixed(2)), cnyDifference: Number((finalCny - originalCny).toFixed(2)) });
  if (apply) {
    const sql = `UPDATE ledgers SET entries_json = ${sqlText(JSON.stringify(entries))}, assets_json = ${sqlText(JSON.stringify(assets))}, updated_at = ${sqlText(new Date().toISOString())} WHERE user_id = ${sqlText(ledger.user_id)}`;
    runWrangler(["d1", "execute", database, "--remote", "--command", sql, "--json"]);
  }
}

console.log(JSON.stringify({ mode: apply ? "applied" : "preview", ledgers: ledgers.length, summaries }, null, 2));
