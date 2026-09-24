/**
 * TV TƯỢNG AI — Cloudflare Worker (v2.0)
 * - Gemini: tự dò model khả dụng (ListModels) + fallback khi model lỗi/hết quota
 * - OpenAI / Grok (xAI): sẵn khung, chỉ chạy khi có Secret OPENAI_API_KEY / XAI_API_KEY
 * - Trả về { reply, actions[] } có cấu trúc — Worker KHÔNG ghi dữ liệu,
 *   website hiển thị bản xem trước và chỉ ghi khi người dùng bấm Xác nhận.
 * Secrets (Cloudflare → Settings → Variables and Secrets):
 *   GEMINI_API_KEY (bắt buộc), OPENAI_API_KEY, XAI_API_KEY (tùy chọn)
 * Biến tùy chọn: GEMINI_MODEL, OPENAI_MODEL, XAI_MODEL, ALLOWED_ORIGINS
 */

const VERSION = "2.2";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Thứ tự ưu tiên: nhanh, rẻ, hợp free tier. Chỉ dùng model nào ListModels xác nhận có.
const GEMINI_PREFERRED = [
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];
const GEMINI_STATIC_FALLBACK = ["gemini-flash-latest", "gemini-3-flash-preview", "gemini-flash-lite-latest", "gemini-2.5-flash"];
const MODEL_CACHE_MS = 60 * 60 * 1000;
let modelCache = { at: 0, list: null };
// Model trả 404 (đã bị Google ngừng cho key này) → bỏ qua 6 giờ; model chạy tốt gần nhất → thử trước.
const deadModels = new Map();
let lastGoodModel = "";
const DEAD_MS = 6 * 60 * 60 * 1000;
const isDead = m => { const t = deadModels.get(m); return t && Date.now() - t < DEAD_MS; };

const ACTION_TYPES = [
  "create_store", "create_product", "stock_in", "create_combo", "build_combo",
  "consign", "reconcile", "record_payment", "assign_rack",
];

/* ------------------------------ HTTP helpers ------------------------------ */
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "*";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const allow = !allowed.length || allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(req, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req, env) },
  });
}
class AIError extends Error {
  constructor(kind, message, status = 502, detail = "") {
    super(message); this.kind = kind; this.status = status; this.detail = detail;
  }
}
async function fetchTimeout(url, opt = {}, ms = 55000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opt, signal: c.signal }); }
  catch (e) {
    if (e.name === "AbortError") throw new AIError("timeout", "AI phản hồi quá lâu (quá thời gian chờ). Hãy thử lại hoặc gửi file nhỏ hơn.", 504);
    throw new AIError("network", "Worker không kết nối được tới máy chủ AI: " + e.message, 502);
  } finally { clearTimeout(t); }
}

/* ------------------------------ Gemini ------------------------------ */
function classifyGemini(status, body) {
  const err = body && body.error ? body.error : {};
  const msg = (err.message || "").toString();
  const st = (err.status || "").toString();
  const reason = JSON.stringify(err.details || "");
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(msg + reason))
    return new AIError("key", "Gemini: API key không hợp lệ hoặc đã hết hạn. Cần tạo key mới ở Google AI Studio rồi cập nhật Secret GEMINI_API_KEY trên Cloudflare.", 401, msg);
  if (status === 403 || st === "PERMISSION_DENIED")
    return new AIError("key", "Gemini: key không có quyền dùng Generative Language API (API chưa bật, key bị giới hạn hoặc bị Google khóa). Chi tiết: " + msg, 403, msg);
  if (status === 429 || st === "RESOURCE_EXHAUSTED")
    return new AIError("quota", "Gemini: đã hết hạn mức (quota) miễn phí/phút hoặc/ngày. Chờ 1–2 phút rồi thử lại.", 429, msg);
  if (status === 404 || st === "NOT_FOUND")
    return new AIError("model", "Gemini: model không tồn tại hoặc không hỗ trợ.", 404, msg);
  if (st === "FAILED_PRECONDITION")
    return new AIError("api", "Gemini: tài khoản/khu vực chưa đủ điều kiện dùng API (cần bật billing hoặc khu vực không hỗ trợ). Chi tiết: " + msg, 400, msg);
  if (status === 400)
    return new AIError("request", "Gemini: yêu cầu không hợp lệ (có thể file không đúng định dạng hoặc quá lớn). Chi tiết: " + msg, 400, msg);
  if (status >= 500)
    return new AIError("server", "Gemini đang quá tải/lỗi máy chủ (HTTP " + status + "). Thử lại sau ít phút.", 503, msg);
  return new AIError("api", "Gemini lỗi HTTP " + status + ": " + msg, 502, msg);
}

