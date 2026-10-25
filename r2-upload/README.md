# canvas-r2-upload

画布参考素材上传 Worker。站点模式（画布挂在 new-api 同域名 `/canvas/` 下）用户添加图片/视频/音频时，
画布在本地保存的同时把文件经本 Worker 写入独立的 `canvas-uploads` 桶（与生成的视频分开），
生成视频时 `/v1/videos` 只提交 `upload.xaxn.fun` 公开地址，请求体不再受 Cloudflare 100MB 限制。

Worker 通过 R2 绑定写入，不需要 S3 密钥；调用方必须带有效的 new-api 令牌（按 `/v1/models` 校验）。
接口挂在 `upload.xaxn.fun/api/*`（`xaxn.fun` 是 xaxn-fun-proxy 的 Custom Domain，不能再挂路由），
画布跨域调用，允许的来源由 `ALLOWED_ORIGINS` 配置。画布构建时需设置 `VITE_R2_UPLOAD_URL=https://upload.xaxn.fun/api`。
接口不可用时画布退回原来的 multipart 文件上传。

## 接口（均需 `Authorization: Bearer <new-api 令牌>`）

| 接口 | 说明 |
|---|---|
| `POST /api/init` `{sha256, mimeType, size}` | 对象已存在返回 `{url, exists: true}`；否则返回 `key` 和 `mode`（`single`，或 `multipart` 带 `uploadId`、`partSize`） |
| `PUT /api/object?key=` | 不超过 50MB 的文件一次上传，R2 按 sha256 校验内容 |
| `PUT /api/part?key=&uploadId=&partNumber=` | 大文件按 `partSize` 分片上传，返回 `{partNumber, etag}` |
| `POST /api/complete` `{key, uploadId, parts}` | 合并分片 |

对象 key 为 `references/{sha256}{ext}`，同一素材复用同一对象。

## 部署

```bash
npx wrangler r2 bucket create canvas-uploads
npx wrangler r2 bucket cors set canvas-uploads --file cors.json
npx wrangler r2 bucket domain add canvas-uploads --domain upload.xaxn.fun --zone-id <xaxn.fun zone id>
npx wrangler deploy
```
