interface Env {
  DB: D1Database;
  AI: Ai;
  RECEIPTS: R2Bucket;
  ASSETS: Fetcher;
  AUTH_SECRET: string;
  OPENAI_API_KEY?: string;
}

type UserRow = {
  id: string; identifier: string; identifier_type: "email" | "phone"; password_hash: string; password_salt: string;
  full_name: string; country: string; display_currency: string;
};

const SESSION_COOKIE = "ledger_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const MAX_RECEIPT_IMAGE_BYTES = 5_000_000;
const MAX_SCAN_IMAGE_BYTES = 650_000;

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

const EXCHANGE_CURRENCIES = new Set(["AUD", "USD", "GBP", "CNY"]);
async function exchangeRate(request: Request) {
  const url = new URL(request.url);
  const base = String(url.searchParams.get("base") || "AUD").trim().toUpperCase();
  const quote = String(url.searchParams.get("quote") || "CNY").trim().toUpperCase();
  const requestedDate = String(url.searchParams.get("date") || "").trim();
  if (!EXCHANGE_CURRENCIES.has(base) || quote !== "CNY") return json({ error: "暂不支持这个币种的人民币换算。" }, 422);
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return json({ error: "汇率日期格式无效。" }, 422);
  if (base === quote) return json({ base, quote, requestedDate: requestedDate || null, rateDate: requestedDate || now().slice(0, 10), rate: 1, source: "identity" }, 200, { "Cache-Control": "public, max-age=86400" });

  const datePath = requestedDate || "latest";
  const endpoint = `https://api.frankfurter.dev/v1/${datePath}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`;
  const response = await fetch(endpoint, { headers: { Accept: "application/json" }, cf: { cacheEverything: true, cacheTtl: requestedDate ? 31_536_000 : 3_600 } });
  if (!response.ok) throw new Error(`汇率服务返回 ${response.status}`);
  const result = await response.json<any>();
  const rate = Number(result?.rates?.[quote]);
  const rateDate = String(result?.date || "");
  if (!Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) throw new Error("汇率服务未返回有效结果");
  return json({ base, quote, requestedDate: requestedDate || null, rateDate, rate, source: "Frankfurter daily reference rate" }, 200, { "Cache-Control": requestedDate ? "public, max-age=31536000, immutable" : "public, max-age=3600" });
}
function now() { return new Date().toISOString(); }
function bytesToBase64(bytes: Uint8Array) {
  // Spreading a full receipt image into fromCharCode can exceed the Worker
  // call-stack limit. Chunking keeps large JPEGs safe for OCR data URIs.
  let binary = ""; const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}
function base64ToBytes(value: string) { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
function base64UrlText(value: string) { return bytesToBase64(new TextEncoder().encode(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function textFromBase64Url(value: string) { const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4); return new TextDecoder().decode(base64ToBytes(padded)); }
function constantTimeEqual(left: string, right: string) { if (left.length !== right.length) return false; let result = 0; for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i); return result === 0; }
function normalizeIdentifier(value: unknown) {
  const input = String(value || "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) return { identifier: input.toLowerCase(), type: "email" as const };
  const compact = input.replace(/[\s()-]/g, "");
  const phone = compact.startsWith("+") ? compact : `+${compact}`;
  if (/^\+[1-9]\d{7,14}$/.test(phone)) return { identifier: phone, type: "phone" as const };
  throw new Error("请输入有效的邮箱地址或国际格式手机号。");
}
async function passwordHash(password: string, salt: string) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  // Cloudflare Workers currently caps PBKDF2 at 100,000 iterations.
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: base64ToBytes(salt), iterations: 100_000, hash: "SHA-256" }, material, 256);
  return bytesToBase64(new Uint8Array(bits));
}
async function signingKey(env: Env) { return crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
async function sign(value: string, env: Env) { return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(value)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function sessionFor(userId: string, env: Env) { const payload = base64UrlText(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })); return `${payload}.${await sign(payload, env)}`; }
async function sessionUserId(request: Request, env: Env) {
  const token = request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null; const [payload, signature] = token.split("."); if (!payload || !signature || !constantTimeEqual(signature, await sign(payload, env))) return null;
  try { const value = JSON.parse(textFromBase64Url(payload)); return value.exp > Math.floor(Date.now() / 1000) && typeof value.sub === "string" ? value.sub : null; } catch { return null; }
}
function cookie(value: string, request: Request, maxAge = SESSION_SECONDS) {
  // Browsers do not send Secure cookies back to an http://localhost preview.
  // Keep the attribute for every HTTPS deployment, including production.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}
function publicUser(row: UserRow) { return { id: row.id, email: row.identifier_type === "email" ? row.identifier : "", phone: row.identifier_type === "phone" ? row.identifier : "", userMetadata: { full_name: row.full_name, country: row.country, display_currency: row.display_currency } }; }
async function currentUser(request: Request, env: Env) { const id = await sessionUserId(request, env); return id ? env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>() : null; }
async function requireUser(request: Request, env: Env) { const user = await currentUser(request, env); if (!user) throw new Response(JSON.stringify({ error: "请先登录。" }), { status: 401, headers: { "Content-Type": "application/json" } }); return user; }
async function body(request: Request) { try { return await request.json<any>(); } catch { throw new Error("请求数据格式不正确。"); } }
function imageBytes(dataUrl: string, maxBytes = MAX_RECEIPT_IMAGE_BYTES) { const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || ""); if (!match) throw new Error("请上传 JPG、PNG 或 WebP 图片。"); const bytes = base64ToBytes(match[2]); if (bytes.byteLength > maxBytes) throw new Error("图片过大，请裁剪到小票区域后再试。"); return { bytes, contentType: `image/${match[1] === "jpeg" ? "jpeg" : match[1]}`, extension: match[1] === "jpeg" ? "jpg" : match[1] }; }

