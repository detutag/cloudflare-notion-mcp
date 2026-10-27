/**
 * Notion MCP Server (Netlify Functions)
 *
 * Transport : MCP Streamable HTTP (stateless, single JSON response per POST)
 * Endpoint  : POST /mcp
 * Auth      : Authorization: Bearer <MCP_AUTH_TOKEN>
 * No SDK dependency -> tiny bundle.
 */

export interface Env {
  NOTION_TOKEN: string; // Notion internal integration secret
  MCP_AUTH_TOKEN: string; // token clients must present to this server
  NOTION_VERSION?: string; // default 2022-06-28
  ALLOWED_ORIGINS?: string; // comma-separated origin allowlist, `*` wildcards OK, empty = allow all
  ALLOW_QUERY_TOKEN?: string; // "true" => also accept ?key=<token> (less secure)
}

const SERVER_INFO = { name: "notion-mcp", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_SUBREQUESTS = 40;

/* ------------------------------------------------------------------ */
/* Notion client                                                       */
/* ------------------------------------------------------------------ */

class Notion {
  used = 0;
  constructor(private env: Env) {}

  async call(method: string, path: string, body?: unknown): Promise<any> {
    if (++this.used > MAX_SUBREQUESTS) {
      throw new Error(`Subrequest budget (${MAX_SUBREQUESTS}) exhausted for this call`);
    }
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.env.NOTION_TOKEN}`,
        "Notion-Version": this.env.NOTION_VERSION ?? "2022-06-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
    if (!res.ok) {
      throw new Error(`Notion API ${res.status} ${data.code ?? ""}: ${data.message ?? text}`);
    }
    return data;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers: Notion objects -> compact JSON / markdown                  */
/* ------------------------------------------------------------------ */

const plain = (rt: any[] | undefined): string => (rt ?? []).map((t) => t.plain_text ?? "").join("");

function propValue(p: any): unknown {
  switch (p.type) {
    case "title":
    case "rich_text":
      return plain(p[p.type]);
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return p[p.type];
    case "select":
    case "status":
      return p[p.type]?.name ?? null;
    case "multi_select":
      return (p.multi_select ?? []).map((s: any) => s.name);
    case "date":
      return p.date;
    case "people":
      return (p.people ?? []).map((u: any) => u.name ?? u.id);
    case "relation":
      return (p.relation ?? []).map((r: any) => r.id);
    case "files":
      return (p.files ?? []).map((f: any) => ({ name: f.name, url: f.external?.url ?? f.file?.url }));
    case "formula":
      return p.formula?.[p.formula.type] ?? null;
    case "rollup":
      return p.rollup?.[p.rollup.type] ?? null;
    case "unique_id":
      return `${p.unique_id?.prefix ? p.unique_id.prefix + "-" : ""}${p.unique_id?.number}`;
    case "created_by":
    case "last_edited_by":
      return p[p.type]?.name ?? p[p.type]?.id;
    default:
      return null;
  }
}

function simplifyPage(page: any) {
  const props: Record<string, unknown> = {};
  let title = "";
  for (const [name, p] of Object.entries<any>(page.properties ?? {})) {
    if (p.type === "title") title = plain(p.title);
    props[name] = propValue(p);
  }
  return {
    object: "page",
    id: page.id,
    title,
    url: page.url,
    archived: page.archived ?? page.in_trash ?? false,
    parent: page.parent,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    properties: props,
  };
}

function simplifyDatabase(db: any) {
  const schema: Record<string, unknown> = {};
  for (const [name, p] of Object.entries<any>(db.properties ?? {})) {
    const extra =
      p.select?.options ?? p.multi_select?.options ?? p.status?.options;
    schema[name] = extra
      ? { type: p.type, options: extra.map((o: any) => o.name) }
      : { type: p.type };
  }
  return {
    object: "database",
    id: db.id,
    title: plain(db.title),
    url: db.url,
    description: plain(db.description),
    properties: schema,
  };
}

function blockToLine(b: any): string {
  const t: string = b.type;
  const d = b[t] ?? {};
  const text = plain(d.rich_text);
  const fileUrl = d.type === "external" ? d.external?.url : d.file?.url;
  switch (t) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${d.checked ? "x" : " "}] ${text}`;
    case "toggle":
      return `- ▸ ${text}`;
    case "quote":
      return `> ${text}`;
    case "callout":
      return `> ${d.icon?.emoji ?? "💡"} ${text}`;
    case "code":
      return "```" + (d.language ?? "") + "\n" + text + "\n```";
    case "divider":
      return "---";
    case "equation":
      return `$$${d.expression}$$`;
    case "child_page":
      return `[child_page: ${d.title}] (id: ${b.id})`;
    case "child_database":
      return `[child_database: ${d.title}] (id: ${b.id})`;
    case "bookmark":
    case "embed":
    case "link_preview":
      return d.url ?? "";
    case "image":
    case "file":
    case "pdf":
    case "video":
    case "audio":
      return `[${t}] ${fileUrl ?? ""}`;
    case "table_row":
      return "| " + (d.cells ?? []).map((c: any[]) => plain(c)).join(" | ") + " |";
    default:
      return text || `[${t}]`;
  }
}

