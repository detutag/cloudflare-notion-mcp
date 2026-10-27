import type { Config } from "@netlify/functions";
import { handleRequest, type Env } from "../../src/index";

function envFromProcess(): Env {
  return {
    NOTION_TOKEN: process.env.NOTION_TOKEN ?? "",
    MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN ?? "",
    NOTION_VERSION: process.env.NOTION_VERSION,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    ALLOW_QUERY_TOKEN: process.env.ALLOW_QUERY_TOKEN,
  };
}

export default async (req: Request) => handleRequest(req, envFromProcess());

export const config: Config = {
  path: ["/health", "/mcp"],
};
