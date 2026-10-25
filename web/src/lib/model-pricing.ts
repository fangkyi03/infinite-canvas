import { decodeChannelModel, type AiConfig, type ModelPricing } from "@/stores/use-config-store";

const UNIT_LABEL: Record<ModelPricing["unit"], string> = { call: "条", second: "秒" };

function formatUsd(value: number) {
    return `$${Number(value.toFixed(4))}`;
}

export function modelPricingLabel(pricing?: ModelPricing) {
    return pricing ? `${formatUsd(pricing.amount)} / ${UNIT_LABEL[pricing.unit]}` : "";
}

export function findModelPricing(config: AiConfig, model: string) {
    const decoded = decodeChannelModel(model);
    if (!decoded) return undefined;
    return config.channels.find((channel) => channel.id === decoded.channelId)?.models.find((item) => item.name === decoded.model)?.pricing;
}

/** 预估本次生成费用：按秒计费乘以视频时长，按条计费乘以生成数量；没有上游价格时返回空串。 */
export function estimateGenerationCost(config: AiConfig, options: { seconds?: number; count?: number }) {
    const pricing = findModelPricing(config, config.model);
    if (!pricing) return "";
    const count = Math.max(1, options.count || 1);
    const units = pricing.unit === "second" ? Math.max(0, options.seconds || 0) * count : count;
    return units ? `约 ${formatUsd(pricing.amount * units)}` : "";
}
