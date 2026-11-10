import { useCallback } from "react";

export function useDownloadVideo() {
    return useCallback((url: string, filename: string) => {
        // 直接交给浏览器处理视频链接，不预先请求文件或转换 Blob。
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        // 跨域链接未返回附件响应头时可能打开播放页，避免离开当前画布。
        link.target = "_blank";
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
    }, []);
}
