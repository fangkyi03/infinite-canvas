import localforage from "localforage";

import { R2_UPLOAD_URL } from "@/constant/runtime-config";
import { useConfigStore } from "@/stores/use-config-store";
import { isSiteDeployment, SITE_CHANNEL_PREFIX } from "./site-session";

// 站点模式下用户添加到画布的文件同时存一份到 R2（canvas-uploads 桶，由 r2-upload Worker 写入），
// 生成视频时直接提交公开地址，避免整份文件塞进请求体触发 Cloudflare 100MB 上限。
// 同一内容按 sha256 复用已上传的对象；超过分片大小的文件按 Worker 返回的 partSize 分片上传。
// 接口地址由 R2_UPLOAD_URL 配置（与画布不同域名，Worker 负责 CORS），未配置时不启用。
const UPLOAD_PATH = R2_UPLOAD_URL;

type InitResponse = { url?: string; key?: string; exists?: boolean; mode?: "single" | "multipart"; uploadId?: string; partSize?: number; error?: string };

const urlStore = localforage.createInstance({ name: "infinite-canvas", storeName: "r2_urls" });
const pendingMirrors = new Map<string, Promise<string | null>>();
const uploadedUrls = new Map<string, Promise<string>>();

/** 仅配置了上传接口、站点模式（画布与 new-api 同域名）且请求发往本站时可用。 */
export function canUploadReferencesToR2(baseUrl: string) {
    if (!UPLOAD_PATH || !isSiteDeployment()) return false;
    try {
        return new URL(baseUrl, window.location.origin).origin === window.location.origin;
    } catch {
        return false;
    }
}

function siteApiKey() {
    return useConfigStore.getState().config.channels.find((channel) => channel.id.startsWith(SITE_CHANNEL_PREFIX) && channel.apiKey)?.apiKey || "";
}

/** 用户上传的文件在本地保存后，后台同步一份到 R2；失败不影响本地使用，提交时会再按需上传。 */
export function mirrorUploadToR2(storageKey: string, blob: Blob) {
    if (!UPLOAD_PATH || !isSiteDeployment() || !(blob instanceof File) || !siteApiKey()) return;
    const pending = uploadReferenceToR2(blob, siteApiKey())
        .then(async (url) => {
            await urlStore.setItem(storageKey, url);
            return url;
        })
        .catch((error) => {
            console.warn("R2 mirror upload failed", error);
            return null;
        })
        .finally(() => pendingMirrors.delete(storageKey));
    pendingMirrors.set(storageKey, pending);
}

/** 本地素材已同步到 R2 时返回公开地址（上传中会等待完成）。 */
export async function getMirroredR2Url(storageKey?: string): Promise<string | null> {
    if (!storageKey) return null;
    const pending = pendingMirrors.get(storageKey);
    if (pending) return pending;
    return (await urlStore.getItem<string>(storageKey).catch(() => null)) || null;
}

export async function uploadReferenceToR2(blob: Blob, apiKey: string, signal?: AbortSignal): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const mimeType = (blob.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const cacheKey = `${sha256}:${mimeType}`;
    const cached = uploadedUrls.get(cacheKey);
    if (cached) return cached;

    const pending = uploadBlob(blob, sha256, mimeType, apiKey, signal);
    uploadedUrls.set(cacheKey, pending);
    pending.catch(() => uploadedUrls.delete(cacheKey));
    return pending;
}

async function uploadBlob(blob: Blob, sha256: string, mimeType: string, apiKey: string, signal?: AbortSignal) {
    const auth = { Authorization: `Bearer ${apiKey}` };
    const init = await request<InitResponse>(`${UPLOAD_PATH}/init`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ sha256, mimeType, size: blob.size }), signal });
    if (!init.url) throw new Error("R2 upload init returned no url");
    if (init.exists) return init.url;
    const key = encodeURIComponent(init.key || "");
    if (init.mode === "single") {
        await request(`${UPLOAD_PATH}/object?key=${key}`, { method: "PUT", headers: { ...auth, "Content-Type": mimeType }, body: blob, signal });
        return init.url;
    }
    if (!init.uploadId || !init.partSize) throw new Error("R2 upload init returned no multipart upload");
    const uploadId = encodeURIComponent(init.uploadId);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let offset = 0, partNumber = 1; offset < blob.size; offset += init.partSize, partNumber += 1) {
        const chunk = blob.slice(offset, offset + init.partSize);
        parts.push(await request(`${UPLOAD_PATH}/part?key=${key}&uploadId=${uploadId}&partNumber=${partNumber}`, { method: "PUT", headers: auth, body: chunk, signal }));
    }
    await request(`${UPLOAD_PATH}/complete`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ key: init.key, uploadId: init.uploadId, parts }), signal });
    return init.url;
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || `R2 upload failed (HTTP ${response.status})`);
    return body;
}
