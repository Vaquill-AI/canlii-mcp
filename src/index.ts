#!/usr/bin/env node
import "dotenv/config";
import { serve } from "@hono/node-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createServer } from "./server.js";

// Server-side fallback key. Optional in HTTP mode (BYOK), required for stdio.
const API_KEY = process.env.CANLII_API ?? "";

const transportArg = process.argv.includes("--transport")
	? process.argv[process.argv.indexOf("--transport") + 1]
	: "stdio";

async function main() {
	if (transportArg === "stdio") {
		if (!API_KEY) {
			console.error(
				"CANLII_API environment variable is required for stdio transport",
			);
			process.exit(1);
		}
		const server = createServer(API_KEY);
		const transport = new StdioServerTransport();
		await server.connect(transport);
		console.error("CanLII MCP server running on stdio");
	} else if (transportArg === "http") {
		const authToken = process.env.MCP_AUTH_TOKEN ?? "";
		if (!authToken) {
			console.warn(
				"WARNING: MCP_AUTH_TOKEN is not set — HTTP server is running without authentication",
			);
		}

		type Env = { Variables: { parsedBody?: unknown } };
		const app = new Hono<Env>();

		app.use(
			"*",
			cors({
				allowHeaders: [
					"Authorization",
					"Content-Type",
					"mcp-session-id",
					"Last-Event-ID",
					"mcp-protocol-version",
				],
				allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
				exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
				origin: "*",
			}),
		);

		if (authToken) {
			app.use("*", async (c, next) => {
				const header = c.req.header("authorization") ?? "";
				if (header !== `Bearer ${authToken}`) {
					return c.text("Unauthorized", 401);
				}
				return next();
			});
		}

		app.use("*", async (c, next) => {
			const ct = c.req.header("content-type") ?? "";
			if (ct.includes("application/json")) {
				try {
					const parsed = await c.req.raw.clone().json();
					c.set("parsedBody", parsed);
				} catch {
					return c.text("Invalid JSON", 400);
				}
			}
			return next();
		});

		// Lightweight liveness probe (Dokploy/Docker healthcheck).
		app.get("/health", (c) =>
			c.json({ status: "healthy", service: "canlii-mcp" }),
		);

		app.all("/mcp", async (c) => {
			// BYOK: prefer client-supplied CanLII key from request header,
			// fall back to server env. This lets the hosted MCP charge calls
			// against the caller's CanLII quota instead of the operator's.
			const userKey = c.req.header("x-canlii-token")?.trim();
			const effectiveKey = userKey || API_KEY;
			if (!effectiveKey) {
				return c.json(
					{
						error:
							"No CanLII API key. Send 'X-CanLII-Token: <key>' on every MCP request, or set CANLII_API on the server.",
					},
					401,
				);
			}
			const server = createServer(effectiveKey);
			const transport = new WebStandardStreamableHTTPServerTransport();
			await server.connect(transport);
			return transport.handleRequest(c.req.raw, {
				parsedBody: c.get("parsedBody"),
			});
		});

		const port = Number(process.env.PORT ?? 3000);
		serve({ fetch: app.fetch, port }, () => {
			console.error(`CanLII MCP server running on http://localhost:${port}/mcp`);
		});
	} else {
		console.error(`Unknown transport: ${transportArg}. Use "stdio" or "http".`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