async function readBlocks(n: Notion, id: string, depth: number, indent: number, out: string[]) {
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const res = await n.call("GET", `/blocks/${id}/children?${q}`);
    for (const b of res.results) {
      out.push("  ".repeat(indent) + blockToLine(b));
      if (b.has_children && depth > 0 && b.type !== "child_page" && b.type !== "child_database") {
        await readBlocks(n, b.id, depth - 1, indent + 1, out);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
}

/* Markdown -> Notion blocks (small subset) */

const rt = (text: string) => {
  const out: any[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    out.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  }
  return out.length ? out : [{ type: "text", text: { content: "" } }];
};
const blk = (type: string, text: string) => ({ object: "block", type, [type]: { rich_text: rt(text) } });
const LANG: Record<string, string> = {
  js: "javascript", ts: "typescript", py: "python", sh: "shell", bash: "shell", yml: "yaml", md: "markdown",
};

function markdownToBlocks(md: string): any[] {
  const blocks: any[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      const lang = fence[1].toLowerCase();
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: rt(code.join("\n")), language: LANG[lang] ?? (lang || "plain text") },
      });
      continue;
    }
    if (!line.trim()) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) blocks.push(blk(`heading_${m[1].length}`, m[2]));
    else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)/)))
      blocks.push({ object: "block", type: "to_do", to_do: { rich_text: rt(m[2]), checked: m[1] !== " " } });
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) blocks.push(blk("bulleted_list_item", m[1]));
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) blocks.push(blk("numbered_list_item", m[1]));
    else if ((m = line.match(/^>\s?(.*)/))) blocks.push(blk("quote", m[1]));
    else if (/^---+$/.test(line.trim())) blocks.push({ object: "block", type: "divider", divider: {} });
    else blocks.push(blk("paragraph", line));
  }
  return blocks;
}

