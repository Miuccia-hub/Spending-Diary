import OpenAI from "openai";
import { getUser } from "@netlify/identity";
import type { Config, Context } from "@netlify/functions";

// Data URLs count towards the AI Gateway request-size allowance. The client
// compresses to this limit before sending, rather than passing full camera files.
const MAX_DATA_URL_CHARS = 900_000;
const SCAN_MODEL = "gpt-5-mini";
const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * A receipt often prints the items at their regular prices and puts the deal
 * immediately below them (for example: two A$6 Arnott's items followed by
 * "ARNOTTS 2 FOR $8  -4.00"). Keep the reduction as an explicit line so the
 * ledger remains auditable, but name and validate its relationship correctly.
 */
function normalizeAdjacentPromotion(receipt: any) {
  if (!Array.isArray(receipt?.items)) return receipt;
  const notes = Array.isArray(receipt.notes) ? receipt.notes : [];

  receipt.items.forEach((item: any, index: number) => {
    const rawName = String(item?.name || "");
    const deal = rawName.match(/\b(\d+)\s*(?:FOR|X)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
    const discount = Number(item?.amount);
    if (!deal || !Number.isFinite(discount) || discount >= 0) return;

    const quantity = Number(deal[1]);
    const bundlePrice = Number(deal[2]);
    const preceding = receipt.items
      .slice(0, index)
      .filter((candidate: any) => Number(candidate?.amount) > 0)
      .slice(-quantity);
    const regularTotal = preceding.reduce((sum: number, candidate: any) => sum + Number(candidate.amount), 0);
    const equalUnitPrices = preceding.length === quantity && preceding.every((candidate: any) => Math.abs(Number(candidate.amount) - Number(preceding[0].amount)) < 0.01);
    const expectedDiscount = Math.round((bundlePrice - regularTotal) * 100) / 100;
    const brand = String(preceding[0]?.name || rawName).match(/[A-Za-z][A-Za-z'’&-]*/)?.[0] || "相邻商品";

    if (equalUnitPrices && Math.abs(discount - expectedDiscount) < 0.01) {
      item.cn = `${brand} ${quantity}件组合优惠（${quantity}件$${bundlePrice.toFixed(2)}）`;
      item.category = preceding[0]?.category || "其他";
      item.asset = false;
      item.needsReview = false;
      notes.push(`${brand}：${quantity} 件原价合计 ${regularTotal.toFixed(2)}，组合价 ${bundlePrice.toFixed(2)}，优惠 ${Math.abs(discount).toFixed(2)}。`);
    } else {
      item.cn = "组合优惠（请核对适用商品）";
      item.asset = false;
      item.needsReview = true;
      notes.push(`检测到“${rawName}”优惠行，但未能可靠匹配相邻商品；请核对。`);
    }
  });

  receipt.notes = [...new Set(notes)];
  return receipt;
}

export default async (req: Request, _context: Context) => {
  const user = await getUser();
  if (!user) return json({ error: "请先登录，再扫描小票。" }, 401);

  let body: { image?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "上传内容格式不正确。" }, 400);
  }

  if (!body.image || !body.mimeType || !supportedTypes.has(body.mimeType)) {
    return json({ error: "请上传 JPG、PNG 或 WebP 格式的小票图片。" }, 422);
  }
  if (!body.image.startsWith(`data:${body.mimeType};base64,`) || body.image.length > MAX_DATA_URL_CHARS) {
    return json({ error: "图片仍然过大。请裁剪到小票区域后重新上传。" }, 413);
  }

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: SCAN_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You extract receipt facts. Return valid JSON only with this exact shape:
{"merchant":"string or 未识别","date":"YYYY-MM-DD or empty string","currency":"ISO 3-letter code","total":number or null,"items":[{"name":"verbatim item name","cn":"concise Chinese item name","amount":number or null,"category":"餐饮|日用|购物|交通|学习|其他","asset":boolean,"needsReview":boolean}],"confidence":"high|medium|low","notes":["string"]}.
Read only visible receipt information. Never invent merchant, date, item names, prices, quantities, discounts, currency, or totals. For every item, return cn as the concise Chinese name a Chinese shopper would naturally use: use retailer context, brand/model and product purpose to find the appropriate name, not a word-for-word machine translation. Keep an already-Chinese name unchanged; retain important brand/model information; if an abbreviated OCR code is genuinely ambiguous, write a brief descriptive Chinese name and set needsReview true rather than making up a specific product.

CRITICAL RECEIPT-MATH RULE: inspect the order of receipt rows, not just each row independently. If two or more immediately preceding product rows have the same brand and the same regular price, and the next visible row says a deal such as “2 FOR $8”, “3 FOR $10”, MULTIBUY, member offer, or a discount, associate that negative row with those preceding items. Example: two Arnott's products at $6.00 each followed by “ARNOTTS 2 FOR $8” at -$4.00 means merchandise $6.00 + $6.00 and one separate “Arnott's 两件组合优惠（2件$8）” line -$4.00, for a final $8.00. Never attach that -$4.00 to the next product on the receipt, and never identify the promotion as a product. Treat bundle deals, multi-buy promotions, coupons, loyalty discounts, price reductions, and rounding as separate visible promotion lines with a negative amount and an appropriate Chinese name. When a receipt shows a bundle price, preserve all visible regular prices plus the negative promotion, and include the arithmetic in notes. Set asset true only for durable non-consumable items, including clothes, shoes, bags, electronics, furniture, and appliances; set false for food, drinks, groceries, transport, services, promotions and other consumables. Include tax, fees, tips, discounts, and rounding only if they visibly appear. If the receipt text is not legible, return an empty items array and explain in notes.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract this receipt for a personal expense ledger." },
            { type: "image_url", image_url: { url: body.image, detail: "high" } },
          ],
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("模型没有返回识别结果。");
    const receipt = normalizeAdjacentPromotion(JSON.parse(raw));
    if (!Array.isArray(receipt.items) || typeof receipt.merchant !== "string") throw new Error("识别结果格式异常。");
    return json({ receipt, model: SCAN_MODEL });
  } catch (error) {
    console.error("receipt scan failed", error);
    return json({ error: "AI 识别暂不可用。请稍后重试，或手动记账。" }, 502);
  }
};

export const config: Config = {
  path: "/api/scan-receipt",
  method: ["POST"],
};
