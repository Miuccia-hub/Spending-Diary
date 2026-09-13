# 留学账本

## 本地开发

在项目目录运行：

```bash
pnpm run dev:local
```

然后打开 `http://localhost:8787`。本地模式使用独立的 D1、R2 模拟数据，不会读取或改动 Cloudflare 线上账本；修改前端和 Worker 文件后会自动重新构建。

小票 AI 识别仍会调用你的 Cloudflare Workers AI 绑定。若只需要检查真实 Cloudflare 绑定而不想发布，可运行：

```bash
pnpm run preview:cloudflare
```

这个模式会读取 Cloudflare 的真实资源，因此不要用它测试注册、记账或删除等写入操作。

### 更强的小票识别（可选）

默认的本地模式使用 Workers AI 的视觉模型。若要启用更强的 OpenAI 视觉识别，以及对缩写/不确定商品名的联网检索，在本机 `.dev.vars` 中添加自己的 `OPENAI_API_KEY`（不要贴到聊天里，也不要提交）。Worker 会优先使用 `gpt-5-mini` 识别小票；只有无法确定商品中文名时，才会把**商品文字标签**发送给联网检索，不会把小票图片交给检索工具。

无论模型来源如何，服务端都会以小票的 `items/subtotal` 单位数、商品金额合计和最终总价做交叉校验。多件商品如 `4 @ $1.80 EACH` 会算作 4 件；`4 FOR $6.50 -0.72` 等负数行会作为独立组合优惠保留。校验不一致时，确认页会预留可编辑空项，避免静默少记。

## 发布

确认本地效果后，先运行预检：

```bash
pnpm run check:cloudflare
```

确认无误再正式发布：

```bash
pnpm run deploy:cloudflare
```

生产环境的会话密钥由 Cloudflare Secret 管理，`.dev.vars` 不会被上传或提交。
