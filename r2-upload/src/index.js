// 画布参考素材上传：校验调用方的 new-api 令牌后通过 R2 绑定写入独立的 canvas-uploads 桶，
// 生成视频时只提交公开地址，请求体不再受 Cloudflare 100MB 限制。不需要 S3 密钥。
//
// key 为 {prefix}/references/{sha256}{ext}，同一素材复用同一对象：已存在时直接返回地址。
// 不超过 PART_SIZE 的文件一次 PUT（R2 校验 sha256）；更大的文件按 PART_SIZE 分片走 R2 multipart，
// 每个请求都低于 100MB。

const EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
};

const PART_SIZE = 50 * 1024 * 1024;
const AUTH_CACHE_MS = 5 * 60 * 1000;
const authCache = new Map();

export default {
    async fetch(request, env) {
        const response = await route(request, env);
        // 画布在 xaxn.fun，接口在 upload.xaxn.fun：只给允许的来源返回 CORS 头。
        const origin = request.headers.get("Origin");
        if (origin && allowedOrigins(env).includes(origin)) {
            response.headers.set("Access-Control-Allow-Origin", origin);
            response.headers.set("Vary", "Origin");
        }
        return response;
    },
};

async function route(request, env) {
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: { "Access-Control-Allow-Methods": "POST, PUT, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" },
        });
    }
    const action = new URL(request.url).pathname.split("/").pop();
    const handler = { init, object, part, complete }[action];
    if (!handler) return json({ error: "not found" }, 404);
    try {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        if (!token || !(await verifyToken(token, env))) return json({ error: "invalid token" }, 401);
        return await handler(request, env);
    } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
}

function allowedOrigins(env) {
    return String(env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

// POST {sha256, mimeType, size} → {url, exists: true} | {url, key, mode: "single"} | {url, key, mode: "multipart", uploadId, partSize}
async function init(request, env) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await request.json().catch(() => null);
    const sha256 = String(body?.sha256 || "").toLowerCase();
    const mimeType = String(body?.mimeType || "").toLowerCase().split(";")[0].trim();
    const size = Number(body?.size);
    if (!/^[0-9a-f]{64}$/.test(sha256)) return json({ error: "invalid sha256" }, 400);
    if (!EXTENSIONS[mimeType]) return json({ error: `unsupported type ${mimeType || "(empty)"}` }, 400);
    const maxBytes = Number(env.MAX_OBJECT_SIZE_MB || 1024) * 1024 * 1024;
    if (!Number.isInteger(size) || size <= 0 || size > maxBytes) return json({ error: "invalid size" }, 400);

    const key = `${keyPrefix(env)}references/${sha256}${EXTENSIONS[mimeType]}`;
    const url = publicUrl(env, key);
    if (await env.BUCKET.head(key)) return json({ url, exists: true });
    if (size <= PART_SIZE) return json({ url, key, exists: false, mode: "single" });
    const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: mimeType } });
    return json({ url, key, exists: false, mode: "multipart", uploadId: upload.uploadId, partSize: PART_SIZE });
}

// PUT ?key=  body=文件内容；R2 按 key 中的 sha256 校验内容，key 因此始终与内容一致。
async function object(request, env) {
    if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
    const key = validKey(env, new URL(request.url).searchParams.get("key"));
    if (!key) return json({ error: "invalid key" }, 400);
    const length = Number(request.headers.get("Content-Length"));
    if (!Number.isFinite(length) || length > PART_SIZE) return json({ error: "file too large for single upload" }, 413);
    const sha256 = key.slice(key.lastIndexOf("/") + 1).split(".")[0];
    const contentType = request.headers.get("Content-Type") || "application/octet-stream";
    await env.BUCKET.put(key, request.body, { sha256, httpMetadata: { contentType } });
    return json({ url: publicUrl(env, key) });
}

// PUT ?key=&uploadId=&partNumber=  body=分片 → {partNumber, etag}
async function part(request, env) {
    if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
    const params = new URL(request.url).searchParams;
    const key = validKey(env, params.get("key"));
    const uploadId = params.get("uploadId");
    const partNumber = Number(params.get("partNumber"));
    if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return json({ error: "invalid part" }, 400);
    const uploaded = await env.BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, request.body);
    return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
}

// POST {key, uploadId, parts: [{partNumber, etag}]} → {url}
async function complete(request, env) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await request.json().catch(() => null);
    const key = validKey(env, body?.key);
    if (!key || !body?.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) return json({ error: "invalid upload" }, 400);
    const parts = body.parts.map((item) => ({ partNumber: Number(item.partNumber), etag: String(item.etag) }));
    await env.BUCKET.resumeMultipartUpload(key, String(body.uploadId)).complete(parts);
    return json({ url: publicUrl(env, key) });
}

// 只允许写入本 Worker 生成的素材 key，防止借接口写入桶内任意路径。
function validKey(env, value) {
    const key = String(value || "");
    const extensions = [...new Set(Object.values(EXTENSIONS))].map((ext) => ext.slice(1)).join("|");
    const pattern = new RegExp(`^${escapeRegExp(keyPrefix(env))}references/[0-9a-f]{64}\\.(${extensions})$`);
    return pattern.test(key) ? key : "";
}

function keyPrefix(env) {
    const prefix = String(env.R2_PREFIX || "").replace(/^\/+|\/+$/g, "");
    return prefix ? `${prefix}/` : "";
}

function publicUrl(env, key) {
    return `${String(env.PUBLIC_BASE_URL).replace(/\/+$/, "")}/${key}`;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 令牌按 new-api 的 /v1/models 校验，通过的结果短暂缓存，避免每个分片都回源。
async function verifyToken(token, env) {
    const cached = authCache.get(token);
    if (cached && cached > Date.now()) return true;
    const response = await fetch(`${String(env.NEW_API_ORIGIN).replace(/\/+$/, "")}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return false;
    authCache.set(token, Date.now() + AUTH_CACHE_MS);
    return true;
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