async function appendBlocks(n: Notion, blockId: string, blocks: any[]) {
  for (let i = 0; i < blocks.length; i += 100) {
    await n.call("PATCH", `/blocks/${blockId}/children`, { children: blocks.slice(i, i + 100) });
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: (args: any, n: Notion) => Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const TOOLS: Tool[] = [
  {
    name: "notion_search",
    description:
      "Search pages and databases shared with the integration, by title. Returns id, title, url. Omit query to list recent items.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Text to search in titles"),
        object: { type: "string", enum: ["page", "database"], description: "Filter by object type" },
        page_size: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        start_cursor: str("Pagination cursor from a previous call"),
      },
    },
    annotations: READ,
    async handler(a, n) {
      const body: any = { page_size: a.page_size ?? 10 };
      if (a.query) body.query = a.query;
      if (a.object) body.filter = { property: "object", value: a.object };
      if (a.start_cursor) body.start_cursor = a.start_cursor;
      const res = await n.call("POST", "/search", body);
      return {
        results: res.results.map((r: any) =>
          r.object === "database"
            ? { object: "database", id: r.id, title: plain(r.title), url: r.url }
            : {
                object: "page",
                id: r.id,
                title: simplifyPage(r).title,
                url: r.url,
                last_edited_time: r.last_edited_time,
              },
        ),
        has_more: res.has_more,
        next_cursor: res.next_cursor,
      };
    },
  },
  {
    name: "notion_get_page",
    description: "Get a page's metadata and properties (not its body). Use notion_read_page_content for the body.",
    inputSchema: {
      type: "object",
      properties: { page_id: str("Page ID or UUID") },
      required: ["page_id"],
    },
    annotations: READ,
    async handler(a, n) {
      return simplifyPage(await n.call("GET", `/pages/${a.page_id}`));
    },
  },
  {
    name: "notion_read_page_content",
    description:
      "Read a page's (or any block's) content as Markdown-like text. max_depth controls how many levels of nested blocks are expanded.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: str("Page ID or block ID"),
        max_depth: { type: "integer", minimum: 0, maximum: 3, default: 1 },
      },
      required: ["block_id"],
    },
    annotations: READ,
    async handler(a, n) {
      const lines: string[] = [];
      try {
        await readBlocks(n, a.block_id, Math.min(a.max_depth ?? 1, 3), 0, lines);
      } catch (e) {
        lines.push(`[truncated: ${(e as Error).message}]`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "notion_get_database",
    description: "Get a database's title and property schema (names, types, select options).",
    inputSchema: {
      type: "object",
      properties: { database_id: str("Database ID") },
      required: ["database_id"],
    },
    annotations: READ,
    async handler(a, n) {
      return simplifyDatabase(await n.call("GET", `/databases/${a.database_id}`));
    },
  },
  {
    name: "notion_query_database",
    description:
      "Query a database with optional Notion filter/sorts JSON. Returns simplified rows. See Notion API docs for filter syntax.",
    inputSchema: {
      type: "object",
      properties: {
        database_id: str("Database ID"),
        filter: { type: "object", description: "Notion filter object" },
        sorts: { type: "array", items: { type: "object" }, description: "Notion sorts array" },
        page_size: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        start_cursor: str("Pagination cursor"),
      },
      required: ["database_id"],
    },
    annotations: READ,
    async handler(a, n) {
      const body: any = { page_size: a.page_size ?? 20 };
      if (a.filter) body.filter = a.filter;
      if (a.sorts) body.sorts = a.sorts;
      if (a.start_cursor) body.start_cursor = a.start_cursor;
      const res = await n.call("POST", `/databases/${a.database_id}/query`, body);
      return {
        results: res.results.map(simplifyPage),
        has_more: res.has_more,
        next_cursor: res.next_cursor,
      };
    },
  },
  {
    name: "notion_create_page",
    description:
      "Create a page under a page or database. `title` is a convenience; for databases you can also pass raw Notion `properties`. `content` is Markdown (headings, lists, to-dos, quotes, code fences).",
    inputSchema: {
      type: "object",
      properties: {
        parent_type: { type: "string", enum: ["page", "database"] },
        parent_id: str("Parent page ID or database ID"),
        title: str("Page title"),
        properties: { type: "object", description: "Raw Notion properties object (merged over title)" },
        content: str("Body in Markdown"),
      },
      required: ["parent_type", "parent_id"],
    },
    annotations: WRITE,
    async handler(a, n) {
      const properties: any = {};
      let parent: any;
      if (a.parent_type === "database") {
        parent = { database_id: a.parent_id };
        if (a.title) {
          const db = await n.call("GET", `/databases/${a.parent_id}`);
          const titleProp = Object.entries<any>(db.properties).find(([, p]) => p.type === "title")?.[0];
          if (!titleProp) throw new Error("Database has no title property");
          properties[titleProp] = { title: rt(a.title) };
        }
      } else {
        parent = { page_id: a.parent_id };
        if (a.title) properties.title = { title: rt(a.title) };
      }
      Object.assign(properties, a.properties ?? {});
      const blocks = a.content ? markdownToBlocks(a.content) : [];
      const page = await n.call("POST", "/pages", {
        parent,
        properties,
        children: blocks.slice(0, 100),
      });
      if (blocks.length > 100) await appendBlocks(n, page.id, blocks.slice(100));
      return simplifyPage(page);
    },
  },
  {
    name: "notion_update_page",
    description:
      "Update a page's properties (raw Notion properties object), or archive/restore it with `archived`.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page ID"),
        properties: { type: "object", description: "Raw Notion properties to update" },
        archived: { type: "boolean", description: "true = move to trash, false = restore" },
      },
      required: ["page_id"],
    },
    annotations: WRITE,
    async handler(a, n) {
      const body: any = {};
      if (a.properties) body.properties = a.properties;
      if (typeof a.archived === "boolean") body.archived = a.archived;
      return simplifyPage(await n.call("PATCH", `/pages/${a.page_id}`, body));
    },
  },
  {
    name: "notion_append_content",
    description: "Append Markdown content to the end of a page or block.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: str("Page ID or block ID to append to"),
        content: str("Markdown to append"),
      },
      required: ["block_id", "content"],
    },
    annotations: WRITE,
    async handler(a, n) {
      const blocks = markdownToBlocks(a.content);
      if (!blocks.length) throw new Error("content produced no blocks");
      await appendBlocks(n, a.block_id, blocks);
      return { appended_blocks: blocks.length };
    },
  },
];