async function listGeminiModels(env, force = false) {
  if (!force && modelCache.list && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.list;
  const r = await fetchTimeout(GEMINI_BASE + "/models?pageSize=1000", { headers: { "x-goog-api-key": env.GEMINI_API_KEY } }, 15000);
  let body = {}; try { body = await r.json(); } catch (e) {}
  if (!r.ok) throw classifyGemini(r.status, body);
  const list = (body.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => (m.name || "").replace(/^models\//, ""));
  modelCache = { at: Date.now(), list };
  return list;
}

function rankGeminiModels(available) {
  const bad = /(image|tts|audio|live|embedding|aqa|robotics|computer-use|native|veo|imagen|learnlm|gemma|thinking-exp)/i;
  const usable = available.filter(n => /^gemini-/i.test(n) && !bad.test(n));
  const out = [];
  for (const p of GEMINI_PREFERRED) if (usable.includes(p)) out.push(p);
  // Các model flash khác (ưu tiên bản ổn định, phiên bản mới hơn)
  const ver = n => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const rest = usable.filter(n => !out.includes(n) && /flash/i.test(n))
    .sort((a, b) => (/preview|exp/i.test(a) - /preview|exp/i.test(b)) || (ver(b) - ver(a)));
  out.push(...rest);
  if (!out.length) out.push(...usable.filter(n => /pro/i.test(n)).slice(0, 2));
  return out;
}

async function geminiCandidates(env, requested) {
  let available = null, listErr = null;
  try { available = await listGeminiModels(env); } catch (e) { listErr = e; }
  if (listErr && listErr.kind === "key") throw listErr;
  const ranked = available ? rankGeminiModels(available) : GEMINI_STATIC_FALLBACK.slice();
  const wanted = (requested || env.GEMINI_MODEL || "").replace(/^models\//, "").trim();
  const list = [];
  if (wanted && (!available || available.includes(wanted)) && !isDead(wanted)) list.push(wanted);
  if (lastGoodModel && !list.includes(lastGoodModel) && (!available || available.includes(lastGoodModel))) list.push(lastGoodModel);
  for (const m of ranked) if (!list.includes(m) && !isDead(m)) list.push(m);
  if (!list.length) list.push(...ranked.slice(0, 3));
  return { list: list.slice(0, 5), ignored: wanted && available && !available.includes(wanted) ? wanted : "" };
}

function toGeminiParts(text, files) {
  const parts = [];
  for (const f of files || []) {
    if (!f || !f.data) continue;
    const m = String(f.data).match(/^data:([^;]+);base64,(.*)$/s);
    const mime = (m ? m[1] : f.type) || "application/octet-stream";
    const data = m ? m[2] : f.data;
    parts.push({ text: "Tệp đính kèm: " + (f.name || "file") + " (" + mime + ")" });
    parts.push({ inlineData: { mimeType: mime, data } });
  }
  parts.push({ text: text || "Hãy phân tích." });
  return parts;
}

async function callGemini(env, { system, history, message, files, wantJson, model }) {
  if (!env.GEMINI_API_KEY) throw new AIError("config", "Chưa có Secret GEMINI_API_KEY trên Cloudflare Worker.", 500);
  const contents = [];
  for (const h of (history || []).slice(-16)) {
    const t = (h.text || h.content || "").toString().slice(0, 4000);
    if (!t) continue;
    contents.push({ role: h.role === "user" ? "user" : "model", parts: [{ text: t }] });
  }
  // Gemini yêu cầu lượt đầu là user
  while (contents.length && contents[0].role !== "user") contents.shift();
  contents.push({ role: "user", parts: toGeminiParts(message, files) });

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192, ...(wantJson ? { responseMimeType: "application/json" } : {}) },
  };
  const { list, ignored } = await geminiCandidates(env, model);
  const tried = [];
  let lastErr = null;
  for (const m of list) {
    const r = await fetchTimeout(`${GEMINI_BASE}/models/${encodeURIComponent(m)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const e = classifyGemini(r.status, j);
      tried.push(m + " → " + e.kind);
      lastErr = e;
      if (["model", "quota", "server"].includes(e.kind)) { if (e.kind === "model") deadModels.set(m, Date.now()); if (m === lastGoodModel) lastGoodModel = ""; continue; }
      throw e; // key / request / api: không thử model khác
    }
    if (j.promptFeedback && j.promptFeedback.blockReason)
      throw new AIError("blocked", "Gemini từ chối nội dung (" + j.promptFeedback.blockReason + ").", 400);
    const cand = (j.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).filter(p => !p.thought && p.text).map(p => p.text).join("");
    if (!text) {
      tried.push(m + " → rỗng(" + (cand.finishReason || "?") + ")");
      lastErr = new AIError("empty", "Gemini không trả nội dung (" + (cand.finishReason || "không rõ lý do") + ").", 502);
      continue;
    }
    lastGoodModel = m;
    return { text, model: m, tried, ignored, usage: j.usageMetadata || null };
  }
  const e = lastErr || new AIError("model", "Không tìm được model Gemini khả dụng cho key này.", 404);
  e.message += " (Đã thử: " + tried.join("; ") + ")";
  throw e;
}

/* --------------------------- OpenAI / xAI (Grok) --------------------------- */
async function callOpenAICompat(env, provider, { system, history, message, files, wantJson, model }) {
  const isX = provider === "grok";
  const key = isX ? env.XAI_API_KEY : env.OPENAI_API_KEY;
  if (!key) throw new AIError("config", `Chưa cấu hình Secret ${isX ? "XAI_API_KEY" : "OPENAI_API_KEY"} trên Cloudflare. Tạm thời hãy dùng Gemini.`, 400);
  const url = isX ? "https://api.x.ai/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
  const m = model || (isX ? env.XAI_MODEL || "grok-3-mini" : env.OPENAI_MODEL || "gpt-4o-mini");
  const content = [{ type: "text", text: message || "Hãy phân tích." }];
  for (const f of files || []) {
    if (f && /^data:image\//.test(f.data || "")) content.push({ type: "image_url", image_url: { url: f.data } });
    else if (f) content.push({ type: "text", text: `[Tệp ${f.name}: nhà cung cấp này chưa hỗ trợ đọc trực tiếp loại tệp ${f.type}]` });
  }
  const messages = [{ role: "system", content: system }];
  for (const h of (history || []).slice(-16)) if (h.text) messages.push({ role: h.role === "user" ? "user" : "assistant", content: h.text.slice(0, 4000) });
  messages.push({ role: "user", content });
  const r = await fetchTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: m, messages, temperature: 0.3, ...(wantJson ? { response_format: { type: "json_object" } } : {}) }),
  });
  let j = {}; try { j = await r.json(); } catch (e) {}
  const name = isX ? "Grok" : "OpenAI";
  if (!r.ok) {
    const msg = (j.error && (j.error.message || j.error)) || "";
    if (r.status === 401) throw new AIError("key", `${name}: API key sai hoặc hết hạn.`, 401, msg);
    if (r.status === 404) throw new AIError("model", `${name}: model "${m}" không tồn tại.`, 404, msg);
    if (r.status === 429) throw new AIError("quota", `${name}: hết hạn mức/credit.`, 429, msg);
    throw new AIError("api", `${name} lỗi HTTP ${r.status}: ${msg}`, 502, msg);
  }
  const text = (((j.choices || [])[0] || {}).message || {}).content || "";
  if (!text) throw new AIError("empty", `${name} không trả nội dung.`, 502);
  return { text, model: m, tried: [], ignored: "" };
}

/* ------------------------------ Prompt ------------------------------ */
function buildSystem(context, mode) {
  let ctx = "";
  try { ctx = JSON.stringify(context || {}); } catch (e) { ctx = "{}"; }
  if (ctx.length > 60000) ctx = ctx.slice(0, 60000) + "…(đã cắt bớt)";
  const today = new Date().toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  return `Bạn là "Trợ lý AI TV TƯỢNG" — trợ lý vận hành cho xưởng tượng tô màu TV TƯỢNG (sản xuất tượng, màu, cọ, khay, bao bì; đóng combo; đặt kệ cho mượn tại cửa hàng; giao hàng ký gửi; đối soát bán/hỏng; thu tiền công nợ). Hôm nay: ${today}.
Luồng nghiệp vụ: Nhập/Sản xuất → Kho → Đóng Combo → Giao ký gửi → Đối soát → Thu tiền → Báo cáo.
Người dùng không rành công nghệ: trả lời tiếng Việt, ngắn gọn, rõ ràng, thân thiện, xưng "em", gọi "anh/chị".

DỮ LIỆU HIỆN TẠI (JSON, là nguồn sự thật duy nhất; tiền VND):
${ctx}

QUY TẮC BẮT BUỘC:
1. Chỉ dùng số liệu trong DỮ LIỆU HIỆN TẠI. Không bịa sản phẩm, cửa hàng, số tồn, công nợ. Nếu thiếu dữ liệu, nói rõ là chưa có.
2. Bạn KHÔNG tự ghi dữ liệu. Khi người dùng muốn thay đổi dữ liệu, hãy tạo "actions" để website hiển thị bản xem trước; người dùng sẽ bấm Xác nhận.
3. Câu hỏi tra cứu/tư vấn (tồn kho, sắp hết, tồn lâu, hàng ký gửi, công nợ, doanh thu, kệ, đề xuất bổ sung hàng, bất thường) → trả lời trong "reply", actions = [].
4. Khớp tên sản phẩm/cửa hàng với dữ liệu: điền "product_sku"/"store_name" đúng như trong dữ liệu. Nếu không chắc hoặc không có trong dữ liệu → để null, giảm "confidence" và ghi cảnh báo vào "warnings". Không đoán bừa.
5. Với ảnh/hóa đơn/chứng từ/PDF/CSV: đọc kỹ, trích xuất nhà cung cấp, ngày chứng từ, số chứng từ, từng dòng hàng (tên trên chứng từ, số lượng, đơn giá, thành tiền), tổng tiền. Kiểm tra số lượng × đơn giá = thành tiền và tổng cộng; chỗ nào mờ/không đọc được/không khớp → ghi vào warnings, confidence < 0.7. Tạo action "stock_in" (receipt_type "purchase") nếu là hóa đơn mua hàng. Tóm tắt nội dung đọc được trong reply.
6. Nếu yêu cầu mơ hồ (thiếu số lượng, thiếu cửa hàng...) → hỏi lại trong reply, không tạo action.
7. Số tiền trả về dạng số nguyên (không dấu chấm, không chữ "đ").

ĐỊNH DẠNG TRẢ LỜI: CHỈ một đối tượng JSON:
{"reply":"câu trả lời cho người dùng (có thể xuống dòng, dùng • để liệt kê)","actions":[{"type":"...","params":{...},"confidence":0.0-1.0,"warnings":["..."]}]}

CÁC LOẠI ACTION HỢP LỆ (chỉ dùng đúng các loại này):
- create_store: {"name","area","phone","address","contact_name"}
- create_product: {"name","sku","category","unit","cost","retail_price","store_share","min_stock","source_type":"manufactured|purchased"}
- stock_in: {"receipt_type":"purchase|production|return|adjustment","supplier","doc_date":"YYYY-MM-DD","doc_no","doc_total","note","items":[{"name_on_doc","product_sku","qty","unit_cost","line_total","confidence"}]}
- create_combo: {"name","sku","retail_price","store_share","components":[{"product_sku","qty"}]}
- build_combo: {"combo_sku","qty"}   (đóng combo từ vật tư trong kho)
- consign: {"store_name","items":[{"product_sku","qty"}],"note"}   (giao hàng ký gửi; sản phẩm có thể là combo)
- reconcile: {"store_name","items":[{"product_sku","sold_qty","broken_qty","returned_qty"}],"note"}
- record_payment: {"store_name","amount","method":"cash|bank_transfer|other","note"}
- assign_rack: {"code","store_name","asset_value","deposit","note"}
${mode === "document" ? "\nNgười dùng vừa gửi chứng từ/tệp: ưu tiên trích xuất theo quy tắc 5." : ""}`;
}

function parseAIJson(text) {
  let t = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  // Quét tìm đối tượng JSON cân bằng đầu tiên (phòng khi AI trả thừa ký tự / lặp JSON)
  for (let s = t.indexOf("{"); s >= 0; s = t.indexOf("{", s + 1)) {
    let d = 0, q = false, esc = false;
    for (let i = s; i < t.length; i++) {
      const ch = t[i];
      if (q) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') q = false; continue; }
      if (ch === '"') q = true; else if (ch === "{") d++; else if (ch === "}" && --d === 0) {
        try { const o = JSON.parse(t.slice(s, i + 1)); if (o && (o.reply || o.actions)) return o; } catch (e) {}
        break;
      }
    }
  }
  return { reply: text, actions: [], unparsed: true };
}

const num = v => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d,.\-]/g, "");
  if (!s) return null;
  // "15.000" / "15,000" → 15000 ; "1,5" → 1.5
  const n = /^-?\d{1,3}([.,]\d{3})+$/.test(s) ? Number(s.replace(/[.,]/g, "")) : Number(s.replace(",", "."));
  return isFinite(n) ? n : null;
};

function sanitizeActions(actions) {
  const out = [], dropped = [];
  for (const a of Array.isArray(actions) ? actions.slice(0, 10) : []) {
    if (!a || !ACTION_TYPES.includes(a.type)) { dropped.push(a && a.type); continue; }
    const p = a.params && typeof a.params === "object" ? a.params : {};
    for (const k of ["cost", "retail_price", "store_share", "min_stock", "doc_total", "amount", "asset_value", "deposit", "qty"]) if (k in p) p[k] = num(p[k]);
    for (const listKey of ["items", "components"]) {
      if (Array.isArray(p[listKey])) p[listKey] = p[listKey].slice(0, 100).map(it => {
        const o = { ...it };
        for (const k of ["qty", "unit_cost", "line_total", "sold_qty", "broken_qty", "returned_qty", "confidence"]) if (k in o) o[k] = num(o[k]);
        return o;
      });
    }
    let c = num(a.confidence); if (c === null) c = 0.5; c = Math.max(0, Math.min(1, c));
    out.push({ type: a.type, params: p, confidence: c, warnings: Array.isArray(a.warnings) ? a.warnings.map(String).slice(0, 20) : [] });
  }
  return { actions: out, dropped: dropped.filter(Boolean) };
}

/* ------------------------------ Router ------------------------------ */
const worker = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, env) });

    if (req.method === "GET") {
      if (url.pathname.replace(/\/+$/, "") === "/models") {
        try {
          const list = await listGeminiModels(env, true);
          return json(req, env, { ok: true, auto_order: rankGeminiModels(list), available: list });
        } catch (e) { return json(req, env, { ok: false, kind: e.kind || "error", error: e.message }, e.status || 500); }
      }
      return json(req, env, {
        ok: true, service: "TV TUONG AI", version: VERSION,
        providers: ["gemini", "openai", "grok"],
        configured: { gemini: !!env.GEMINI_API_KEY, openai: !!env.OPENAI_API_KEY, grok: !!env.XAI_API_KEY },
        message: "Backend AI đang hoạt động. GET /models để xem model Gemini khả dụng.",
      });
    }
    if (req.method !== "POST") return json(req, env, { ok: false, error: "Chỉ hỗ trợ GET/POST." }, 405);

    let body;
    try { body = await req.json(); } catch (e) { return json(req, env, { ok: false, kind: "request", error: "Dữ liệu gửi lên không phải JSON hợp lệ." }, 400); }
    const provider = ["gemini", "openai", "grok"].includes(body.provider) ? body.provider : "gemini";
    const mode = body.mode || "chat";
    const files = Array.isArray(body.files) ? body.files.slice(0, 8) : [];
    const wantJson = mode !== "test";
    const system = mode === "test"
      ? "Bạn là trợ lý kiểm tra kết nối. Trả lời thật ngắn bằng tiếng Việt."
      : buildSystem(body.context, files.length ? "document" : mode);
    const args = { system, history: body.history, message: String(body.message || "").slice(0, 20000), files, wantJson, model: (body.model || "").trim() };

    try {
      const r = provider === "gemini" ? await callGemini(env, args) : await callOpenAICompat(env, provider, args);
      if (!wantJson) return json(req, env, { ok: true, provider, model: r.model, text: r.text, reply: r.text, actions: [], tried: r.tried });
      const parsed = parseAIJson(r.text);
      const { actions, dropped } = sanitizeActions(parsed.actions);
      const reply = String(parsed.reply || parsed.text || parsed.answer || "").trim() || (actions.length ? "Em đã chuẩn bị thao tác, anh/chị kiểm tra bản xem trước bên dưới." : "Em chưa có câu trả lời.");
      const notes = [];
      if (r.ignored) notes.push(`Model "${r.ignored}" không khả dụng, đã tự chuyển sang ${r.model}.`);
      if (dropped.length) notes.push("Đã bỏ qua thao tác không được phép: " + dropped.join(", "));
      return json(req, env, { ok: true, provider, model: r.model, reply, text: reply, actions, notes, tried: r.tried, usage: r.usage || null });
    } catch (e) {
      const kind = e.kind || "error";
      return json(req, env, { ok: false, provider, kind, error: e.message || String(e), detail: e.detail || "" }, e.status || 500);
    }
  },
};

export default worker;
