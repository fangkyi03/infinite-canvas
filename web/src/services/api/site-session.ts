import { guessCapability, type ModelChannel } from "@/stores/use-config-store";

// 画布部署在 new-api 同域名的子路径（/canvas/）下时，直接用 new-api 的登录状态：
// 用 Refresh Cookie 换取当前用户专属的 Canvas 令牌，并按 new-api 分组生成渠道，
// 用户无需配置 Base URL 和 API Key，调用费用直接从其控制台余额扣除。
export const SITE_CHANNEL_PREFIX = "site-";

export function isSiteDeployment() {
    return import.meta.env.BASE_URL !== "/";
}

type PricingModel = { model_name?: string; enable_groups?: string[] };
type PricingResponse = { data?: PricingModel[]; usable_group?: Record<string, string> };

export class SiteLoginRequiredError extends Error {}

export async function loadSiteChannels(): Promise<ModelChannel[]> {
    const tokenResponse = await fetch("/api/user/auth/canvas-token", { method: "POST", credentials: "same-origin" });
    if (tokenResponse.status === 401 || tokenResponse.status === 403) throw new SiteLoginRequiredError();
    const token = (await tokenResponse.json()) as { success?: boolean; message?: string; data?: { key?: string } };
    if (!token.success || !token.data?.key) throw new Error(token.message || "无法获取画布令牌");
    const apiKey = token.data.key;
    const baseUrl = window.location.origin;

    const [pricing, available] = await Promise.all([
        fetch("/api/pricing", { credentials: "same-origin" }).then((response) => response.json() as Promise<PricingResponse>),
        fetch("/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } })
            .then((response) => response.json() as Promise<{ data?: Array<{ id?: string }> }>)
            .then((body) => new Set((body.data || []).map((item) => item.id || ""))),
    ]);

    // 按分组归类当前令牌可调用的模型；default/auto 是通用分组，模型已在各业务分组中列出，不单独展示。
    const groups = new Map<string, string[]>();
    for (const item of pricing.data || []) {
        const name = item.model_name || "";
        if (!available.has(name)) continue;
        for (const group of item.enable_groups || []) {
            if (group === "default" || group === "auto") continue;
            groups.set(group, [...(groups.get(group) || []), name]);
        }
    }
    const order = Object.keys(pricing.usable_group || {});
    return [...groups.entries()]
        .sort(([a], [b]) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)))
        .map(([group, models]) => ({
            id: `${SITE_CHANNEL_PREFIX}${group}`,
            name: pricing.usable_group?.[group] || group,
            baseUrl,
            apiKey,
            apiFormat: "openai" as const,
            models: models.sort().map((name) => ({ name, capability: guessCapability(name) })),
        }));
}

export function redirectToSiteLogin() {
    const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`/sign-in?redirect=${encodeURIComponent(target)}`);
}