function normalizePromotion(receipt: any) {
  const notes = Array.isArray(receipt?.notes) ? receipt.notes : [];
  if (!Array.isArray(receipt?.items)) return receipt;
  receipt.items.forEach((item: any, index: number) => {
    const deal = String(item?.name || "").match(/\b(\d+)\s*(?:FOR|X)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
    const scannedAmount = Number(item?.amount); if (!deal || !Number.isFinite(scannedAmount)) return;
    const quantity = Number(deal[1]); const bundlePrice = Number(deal[2]);
    const preceding = receipt.items.slice(0, index).filter((candidate: any) => Number(candidate?.amount) > 0).slice(-quantity);
    const total = preceding.reduce((sum: number, candidate: any) => sum + Number(candidate.amount), 0);
    const equal = preceding.length === quantity && preceding.every((candidate: any) => Math.abs(Number(candidate.amount) - Number(preceding[0].amount)) < 0.01);
    const expected = Math.round((bundlePrice - total) * 100) / 100;
    const brand = String(preceding[0]?.name || item.name).match(/[A-Za-z][A-Za-z'’&-]*/)?.[0] || "相邻商品";
    const matchesDiscount = Math.abs(Math.abs(scannedAmount) - Math.abs(expected)) < 0.01;
    if (equal && expected < 0 && matchesDiscount) { item.amount = expected; item.cn = `${brand} ${quantity}件组合优惠（${quantity}件$${bundlePrice.toFixed(2)}）`; item.category = preceding[0]?.category || "其他"; item.asset = false; item.needsReview = false; notes.push(`${brand}：${quantity} 件原价 ${total.toFixed(2)}，组合价 ${bundlePrice.toFixed(2)}，优惠 ${Math.abs(expected).toFixed(2)}。`); }
    else { item.cn = "组合优惠（请核对适用商品）"; item.asset = false; item.needsReview = true; }
  });
  receipt.items.forEach((item: any) => {
    const amount = Number(item?.amount); const name = String(item?.name || "");
    const looksLikeAdjustment = /\b(?:for|discount|promo|member|save|offer|coupon|voucher|markdown|refund|return)\b/i.test(name);
    if (Number.isFinite(amount) && amount < 0 && !looksLikeAdjustment) {
      // A product line with a copied negative price is less safe than a blank
      // editable field. Never turn a suspected OCR mismatch into a real charge.
      item.amount = null; item.needsReview = true;
    }
  });
  receipt.items.forEach((item: any) => {
    const current = String(item?.cn || ""); const name = String(item?.name || ""); const suggested = chineseReceiptName(name);
    if (suggested) item.cn = suggested;
    else if (!/[\u4e00-\u9fff]/.test(current) || current === name) { item.cn = ""; item.needsReview = true; }
    if (/oven\s*glove/i.test(name)) item.asset = true;
  });
  receipt.notes = [...new Set(notes)]; return receipt;
}

const receiptPrompt = `Read this Australian retail receipt as a strict, auditable ledger. Return JSON only: {"merchant":"string or 未识别","date":"YYYY-MM-DD or empty","currency":"ISO code","total":number|null,"expected_item_quantity":number|null,"items":[{"name":"verbatim item name","cn":"concise natural Chinese shopper-friendly name","amount":number|null,"quantity":number,"category":"餐饮|日用|购物|交通|学习|其他","asset":boolean,"needsReview":boolean}],"confidence":"high|medium|low","notes":["string"]}. Read ONLY the product block: every purchase row has a product name and an amount in the rightmost $ column. Ignore store information, payment/card details, GST, Total Savings and footer text. Every positive-price product row must be kept. amount is the TOTAL amount represented by that row; quantity is the number of purchased units represented by that row. Australian and other overseas numeric receipt dates are DAY/MONTH/YEAR: interpret 01/08/2026 as 1 August 2026, never January 8, and return it as 2026-08-01. For example, “KIWIFRUIT GOLD 1 EACH 4 @ $1.80 EACH 7.20” must be quantity 4 and amount 7.20. The printed “Total for 18 items” / “ITEMS” / “SUBTOTAL” count is purchased UNIT count, not product-type count; put it in expected_item_quantity. Do not mistake a package label such as “3PACK” for a purchased quantity. A negative amount is a discount, multibuy, coupon or price reduction. Preserve it as its own row with quantity 0, never attach it to another product. Example: “ARNOTTS 2 FOR $8  -4.00” follows two A$6 Arnott's products: retain both A$6 products and add a separate A$-4.00 组合优惠 row. Likewise retain “4 @ $1.80 EACH 7.20” and the separate “4 FOR $6.50 -0.72” discount. Chinese cn must be a natural product name retaining useful brands/models, not literal machine translation. Mark only genuinely unclear text needsReview true. Durable clothes, shoes, bags, electronics, furniture and appliances are assets; food, groceries, personal-care consumables, transport, services and promotions are not. Never invent a row, amount, total or quantity.`;
function normalizeReceiptDate(value: unknown) {
  const raw = String(value || "").trim();
  const ymd = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  const dmy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return "";
}
function parseReceiptResponse(raw: unknown) {
  if (typeof raw === "object" && raw !== null) return raw as any;
  const text = String(raw || ""); const json = text.match(/\{[\s\S]*\}/); if (json) return JSON.parse(json[0]);
  const displayField = (label: string) => text.match(new RegExp(`\\*{1,2}${label}(?:\\*{1,2}:|:\\*{1,2})\\s*([^\\n]+)`, "i"))?.[1]?.trim() || "";
  const listedItems = [...text.matchAll(/^\s*(?:\+|•|-)\s+(.+?):\s*\$?\s*(-?\d+(?:\.\d+)?)\s*$/gm)];
  if (listedItems.length) {
    const rawDate = displayField("Date"); const dateParts = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const date = dateParts ? `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}` : rawDate.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || "";
    const totalText = displayField("Total") || displayField("Total Amount"); const totalMatch = totalText.match(/-?\d+(?:\.\d+)?/); const expected = Number(displayField("Expected Item Quantity"));
    const items = listedItems.map((match) => {
      const name = match[1].trim(); const amount = Number(match[2]);
      return { name, cn: chineseReceiptName(name), amount, quantity: 1, category: receiptCategory(name), asset: /oven\s*glove/i.test(name), needsReview: !chineseReceiptName(name) };
    });
    return { merchant: displayField("Merchant") || "未识别", date, currency: displayField("Currency").match(/[A-Z]{3}/)?.[0] || "AUD", total: totalMatch ? Number(totalMatch[0]) : null, expected_item_quantity: Number.isInteger(expected) && expected > 0 ? expected : null, items, confidence: /high/i.test(displayField("Confidence")) ? "high" : "medium", notes: ["已提取视觉模型的商品列表；金额或件数不一致处将保留空白项供核对。"] };
  }
  // Dedicated OCR models follow this deliberately simple, line-safe format.
  // It avoids their tendency to turn a receipt into a prose summary.
  const pipeRows = [...text.matchAll(/^\s*ITEM\|(.+?)\|(-?\s*\$?\s*\d+(?:\.\d+)?|)\s*$/gim)];
  if (pipeRows.length) {
    const value = (label: string) => text.match(new RegExp(`^\\s*${label}\\|(.+?)\\s*$`, "im"))?.[1]?.trim() || "";
    const itemCount = Number(value("COUNT")); const totalText = value("TOTAL"); const totalMatch = totalText.match(/-?\s*\$?\s*\d+(?:\.\d+)?/);
    const items = pipeRows.map((match) => {
      const name = match[1].trim(); const amountText = match[2].replace(/[^\d.-]/g, ""); const amount = amountText ? Number(amountText) : null;
      return { name, cn: chineseReceiptName(name), amount: Number.isFinite(amount) ? amount : null, quantity: 1, category: receiptCategory(name), asset: /oven\s*glove/i.test(name), needsReview: !chineseReceiptName(name) || !Number.isFinite(amount) };
    });
    return { merchant: value("MERCHANT") || "未识别", date: value("DATE").match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || "", currency: value("CURRENCY").match(/[A-Z]{3}/)?.[0] || "AUD", total: totalMatch ? Number(totalMatch[0].replace(/[^\d.-]/g, "")) : null, expected_item_quantity: Number.isInteger(itemCount) && itemCount > 0 ? itemCount : null, items, confidence: "medium", notes: ["已通过逐行 OCR 提取；请核对商品译名与金额。"] };
  }
  const field = (label: string) => text.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*([^\\n]+)`, "i"))?.[1]?.trim() || "";
  const looseField = (block: string, label: string) => block.match(new RegExp(`^\\s*(?:[-*•]\\s*)?\\*{0,2}${label}\\*{0,2}\\s*:\\s*(.*?)\\s*$`, "im"))?.[1]?.trim() || "";
  const nameRows = [...text.matchAll(/^\s*(?:[-*•]\s*)?\*{0,2}Name\*{0,2}\s*:\s*(.+?)\s*$/gim)];
  if (nameRows.length) {
    const categories = ["餐饮", "日用", "购物", "交通", "学习", "其他"];
    const items = nameRows.map((match, index) => {
      const block = text.slice(match.index || 0, nameRows[index + 1]?.index);
      const name = match[1].trim(); const amountText = looseField(block, "Amount"); const amountMatch = amountText.match(/-?\s*\$?\s*\d+(?:\.\d+)?/);
      const amount = amountMatch ? Number(amountMatch[0].replace(/[^\d.-]/g, "")) : null; const rawCn = looseField(block, "CN"); const suppliedCn = /^(?:\*\s*)?(?:amount|category|asset|needs\s+review)\b/i.test(rawCn) ? "" : rawCn; const categoryText = looseField(block, "Category");
      return { name, cn: suppliedCn || chineseReceiptName(name), amount, quantity: amount !== null && amount < 0 ? 0 : 1, category: categories.find(category => categoryText.includes(category)) || receiptCategory(name), asset: /^true$/i.test(looseField(block, "Asset")), needsReview: !suppliedCn || amount === null || /^true$/i.test(looseField(block, "Needs Review")) };
    }).filter(item => item.name);
    if (items.length) {
      const totalText = looseField(text, "Total") || field("Total"); const totalMatch = totalText.match(/-?\d+(?:\.\d+)?/); const merchant = looseField(text, "Merchant") || field("Merchant") || "未识别";
      return { merchant, date: looseField(text, "Date").match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || field("Date").match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || "", currency: looseField(text, "Currency").match(/[A-Z]{3}/)?.[0] || field("Currency").match(/[A-Z]{3}/)?.[0] || "AUD", total: totalMatch ? Number(totalMatch[0]) : null, expected_item_quantity: null, items, confidence: "low", notes: ["AI 返回字段文本，已逐行提取；请核对总计、译名与优惠。"] };
    }
  }
  const starts = [...text.matchAll(/^\*\s+\*\*(.+?)\*\*:\s*$/gm)];
  const categories = ["餐饮", "日用", "购物", "交通", "学习", "其他"];
  const items = starts.map((match, index) => {
    const block = text.slice((match.index || 0) + match[0].length, starts[index + 1]?.index);
    const name = fieldFromBlock(block, "Name") || match[1].trim(); const amountText = fieldFromBlock(block, "Amount");
    const amountMatch = amountText.match(/-?\d+(?:\.\d+)?/); const cn = fieldFromBlock(block, "CN"); const categoryText = fieldFromBlock(block, "Category");
    const amount = amountMatch ? Number(amountMatch[0]) : null;
    return { name, cn: cn && !/未识别|unknown/i.test(cn) ? cn : name, amount, quantity: amount !== null && amount < 0 ? 0 : 1, category: categories.find(category => categoryText.includes(category)) || "其他", asset: /^true$/i.test(fieldFromBlock(block, "Asset")), needsReview: !cn || /未识别|unknown/i.test(cn) || !amountMatch || /^true$/i.test(fieldFromBlock(block, "Needs Review")) };
  }).filter(item => item.name && item.amount !== null);
  if (!items.length) {
    // Some vision responses ignore JSON mode but still contain a usable bullet list.
    // Recover those facts rather than incorrectly blaming the uploaded image.
    const bulletNames = [...text.matchAll(/^\s*(?:\*|•|-)\s+(.+?)\s*$/gm)].map(match => match[1].trim()).filter(name => name.length > 1 && !/^\*\*/.test(name));
    const arithmetic = text.match(/(?:total\s+(?:cost|amount)|items?\s+(?:total|cost))[^\n]*?(?:is|:)?\s*([^\n=]+?)\s*=\s*\$?\s*(-?\d+(?:\.\d+)?)/i);
    const amounts = arithmetic ? [...arithmetic[1].matchAll(/-?\s*\$?\s*\d+(?:\.\d+)?/g)].map(match => Number(match[0].replace(/[^\d.-]/g, ""))).filter(Number.isFinite) : [];
    if (!bulletNames.length) throw new Error("AI 未返回可用的商品明细。");
    const fallbackItems = bulletNames.map((rawName, index) => {
      const directAmount = rawName.match(/:\s*(-?\s*\$?\s*\d+(?:\.\d+)?)\s*$/);
      const name = directAmount ? rawName.slice(0, directAmount.index).trim() : rawName;
      const amount = directAmount ? Number(directAmount[1].replace(/[^\d.-]/g, "")) : index < amounts.length ? amounts[index] : null;
      const suggestion = chineseReceiptName(name);
      return { name, cn: suggestion, amount, quantity: amount !== null && amount < 0 ? 0 : 1, category: receiptCategory(name), asset: false, needsReview: true };
    });
    return { merchant: "未识别", date: "", currency: /\b(?:AUD|USD|GBP|CAD|NZD)\b/i.exec(text)?.[0]?.toUpperCase() || "AUD", total: null, expected_item_quantity: null, items: fallbackItems, confidence: "low", notes: ["AI 已读取到商品文字，但未返回完整结构化字段；请核对商家、日期、总计和空白金额。"] };
  }
  const totalText = field("Total"); const totalMatch = totalText.match(/-?\d+(?:\.\d+)?/); const merchant = field("Merchant").replace(/\s*\([^)]*\)\s*$/, "") || "未识别";
  return { merchant, date: field("Date").match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || "", currency: field("Currency").match(/[A-Z]{3}/)?.[0] || "", total: totalMatch ? Number(totalMatch[0]) : null, expected_item_quantity: null, items, confidence: "low", notes: ["AI 返回文本格式，已提取可见商品行；请核对总计、译名与优惠。"] };
}
function fieldFromBlock(block: string, label: string) { return block.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*([^\\n]+)`, "i"))?.[1]?.trim() || ""; }
function receiptCategory(name: string) { return /pork|ribs|chocolate|tim\s*tam|yoghurt|milk|egg|salmon|chicken|fruit|vegetable|bread|brioche|coffee|dressing|oyster\s*sauce|pepper|seasoning|canola\s*oil/i.test(name) ? "餐饮" : /paper\s*towel|pads|sandwich\s*bags|oven\s*glove|tote\s*bag|kitchen\s*tidy|sponge|palmolive|colgate|dishwashing/i.test(name) ? "日用" : "其他"; }
function chineseReceiptName(name: string) {
  const value = name.toLowerCase();
  if (/pork\s*ribs/.test(value)) return "烧烤猪肋排";
  if (/arnott.*chocolate/.test(value)) return "阿诺兹巧克力饼干";
  if (/tim\s*tam/.test(value)) return "阿诺兹 Tim Tam 原味巧克力饼干";
  if (/arnott.*2\s*for/.test(value)) return "阿诺兹 2件组合优惠";
  if (/activia.*yoghurt/.test(value)) return "爱活酸奶";
  if (/everyday.*oven\s*glove/.test(value)) return "隔热烤箱手套";
  if (/paper\s*towel/.test(value)) return "厨房纸巾";
  if (/(?:ubk|u\s*by\s*kotex).*pads|pads.*wings/.test(value)) return "U牌超薄护翼卫生巾";
  if (/large\s*sandwich\s*bags|glad.*snap\s*lock/.test(value)) return "大号密封保鲜袋";
  if (/pork\s*rashers/.test(value)) return "中切培根片";
  if (/oyster\s*sauce/.test(value)) return "李锦记熊猫牌蚝油";
  if (/pepper\s*white\s*ground/.test(value)) return "McKenzie's 白胡椒粉";
  if (/garlic\s*steak\s*seasoning/.test(value)) return "大蒜牛排调味料";
  if (/coles\s*tote\s*bag/.test(value)) return "Coles 环保购物袋";
  if (/kitchen\s*tidy/.test(value)) return "厨房清洁纸巾";
  if (/sponge\s*scourer/.test(value)) return "双效洗碗海绵";
  if (/palmolive\s*naturals/.test(value)) return "棕榄天然沐浴露";
  if (/sliced\s*brioche/.test(value)) return "切片布里欧修吐司";
  if (/colgate\s*sensitive/.test(value)) return "高露洁敏感护理牙膏";
  if (/kewpie\s*dressing/.test(value)) return "丘比沙拉酱";
  if (/kiwifruit.*gold|gold.*kiwifruit/.test(value)) return "金奇异果";
  if (/4\s*leaf\s*blend/.test(value)) return "四叶混合生菜";
  if (/dishwashing\s*liquid/.test(value)) return "洗洁精";
  if (/crisco.*canola\s*oil/.test(value)) return "Crisco 菜籽油";
  return "";
}
function expandQuantityRows(receipt: any) {
  if (!Array.isArray(receipt?.items)) return receipt;
  const notes = Array.isArray(receipt.notes) ? receipt.notes : [];
  const expanded: any[] = [];
  receipt.items.forEach((item: any) => {
    const quantity = Number(item?.quantity); const amount = Number(item?.amount);
    if (!Number.isInteger(quantity) || quantity <= 1 || quantity > 30 || !Number.isFinite(amount) || amount <= 0) { expanded.push(item); return; }
    const unitAmount = Math.round((amount / quantity) * 100) / 100;
    if (Math.abs(Math.round((unitAmount * quantity - amount) * 100)) >= 1) { item.needsReview = true; expanded.push(item); return; }
    for (let index = 0; index < quantity; index++) expanded.push({ ...item, amount: unitAmount, quantity: 1, needsReview: Boolean(item.needsReview) });
    notes.push(`已按小票数量将“${item.name}”拆为 ${quantity} 件，每件 ${unitAmount.toFixed(2)}。`);
  });
  receipt.items = expanded; receipt.notes = [...new Set(notes)]; return receipt;
}
function expandExplicitMultiUnitCandidate(receipt: any) {
  if (!Array.isArray(receipt?.items)) return receipt;
  const expected = Number(receipt.expected_item_quantity);
  const counted = receipt.items.reduce((sum: number, item: any) => sum + (Number.isInteger(Number(item?.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 0), 0);
  const missingUnits = expected - counted;
  const itemTotal = receipt.items.reduce((sum: number, item: any) => sum + (Number.isFinite(Number(item?.amount)) ? Number(item.amount) : 0), 0);
  // A subtotal count is a strong cross-check. Some vision models collapse a
  // clearly printed "Qty 2 @ price each" hygiene-product line into one row.
  // Expand only the unambiguous pads/wings case, only when it closes exactly
  // one missing purchased unit, and only when the visible amounts already
  // reconcile to the printed total. The review screen still highlights both.
  const candidate = receipt.items.find((item: any) => /(?:ubk|u\s*by\s*kotex).*(?:pad|wing)|(?:pad|wing).*\b(?:ubk|kotex)\b/i.test(String(item?.name || "")) && Number(item?.quantity) === 1 && Number(item?.amount) > 0);
  if (missingUnits !== 1 || !candidate || !Number.isFinite(Number(receipt.total)) || Math.abs(Math.round((itemTotal - Number(receipt.total)) * 100)) >= 1) return receipt;
  const unitAmount = Math.round((Number(candidate.amount) / 2) * 100) / 100;
  if (Math.abs(Math.round((unitAmount * 2 - Number(candidate.amount)) * 100)) >= 1) return receipt;
  candidate.amount = unitAmount; candidate.needsReview = true;
  const duplicate = { ...candidate, amount: unitAmount, needsReview: true };
  const index = receipt.items.indexOf(candidate); receipt.items.splice(index + 1, 0, duplicate);
  const notes = Array.isArray(receipt.notes) ? receipt.notes : [];
  receipt.notes = [...new Set([...notes, `已按小票数量将“${candidate.name}”拆为 2 件，每件 ${unitAmount.toFixed(2)}；请核对。`])];
  return receipt;
}
function addReconciliationSlot(receipt: any) {
  if (!Array.isArray(receipt?.items)) return receipt;
  const total = typeof receipt.total === "number" ? receipt.total : Number.NaN;
  const itemTotal = receipt.items.reduce((sum: number, item: any) => sum + (Number.isFinite(Number(item?.amount)) ? Number(item.amount) : 0), 0);
  const expectedQuantity = Number(receipt.expected_item_quantity);
  const recognizedQuantity = receipt.items.reduce((sum: number, item: any) => {
    const quantity = Number(item?.quantity);
    return sum + (Number.isInteger(quantity) && quantity > 0 ? quantity : 0);
  }, 0);
  const amountMismatch = Number.isFinite(total) && Math.abs(Math.round((itemTotal - total) * 100)) >= 1;
  const quantityMismatch = Number.isInteger(expectedQuantity) && expectedQuantity > 0 && recognizedQuantity !== expectedQuantity;
  if ((amountMismatch || quantityMismatch) && !receipt.items.some((item: any) => item?.reconciliationSlot)) {
    const requiredSlots = Math.max(amountMismatch ? 1 : 0, quantityMismatch ? expectedQuantity - recognizedQuantity : 0);
    for (let index = 0; index < requiredSlots; index++) receipt.items.push({ name: "", cn: "", amount: 0, quantity: 1, category: "其他", asset: false, needsReview: true, reconciliationSlot: true });
  }
  // Quantities and reconciliation state are intentionally server-only. The UI
  // receives just one normal empty editable row when manual completion is needed.
  receipt.items.forEach((item: any) => { delete item.quantity; delete item.reconciliationSlot; });
  delete receipt.expected_item_quantity;
  return receipt;
}
function parseReceiptCandidate(raw: unknown) {
  try {
    const receipt = parseReceiptResponse(raw);
    receipt.date = normalizeReceiptDate(receipt.date);
    return Array.isArray(receipt?.items) && receipt.items.length ? receipt : null;
  } catch { return null; }
}
function modelOutput(raw: any) {
  if (raw == null) return raw;
  return raw.response ?? raw.result ?? raw.answer ?? raw.choices?.[0]?.message?.content ?? raw;
}
async function openAiJson(env: Env, endpoint: string, payload: unknown) {
  if (!env.OPENAI_API_KEY) return null;
  const response = await fetch(`https://api.openai.com${endpoint}`, { method: "POST", headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI 请求失败（${response.status}）：${raw.slice(0, 180)}`);
  return JSON.parse(raw);
}
async function scanReceiptWithOpenAI(aiImage: string, env: Env) {
  if (!env.OPENAI_API_KEY) return null;
  // GPT-5 mini only accepts its default temperature. Keeping `temperature: 0`
  // causes the API to reject the entire scan before it sees the receipt.
  const result = await openAiJson(env, "/v1/chat/completions", { model: "gpt-5-mini", response_format: { type: "json_object" }, messages: [{ role: "system", content: receiptPrompt }, { role: "user", content: [{ type: "text", text: "Extract this receipt. Return JSON only." }, { type: "image_url", image_url: { url: aiImage, detail: "high" } }] }] });
  return parseReceiptCandidate(result?.choices?.[0]?.message?.content);
}
async function enrichUncertainChineseNames(receipt: any, env: Env) {
  if (!env.OPENAI_API_KEY || !Array.isArray(receipt?.items)) return receipt;
  // Name enrichment is deliberately bounded. It is a helpful second pass for
  // abbreviations, not a reason to hold up the whole receipt review screen.
  const uncertain = receipt.items.map((item: any, index: number) => ({ item, index })).filter(({ item }: any) => Number(item?.amount) >= 0 && (!String(item?.cn || "").trim() || item?.needsReview)).map(({ item, index }: any) => ({ index, name: String(item?.name || "").trim() })).filter((item: any) => item.name).slice(0, 8);
  if (!uncertain.length) return receipt;
  try {
    const result = await openAiJson(env, "/v1/responses", { model: "gpt-5-mini", tools: [{ type: "web_search" }], input: [{ role: "user", content: [{ type: "input_text", text: `Identify these Australian retail product labels. Use web search only where an abbreviation, brand or product meaning is uncertain. Return JSON only: {"items":[{"index":number,"cn":"natural concise Chinese shopper-friendly name","category":"餐饮|日用|购物|交通|学习|其他","asset":boolean,"certain":boolean}]}. Do not invent a specific product when the search evidence is insufficient. Labels: ${JSON.stringify(uncertain)}` }] }] });
    const content = String(result?.output_text || ""); const json = content.match(/\{[\s\S]*\}/); const translated = json ? JSON.parse(json[0])?.items : [];
    if (!Array.isArray(translated)) return receipt;
    translated.forEach((item: any) => { const target = receipt.items[item?.index]; if (!target || !/^[\u4e00-\u9fffA-Za-z0-9&'’\- ]{2,80}$/.test(String(item?.cn || ""))) return; target.cn = String(item.cn).trim(); if (["餐饮", "日用", "购物", "交通", "学习", "其他"].includes(item.category)) target.category = item.category; if (typeof item.asset === "boolean") target.asset = item.asset; target.needsReview = item.certain === false; });
    return receipt;
  } catch (error) { console.log("Receipt name web search unavailable", String(error)); return receipt; }
}
function receiptCompleteness(receipt: any) {
  if (!receipt || !Array.isArray(receipt.items)) return -1;
  const numericAmounts = receipt.items.filter((item: any) => typeof item?.amount === "number" && Number.isFinite(item.amount)).length;
  const translated = receipt.items.filter((item: any) => /[\u4e00-\u9fff]/.test(String(item?.cn || ""))).length;
  const confirmed = receipt.items.filter((item: any) => !item?.needsReview).length;
  const hasTotal = typeof receipt.total === "number" && Number.isFinite(receipt.total);
  const hasMerchant = receipt.merchant && !/未识别|not visible|unknown/i.test(String(receipt.merchant));
  const recognizedQuantity = receipt.items.reduce((sum: number, item: any) => sum + (Number.isInteger(Number(item?.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 0), 0);
  const expectedQuantity = Number(receipt.expected_item_quantity);
  const amountTotal = receipt.items.reduce((sum: number, item: any) => sum + (Number.isFinite(Number(item?.amount)) ? Number(item.amount) : 0), 0);
  // Prefer the candidate that agrees with facts printed on the receipt over
  // one that merely returned more prose / more rows.
  const countMatches = Number.isInteger(expectedQuantity) && expectedQuantity > 0 && recognizedQuantity === expectedQuantity;
  const totalMatches = hasTotal && numericAmounts === receipt.items.length && Math.abs(Math.round((amountTotal - receipt.total) * 100)) < 1;
  return receipt.items.length * 3 + numericAmounts * 2 + translated * 2 + confirmed + (hasTotal ? 4 : 0) + (hasMerchant ? 2 : 0) + (countMatches ? 10 : 0) + (totalMatches ? 10 : 0);
}
function needsReceiptRetry(receipt: any) {
  if (!receipt || !Array.isArray(receipt.items) || !receipt.items.length) return true;
  const hasTotal = typeof receipt.total === "number" && Number.isFinite(receipt.total);
  const numericAmounts = receipt.items.filter((item: any) => typeof item?.amount === "number" && Number.isFinite(item.amount)).length;
  const itemTotal = receipt.items.reduce((sum: number, item: any) => sum + (Number.isFinite(Number(item?.amount)) ? Number(item.amount) : 0), 0);
  const totalsDoNotMatch = hasTotal && numericAmounts === receipt.items.length && Math.abs(Math.round((itemTotal - receipt.total) * 100)) >= 1;
  const expectedQuantity = Number(receipt.expected_item_quantity); const recognizedQuantity = receipt.items.reduce((sum: number, item: any) => sum + (Number.isInteger(Number(item?.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 0), 0);
  // A one-line response without a receipt total is usually a model summary,
  // not a complete scan. A full-looking response whose detail sum differs
  // from the printed total is incomplete too, so it must receive OCR retry.
  return !hasTotal || receipt.items.length < 2 || numericAmounts < receipt.items.length || totalsDoNotMatch || (Number.isInteger(expectedQuantity) && expectedQuantity > 0 && recognizedQuantity !== expectedQuantity);
}
async function scanReceipt(image: Uint8Array, env: Env) {
  const receiptSchema = {
    type: "object",
    properties: {
      merchant: { type: "string" }, date: { type: "string" }, currency: { type: "string" }, total: { type: ["number", "null"] }, expected_item_quantity: { type: ["integer", "null"] },
      items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, cn: { type: "string" }, amount: { type: ["number", "null"] }, quantity: { type: "integer" }, category: { type: "string", enum: ["餐饮", "日用", "购物", "交通", "学习", "其他"] }, asset: { type: "boolean" }, needsReview: { type: "boolean" } }, required: ["name", "cn", "amount", "quantity", "category", "asset", "needsReview"] } },
      confidence: { type: "string", enum: ["high", "medium", "low"] }, notes: { type: "array", items: { type: "string" } }
    }, required: ["merchant", "date", "currency", "total", "expected_item_quantity", "items", "confidence", "notes"]
  };
  // Workers AI vision models expect a complete base64 data URI. Passing a raw
  // number array may silently make a model answer without seeing the receipt.
  const aiImage = `data:image/jpeg;base64,${bytesToBase64(image)}`;
  const input = { messages: [{ role: "system", content: receiptPrompt }, { role: "user", content: "Read the receipt image and return the requested structured result." }], image: aiImage, max_tokens: 1400, temperature: 0, response_format: { type: "json_schema", json_schema: receiptSchema } };
  const primaryModel = "@cf/meta/llama-3.2-11b-vision-instruct";
  const fallbackModel = "@cf/google/gemma-4-26b-a4b-it";
  const legacyVisionModel = primaryModel;
  const runVision = async (model: string, request: any) => {
    try { return await env.AI.run(model, request); }
    catch (error) {
      if (model !== legacyVisionModel) throw error;
      await env.AI.run(legacyVisionModel, { prompt: "agree" });
      return env.AI.run(legacyVisionModel, request);
    }
  };
  let receipt: any = null;
  let openAiFailure = "";
  try { receipt = await scanReceiptWithOpenAI(aiImage, env); }
  catch (error) { openAiFailure = String(error); console.log("Receipt OpenAI vision unavailable", openAiFailure); }
  // Return the OpenAI result as soon as it contains editable line items. The
  // review screen already reconciles the total and gives the user a blank row
  // where needed. Waiting for two more full-image OCR attempts made ordinary
  // scans feel slow, while rarely improving a clear receipt.
  if (!receipt) {
    try { receipt = parseReceiptCandidate(modelOutput(await runVision(primaryModel, input))); }
    catch (error) { console.log("Receipt primary vision unavailable", String(error)); }
  }
  if (!receipt) {
    const retryPrompt = `Transcribe every visible receipt line; do not summarize and do not omit repeated products or negative discount lines. Return only this Markdown format:\n**Merchant**: exact text or 未识别\n**Date**: YYYY-MM-DD or empty\n**Currency**: ISO code or AUD\n**Total**: number or empty\n* **Item 1**:\n  **Name**: exact printed item text\n  **CN**: concise natural Chinese name, or empty when uncertain\n  **Amount**: signed number or empty\n  **Category**: 餐饮|日用|购物|交通|学习|其他\n  **Asset**: true|false\n  **Needs Review**: true|false\nRepeat the Item block for every visible product, discount, tax, or fee line. Keep a 2 FOR / multibuy discount as its own negative line.`;
    try {
      const retry = await runVision(fallbackModel, { messages: [{ role: "system", content: retryPrompt }, { role: "user", content: "Transcribe this receipt line by line." }], image: aiImage, max_tokens: 2100, temperature: 0 });
      const retryReceipt = parseReceiptCandidate(modelOutput(retry));
      if (receiptCompleteness(retryReceipt) > receiptCompleteness(receipt)) receipt = retryReceipt;
    } catch (error) { console.log("Receipt Llama fallback unavailable", String(error)); }
  }
  if (!receipt) {
    // A final structured-vision retry for receipts where visible item amounts
    // do not reconcile to the printed total. It is not an image-caption model.
    const ocrPrompt = `${receiptPrompt}\nExtra rule: do not summarize. Read only the purchased-product block between the transaction header and SUBTOTAL/TOTAL. Expand "Qty 2 @ $2.80 each" into TWO identical item objects with amount 2.80, so the items array count equals the printed subtotal count.`;
    try {
      const ocr = await runVision(legacyVisionModel, { messages: [{ role: "system", content: ocrPrompt }, { role: "user", content: "Extract the receipt now. JSON only." }], image: aiImage, max_tokens: 2200, temperature: 0, response_format: { type: "json_schema", json_schema: receiptSchema } } as any);
      const ocrReceipt = parseReceiptCandidate(modelOutput(ocr));
      if (receiptCompleteness(ocrReceipt) > receiptCompleteness(receipt)) receipt = ocrReceipt;
    } catch (error) { console.log("Receipt structured-vision unavailable", String(error)); }
  }
  if (!receipt) {
    if (/insufficient_quota|quota|OpenAI 请求失败（429）/i.test(openAiFailure)) throw new Error("OpenAI API 额度不足：请在 OpenAI Platform 的 Billing 中添加付款方式或可用额度后重试。");
    if (/invalid_api_key|OpenAI 请求失败（401）/i.test(openAiFailure)) throw new Error("OpenAI API 密钥无效，请检查 .dev.vars 中的 OPENAI_API_KEY。");
    throw new Error("AI 未返回可用的商品明细。");
  }
  // Translation/search enrichment is requested by the browser after this fast
  // response has opened the review UI. It must never block first results.
  const normalized = expandExplicitMultiUnitCandidate(normalizePromotion(expandQuantityRows(receipt))); if (!Array.isArray(normalized.items)) throw new Error("AI 识别结果格式异常。");
  if (!normalized.items.some((item: any) => String(item?.name || "").trim() && Number(item?.amount) > 0)) throw new Error("AI 未返回可核对的商品明细。");
  return addReconciliationSlot(normalized);
}

function receiptNameEnrichmentInput(value: any) {
  const receipt = value?.receipt;
  if (!receipt || !Array.isArray(receipt.items) || receipt.items.length > 100) throw new Error("商品译名补全请求无效。");
  return {
    merchant: String(receipt.merchant || "").slice(0, 120), date: String(receipt.date || "").slice(0, 20), currency: String(receipt.currency || "AUD").slice(0, 3), total: Number(receipt.total), confidence: String(receipt.confidence || "medium"), notes: Array.isArray(receipt.notes) ? receipt.notes.slice(0, 8).map((note: unknown) => String(note).slice(0, 240)) : [],
    items: receipt.items.map((item: any) => ({ name: String(item?.name || "").slice(0, 160), cn: String(item?.cn || "").slice(0, 100), amount: Number(item?.amount), category: String(item?.category || "其他"), asset: Boolean(item?.asset), needsReview: Boolean(item?.needsReview) }))
  };
}

async function handleApi(request: Request, env: Env, path: string) {
  if (path === "/api/exchange-rate" && request.method === "GET") { try { return await exchangeRate(request); } catch (error) { console.error("Exchange rate lookup failed", error); return json({ error: "暂时无法取得交易日汇率，请稍后重试。" }, 502); } }
  if (path === "/api/auth/me" && request.method === "GET") { const user = await currentUser(request, env); return json({ user: user ? publicUser(user) : null }); }
  if (path === "/api/auth/signup" && request.method === "POST") {
    const value = await body(request); const account = normalizeIdentifier(value.identifier); const password = String(value.password || ""); const fullName = String(value.full_name || "").trim() || account.identifier.split("@")[0];
    if (password.length < 8) return json({ error: "密码至少需要 8 位。" }, 422); if (fullName.length > 40) return json({ error: "昵称不能超过 40 个字符。" }, 422);
    const existing = await env.DB.prepare("SELECT id FROM users WHERE identifier = ?").bind(account.identifier).first(); if (existing) return json({ error: "该邮箱或手机号已注册，请直接登录。" }, 409);
    const saltBytes = crypto.getRandomValues(new Uint8Array(16)); const salt = bytesToBase64(saltBytes); const id = crypto.randomUUID(); const timestamp = now(); const hash = await passwordHash(password, salt);
    await env.DB.batch([env.DB.prepare("INSERT INTO users (id, identifier, identifier_type, password_hash, password_salt, full_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, account.identifier, account.type, hash, salt, fullName, timestamp, timestamp), env.DB.prepare("INSERT INTO ledgers (user_id, entries_json, assets_json, updated_at) VALUES (?, '[]', '[]', ?)").bind(id, timestamp)]);
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>(); return json({ user: publicUser(user!), }, 201, { "Set-Cookie": cookie(await sessionFor(id, env), request) });
  }
  if (path === "/api/auth/login" && request.method === "POST") {
    const value = await body(request); const account = normalizeIdentifier(value.identifier); const user = await env.DB.prepare("SELECT * FROM users WHERE identifier = ?").bind(account.identifier).first<UserRow>();
    if (!user || !constantTimeEqual(await passwordHash(String(value.password || ""), user.password_salt), user.password_hash)) return json({ error: "账号或密码不正确。" }, 401);
    return json({ user: publicUser(user) }, 200, { "Set-Cookie": cookie(await sessionFor(user.id, env), request) });
  }
  if (path === "/api/auth/logout" && request.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": cookie("", request, 0) });
  if (path === "/api/auth/profile" && request.method === "PUT") { const user = await requireUser(request, env); const value = await body(request); const fullName = String(value.full_name || "").trim(); const country = String(value.country || "澳大利亚"); const currency = String(value.display_currency || "AUD"); if (!fullName || fullName.length > 40 || !/^[A-Z]{3}$/.test(currency)) return json({ error: "资料内容无效。" }, 422); await env.DB.prepare("UPDATE users SET full_name = ?, country = ?, display_currency = ?, updated_at = ? WHERE id = ?").bind(fullName, country, currency, now(), user.id).run(); const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>(); return json({ user: publicUser(updated!) }); }
  if (path === "/api/ledger") { const user = await requireUser(request, env); if (request.method === "GET") { const ledger = await env.DB.prepare("SELECT entries_json, assets_json, updated_at FROM ledgers WHERE user_id = ?").bind(user.id).first<any>(); return json({ entries: JSON.parse(ledger?.entries_json || "[]"), assets: JSON.parse(ledger?.assets_json || "[]"), updatedAt: ledger?.updated_at || null }); } if (request.method === "PUT") { const value = await body(request); if (!Array.isArray(value.entries) || !Array.isArray(value.assets) || value.entries.length > 5000 || value.assets.length > 2000) return json({ error: "账本数据无效或超出支持范围。" }, 422); const updatedAt = now(); await env.DB.prepare("INSERT INTO ledgers (user_id, entries_json, assets_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET entries_json = excluded.entries_json, assets_json = excluded.assets_json, updated_at = excluded.updated_at").bind(user.id, JSON.stringify(value.entries), JSON.stringify(value.assets), updatedAt).run(); return json({ ok: true, updatedAt }); } }
  if (path === "/api/receipt-image") { const user = await requireUser(request, env); if (request.method === "POST") { const value = await body(request); try { const image = imageBytes(String(value.image || "")); const id = crypto.randomUUID(); const key = `receipts/${user.id}/${id}.${image.extension}`; await env.RECEIPTS.put(key, image.bytes, { httpMetadata: { contentType: image.contentType, contentDisposition: `inline; filename=receipt-${id}.${image.extension}`, cacheControl: "private, no-store" }, customMetadata: { userId: user.id, receiptId: id } }); try { await env.DB.prepare("INSERT INTO receipts (id, user_id, content_type, image, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, user.id, image.contentType, new Uint8Array(), key, now()).run(); } catch (error) { await env.RECEIPTS.delete(key); throw error; } return json({ receiptId: id }); } catch (error) { return json({ error: error instanceof Error ? error.message : "小票保存失败。" }, 422); } } const id = new URL(request.url).searchParams.get("id") || ""; if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "凭证编号无效。" }, 400); const receipt = await env.DB.prepare("SELECT content_type, image, r2_key FROM receipts WHERE id = ? AND user_id = ?").bind(id, user.id).first<any>(); if (!receipt) return json({ error: "未找到这张小票。" }, 404); if (request.method === "GET") { let key = String(receipt.r2_key || ""); if (!key && receipt.image) { const legacy = new Uint8Array(receipt.image); if (legacy.byteLength) { key = `receipts/${user.id}/${id}.jpg`; await env.RECEIPTS.put(key, legacy, { httpMetadata: { contentType: receipt.content_type, contentDisposition: `inline; filename=receipt-${id}.jpg`, cacheControl: "private, no-store" }, customMetadata: { userId: user.id, receiptId: id } }); await env.DB.prepare("UPDATE receipts SET r2_key = ? WHERE id = ? AND user_id = ?").bind(key, id, user.id).run(); } } if (key) { const object = await env.RECEIPTS.get(key); if (object) { const headers = new Headers({ "Content-Type": object.httpMetadata?.contentType || receipt.content_type, "Content-Disposition": object.httpMetadata?.contentDisposition || "inline; filename=receipt.jpg", "Cache-Control": "private, no-store" }); return new Response(object.body, { headers }); } } return receipt.image ? new Response(receipt.image, { headers: { "Content-Type": receipt.content_type, "Content-Disposition": "inline; filename=receipt.jpg", "Cache-Control": "private, no-store" } }) : json({ error: "原始小票暂不可用。" }, 404); } if (request.method === "DELETE") { if (receipt.r2_key) await env.RECEIPTS.delete(String(receipt.r2_key)); await env.DB.prepare("DELETE FROM receipts WHERE id = ? AND user_id = ?").bind(id, user.id).run(); return json({ ok: true }); } }
  // Receipt recognition is available during the local trial. The reviewed
  // ledger and original image remain in the browser until the user signs in.
  if (path === "/api/scan-receipt" && request.method === "POST") { try { const value = await body(request); const image = imageBytes(String(value.image || ""), MAX_SCAN_IMAGE_BYTES); return json({ receipt: await scanReceipt(image.bytes, env), model: "receipt-vision-fast-pipeline" }); } catch (error) { console.error("Receipt scan failed", error); return json({ error: error instanceof Error ? `AI 识别暂不可用：${error.message}` : "AI 识别暂不可用。" }, 502); } }
  // This endpoint receives only extracted product labels, never the receipt
  // image. The UI calls it after opening review so name lookup cannot delay a scan.
  if (path === "/api/receipt-enrich" && request.method === "POST") { try { const value = await body(request); return json({ receipt: await enrichUncertainChineseNames(receiptNameEnrichmentInput(value), env) }); } catch (error) { console.log("Receipt name enrichment failed", String(error)); return json({ error: "商品译名补全暂不可用。" }, 422); } }
  return json({ error: "未找到接口。" }, 404);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) { try { return await handleApi(request, env, url.pathname); } catch (error) { if (error instanceof Response) return error; console.error(error); return json({ error: "服务暂时不可用，请稍后重试。" }, 500); } }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers); headers.set("X-Content-Type-Options", "nosniff"); headers.set("Referrer-Policy", "strict-origin-when-cross-origin"); return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
