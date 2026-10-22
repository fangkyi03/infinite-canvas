import { useEffect, useId, useMemo, useState } from "react";
import { Cascader } from "antd";
import { ChevronDown, Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { decodeChannelModel, modelOptionLabel, modelOptionName, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, onMissingConfig }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const options = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);
    const current = value || "";
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");
    // 模型来自多个渠道（主站分组）时按“分组 → 模型”级联展示，避免同名模型在平铺列表里重复出现。
    // 画布页频繁重渲染时 config/options 会是新对象；级联组件在 options 引用变化时会把
    // 展开的分组重置回当前选中值，导致无法切换分组。因此只按内容签名重建选项。
    const cascadeGroups = options
        .map((model) => {
            const channelId = decodeChannelModel(model)?.channelId || "";
            const channel = config.channels.find((item) => item.id === channelId);
            return channel ? `${channelId}\u0001${channel.name || channelId}\u0001${model}` : "";
        })
        .filter(Boolean)
        .join("\u0002");
    const cascadeOptions = useMemo(() => {
        const groups = new Map<string, { value: string; label: string; children: Array<{ value: string; label: React.ReactNode; title: string }> }>();
        for (const entry of cascadeGroups ? cascadeGroups.split("\u0002") : []) {
            const [channelId, channelName, model] = entry.split("\u0001");
            const group = groups.get(channelId) || { value: channelId, label: channelName, children: [] };
            group.children.push({ value: model, title: modelOptionName(model), label: <ModelLabelName model={model} /> });
            groups.set(channelId, group);
        }
        return [...groups.values()];
    }, [cascadeGroups]);
    const currentChannelId = decodeChannelModel(current)?.channelId;
    const cascadeValue = useMemo(() => (current && currentChannelId ? [currentChannelId, current] : undefined), [current, currentChannelId]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const triggerClassName = cn(
        "canvas-composer-model-picker flex h-8 w-fit max-w-full items-center gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
        fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
        open && "border-ring ring-2 ring-ring/20",
        className,
    );

    if (cascadeOptions.length > 1) {
        return (
            // 展开状态交给 Cascader 自己管理：受控 open 会被组件内部状态覆盖，
            // 导致选中模型后不收起。这里只同步状态用于触发器样式和关闭其他选择器。
            <Cascader
                options={cascadeOptions}
                value={cascadeValue}
                expandTrigger="hover"
                onOpenChange={(nextOpen) => {
                    if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                    setOpen(nextOpen);
                }}
                onChange={(path) => {
                    const model = path?.[path.length - 1];
                    if (typeof model === "string") onChange(model);
                }}
                // 弹层通过 Portal 渲染，但 React 合成事件仍沿组件树冒泡到画布节点和画布本身，
                // 会触发节点选中/拖拽/双击处理并吞掉这次点击，因此在弹层内截断冒泡。
                popupRender={(menu) => (
                    <div
                        data-canvas-no-zoom
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                    >
                        {menu}
                    </div>
                )}
                classNames={{ popup: { root: "canvas-model-cascader" } }}
                styles={{ popup: { root: { zIndex: 1200 } } }}
            >
                <button
                    type="button"
                    data-canvas-no-zoom
                    className={triggerClassName}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={current ? modelOptionLabel(config, current) : pickerPlaceholder}
                >
                    <ModelIcon model={current} />
                    <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? modelOptionLabel(config, current) : pickerPlaceholder}</span>
                    <ChevronDown className="size-4 shrink-0 opacity-50" />
                </button>
            </Cascader>
        );
    }

    return (
        <Select
            open={open}
            value={current}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length && config.channelMode === "local") onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? modelOptionLabel(config, current) : pickerPlaceholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? modelOptionLabel(config, current) : pickerPlaceholder}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    options.map((model) => (
                        <SelectItem key={model} value={model} textValue={modelOptionLabel(config, model)}>
                            <ModelLabel config={config} model={model} />
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ config, model }: { config: AiConfig; model: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{modelOptionLabel(config, model)}</span>
        </span>
    );
}

function ModelLabelName({ model }: { model: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{modelOptionName(model)}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={`${import.meta.env.BASE_URL}${icon.slice(1)}`} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