/* ------------------------------------------------------------------ */
/* JSON-RPC / MCP                                                      */
/* ------------------------------------------------------------------ */

type Id = string | number | null;
const rpcOk = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(msg: any, env: Env): Promise<unknown | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return rpcErr(msg?.id ?? null, -32600, "Invalid Request");
  }
  if (msg.method === undefined) return null; // a response from client: ignore
  const isNotification = msg.id === undefined;
  const id: Id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return rpcOk(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Notion tools. Pages/databases must be shared with the integration first. Use notion_search to find IDs.",
      });
    }
    case "ping":
      return rpcOk(id, {});
    case "tools/list":
      return rpcOk(id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return rpcErr(id, -32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const data = await tool.handler(msg.params?.arguments ?? {}, new Notion(env));
        const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
        return rpcOk(id, { content: [{ type: "text", text }] });
      } catch (e) {
        return rpcOk(id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return isNotification ? null : rpcErr(id, -32601, `Method not found: ${msg.method}`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP layer                                                          */
/* ------------------------------------------------------------------ */

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Empty list = allow any origin (browser clients work out of the box).
 * Entries are exact origins by default; `*` wildcards are supported,
 * e.g. "https://*.hf.space" or "*".
 */
function originAllowed(origin: string, allow: string[]): boolean {
  if (!allow.length) return true;
  return allow.some((pattern) => {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return pattern === origin;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(origin);
  });
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !originAllowed(origin, allowedOrigins(env))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

function requestPath(url: URL): string {
  let stripped = url.pathname.replace(/^\/\.netlify\/functions\/[^/]+/, "");
  if (stripped === "") stripped = "/";
  if (stripped.length > 1 && stripped.endsWith("/")) stripped = stripped.slice(0, -1);
  return stripped;
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const pathname = requestPath(url);
  const cors = corsHeaders(req, env);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (pathname === "/" || pathname === "/health") {
    return json({ status: "ok", ...SERVER_INFO, endpoint: "/mcp" }, 200, cors);
  }
  if (pathname !== "/mcp") return json({ error: "Not found" }, 404, cors);

  const origin = req.headers.get("Origin");
  const allow = allowedOrigins(env);
  if (origin && !originAllowed(origin, allow)) return json({ error: "Origin not allowed" }, 403);

  if (!env.MCP_AUTH_TOKEN || !env.NOTION_TOKEN) {
    return json({ error: "Server is not configured (missing secrets)" }, 500, cors);
  }

  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const token = bearer || (env.ALLOW_QUERY_TOKEN === "true" ? url.searchParams.get("key") ?? "" : "");
  if (!safeEqual(token, env.MCP_AUTH_TOKEN)) {
    return json({ error: "Unauthorized" }, 401, { ...cors, "WWW-Authenticate": "Bearer" });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcErr(null, -32700, "Parse error"), 400, cors);
  }

  if (Array.isArray(body)) {
    if (!body.length) return json(rpcErr(null, -32600, "Empty batch"), 400, cors);
    const results = (await Promise.all(body.map((m) => handleMessage(m, env)))).filter((r) => r !== null);
    return results.length ? json(results, 200, cors) : new Response(null, { status: 202, headers: cors });
  }

  const result = await handleMessage(body, env);
  return result === null ? new Response(null, { status: 202, headers: cors }) : json(result, 200, cors);
}
