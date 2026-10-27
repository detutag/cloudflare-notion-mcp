# Notion MCP Server (Netlify Functions)

無狀態 Streamable HTTP MCP Server，零 runtime 依賴，適用 Netlify Functions。
端點：`POST /mcp`　健康檢查：`GET /health`

此為 `netlify` 分支。`main` 仍為 Cloudflare Workers 適配，請勿把本分支的變更合併回 `main`。

## 工具
`notion_search` · `notion_get_page` · `notion_read_page_content` · `notion_get_database` ·
`notion_query_database` · `notion_create_page` · `notion_update_page` · `notion_append_content`

## 環境變數

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `NOTION_TOKEN` | 是 | Notion Internal Integration secret |
| `MCP_AUTH_TOKEN` | 是 | 客戶端存取本伺服器的 Bearer token（例如 `openssl rand -hex 32`） |
| `NOTION_VERSION` | 否 | 預設 `2022-06-28` |
| `ALLOWED_ORIGINS` | 否 | 逗號分隔的瀏覽器 Origin 白名單，支援 `*` 萬用字元。留空 = 允許任何來源 |
| `ALLOW_QUERY_TOKEN` | 否 | 設為 `true` 時也接受 `?key=<token>`（較不安全） |

## 部署

1. 到 https://www.notion.so/profile/integrations 建立 Internal integration，複製 secret。
2. 在要開放的 Notion 頁面 / 資料庫右上 `…` → Connections → 加入該 integration。
3. 在 [Netlify](https://app.netlify.com/) 匯入此 GitHub repo：
   - Branch to deploy：`netlify`
   - Build command：留空
   - Publish directory：`public`
4. Site configuration → Environment variables 加入 `NOTION_TOKEN` 與 `MCP_AUTH_TOKEN`（必要時再加選配變數）。
5. 觸發一次 Deploy。完成後端點為：

```
https://<site>.netlify.app/mcp
```

Netlify 連上 GitHub 後，往 `netlify` 分支 push 就會自動部署，不必另設 CI。

### 用 CLI 部署（不經 Git）

```bash
npm install
npx netlify-cli login
npx netlify-cli env:set NOTION_TOKEN "<secret>"
npx netlify-cli env:set MCP_AUTH_TOKEN "<token>"
npx netlify-cli deploy --prod
```

本機測試：複製 `.env.example` 為 `.env`，填入實際值，執行 `npm run dev`。
本機端點預設為 `http://localhost:8888/mcp`。

## 測試

```bash
URL=https://<site>.netlify.app/mcp
TOKEN=<MCP_AUTH_TOKEN>

curl -s $URL -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s $URL -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notion_search","arguments":{"query":"","page_size":5}}}'
```

## 瀏覽器 CORS

從網頁前端呼叫時，瀏覽器會送 `Origin`。`ALLOWED_ORIGINS` 留空即允許所有來源（會回對應的
`Access-Control-Allow-Origin`），通常不需要設定。

若要限制來源，填入完整 origin（含 scheme、不含路徑、不可只寫網域），可用 `*` 萬用字元：

```
ALLOWED_ORIGINS=https://chizk-gpt.hf.space
ALLOWED_ORIGINS=https://*.hf.space,https://app.example.com
```

注意：正確寫法是 `https://*.hf.space`，不是 `*.hf.space`，也不是 `hf.space`。

若在白名單中卻仍被擋，代表 `Origin` 與設定值不一致（`http` vs `https`、含尾斜線、
或子網域不符）。前端若同時送 `Authorization` 標頭，瀏覽器會先發 `OPTIONS` 預檢，
本伺服器對 `OPTIONS` 一律回 204 並附 CORS 標頭。

## 接到客戶端

```bash
# Claude Code
claude mcp add --transport http notion https://<site>.netlify.app/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Cursor / VS Code 等：`{"url": ".../mcp", "headers": {"Authorization": "Bearer ..."}}`

若客戶端無法設定自訂 header，可設 `ALLOW_QUERY_TOKEN=true`（Netlify env），
改用 `https://.../mcp?key=<token>`。注意 URL 可能出現在日誌中，安全性較低。

## 免費方案注意事項

- Netlify Free：每月約 12.5 萬次 Function 呼叫，單次執行上限 10 秒。
- 程式內仍保留每次呼叫最多 40 次對外 request 的上限，`notion_read_page_content` 超過會附上 `[truncated]`，可降低 `max_depth` 或分段讀。
- Notion API 版本預設 `2022-06-28`（支援 `/databases/{id}/query`）。可用 `NOTION_VERSION` 覆寫，但 `2025-09-03` 起資料庫改為 data sources，需要改寫查詢工具。
- 本伺服器為 stateless：不提供 GET SSE 串流與 session（規格允許，回 405）。

## 授權

[MIT](LICENSE) © detutag/cloudflare-notion-mcp
