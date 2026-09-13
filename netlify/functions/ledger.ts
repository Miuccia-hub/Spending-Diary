import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";
import type { Config, Context } from "@netlify/functions";

type LedgerDocument = {
  entries: unknown[];
  assets: unknown[];
  updatedAt: string;
};

const store = getStore({ name: "student-ledgers", consistency: "strong" });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req: Request, _context: Context) => {
  const user = await getUser();
  if (!user) return json({ error: "需要登录后才能访问账本。" }, 401);

  const key = `users/${user.id}/ledger.json`;

  if (req.method === "GET") {
    const ledger = await store.get(key, { type: "json" }) as LedgerDocument | null;
    return json(ledger ?? { entries: [], assets: [], updatedAt: null });
  }

  if (req.method === "PUT") {
    let body: Partial<LedgerDocument>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "账本数据格式不正确。" }, 400);
    }

    if (!Array.isArray(body.entries) || !Array.isArray(body.assets) || body.entries.length > 5000 || body.assets.length > 2000) {
      return json({ error: "账本数据无效或超出支持范围。" }, 422);
    }

    const ledger: LedgerDocument = { entries: body.entries, assets: body.assets, updatedAt: new Date().toISOString() };
    await store.setJSON(key, ledger);
    return json({ ok: true, updatedAt: ledger.updatedAt });
  }

  return json({ error: "不支持的请求方式。" }, 405);
};

export const config: Config = {
  path: "/api/ledger",
  method: ["GET", "PUT"],
};
