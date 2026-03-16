import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createServer } from "./server.js";

interface Env {
	CANLII_API: string;
	MCP_AUTH_TOKEN?: string;
}

type HonoEnv = { Bindings: Env; Variables: { parsedBody?: unknown } };
const app = new Hono<HonoEnv>();

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

app.use("*", async (c, next) => {
	const token = c.env.MCP_AUTH_TOKEN;
	if (token) {
		const header = c.req.header("authorization") ?? "";
		if (header !== `Bearer ${token}`) {
			return c.text("Unauthorized", 401);
		}
	}
	return next();
});

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

app.all("/mcp", async (c) => {
	const server = createServer(c.env.CANLII_API);
	const transport = new WebStandardStreamableHTTPServerTransport();
	await server.connect(transport);
	return transport.handleRequest(c.req.raw, {
		parsedBody: c.get("parsedBody"),
	});
});

export default app;
