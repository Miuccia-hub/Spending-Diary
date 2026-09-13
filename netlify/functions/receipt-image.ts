import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";
import type { Config, Context } from "@netlify/functions";

const store = getStore({ name: "student-receipts", consistency: "strong" });
const MAX_DATA_URL_CHARS = 900_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function keyFor(userId: string, receiptId: string) {
  return `users/${userId}/receipts/${receiptId}.jpg`;
}

export default async (req: Request, _context: Context) => {
  const user = await getUser();
  if (!user) return json({ error: "请先登录。" }, 401);

  if (req.method === "POST") {
    let body: { image?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "图片数据格式不正确。" }, 400);
    }
    if (!body.image?.startsWith("data:image/jpeg;base64,") || body.image.length > MAX_DATA_URL_CHARS) {
      return json({ error: "小票图片无效或过大。" }, 422);
    }

    const receiptId = crypto.randomUUID();
    const base64 = body.image.slice("data:image/jpeg;base64,".length);
    await store.set(keyFor(user.id, receiptId), Buffer.from(base64, "base64"), {
      metadata: { contentType: "image/jpeg", uploadedAt: new Date().toISOString() },
    });
    return json({ receiptId });
  }

  if (req.method === "GET") {
    const receiptId = new URL(req.url).searchParams.get("id") || "";
    if (!/^[0-9a-f-]{36}$/i.test(receiptId)) return json({ error: "凭证编号无效。" }, 400);
    const image = await store.get(keyFor(user.id, receiptId), { type: "blob" });
    if (!image) return json({ error: "未找到这张小票。" }, 404);
    return new Response(image, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Disposition": "inline; filename=receipt.jpg",
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (req.method === "DELETE") {
    const receiptId = new URL(req.url).searchParams.get("id") || "";
    if (!/^[0-9a-f-]{36}$/i.test(receiptId)) return json({ error: "凭证编号无效。" }, 400);
    await store.delete(keyFor(user.id, receiptId));
    return json({ ok: true });
  }

  return json({ error: "不支持的请求方式。" }, 405);
};

export const config: Config = {
  path: "/api/receipt-image",
  method: ["GET", "POST", "DELETE"],
};
