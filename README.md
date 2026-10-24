# Notion MCP Server (Cloudflare Workers)

無狀態 Streamable HTTP MCP Server，零依賴，適用 Workers Free plan。
端點：`POST /mcp`　健康檢查：`GET /health`

## 工具
`notion_search` · `notion_get_page` · `notion_read_page_content` · `notion_get_database` ·
`notion_query_database` · `notion_create_page` · `notion_update_page` · `notion_append_content`

## 部署

1. 到 https://www.notion.so/profile/integrations 建立 Internal integration，複製 secret。
2. 在要開放的 Notion 頁面 / 資料庫右上 `…` → Connections → 加入該 integration。
3. 安裝並部署（用 CLI，不需要 Git 連線 / Workers Builds）：

```bash
npm install
npx wrangler login
npx wrangler secret put NOTION_TOKEN      # 貼上 Notion secret
npx wrangler secret put MCP_AUTH_TOKEN    # 例如：openssl rand -hex 32
npx wrangler deploy
```

本機測試：複製 `.dev.vars.example` 為 `.dev.vars`，執行 `npm run dev`。

## 測試

```bash
URL=https://notion-mcp.<你的子網域>.workers.dev/mcp
TOKEN=<MCP_AUTH_TOKEN>

curl -s $URL -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s $URL -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notion_search","arguments":{"query":"","page_size":5}}}'
```

## 接到客戶端

```bash
# Claude Code
claude mcp add --transport http notion https://notion-mcp.<子網域>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Cursor / VS Code 等：`{"url": ".../mcp", "headers": {"Authorization": "Bearer ..."}}`

若客戶端無法設定自訂 header，可設 `ALLOW_QUERY_TOKEN=true`（`wrangler secret put` 或 vars），
改用 `https://.../mcp?key=<token>`。注意 URL 可能出現在日誌中，安全性較低。

## 免費方案注意事項

- CPU 10ms/請求：只做 JSON 轉換，足夠；Notion 的等待時間不計入 CPU。
- 每次呼叫最多 50 個 subrequest：程式內設上限 40，`notion_read_page_content` 超過會附上 `[truncated]`，可降低 `max_depth` 或分段讀。
- 10 萬請求/天。
- Notion API 版本預設 `2022-06-28`（支援 `/databases/{id}/query`）。可用 `NOTION_VERSION` 覆寫，但 `2025-09-03` 起資料庫改為 data sources，需要改寫查詢工具。
- 本伺服器為 stateless：不提供 GET SSE 串流與 session（規格允許，回 405）。

## 若用 GitHub Actions 部署（不經 Workers Builds）

新增 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to Cloudflare Workers
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

在 repo 的 Settings → Secrets and variables → Actions 加入 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`。
（`npm ci` 需要 `package-lock.json` 一併 commit；`NOTION_TOKEN` / `MCP_AUTH_TOKEN` 只需事先用 `wrangler secret put` 設定一次，不必進 CI。）

## 授權

[MIT](LICENSE) © detutag/cloudflare-notion-mcp
