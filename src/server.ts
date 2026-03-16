import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Rate limiter — 2 req/s, 1 concurrent, 5 000/day
// ---------------------------------------------------------------------------

let dailyCount = 0;
let dailyResetDate = new Date().toDateString();
let lastRequestTime = 0;
let inFlight = false;
const queue: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

function resetDailyIfNeeded() {
	const today = new Date().toDateString();
	if (today !== dailyResetDate) {
		dailyCount = 0;
		dailyResetDate = today;
	}
}

async function acquireSlot(): Promise<void> {
	resetDailyIfNeeded();
	if (dailyCount >= 5000) {
		throw new Error("CanLII daily API limit (5 000 requests) reached");
	}
	if (inFlight) {
		await new Promise<void>((resolve, reject) => queue.push({ reject, resolve }));
	}
	inFlight = true;
	const now = Date.now();
	const wait = Math.max(0, 500 - (now - lastRequestTime));
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastRequestTime = Date.now();
	dailyCount++;
}

function releaseSlot() {
	inFlight = false;
	const next = queue.shift();
	if (next) next.resolve();
}

// ---------------------------------------------------------------------------
// CanLII HTTP helper
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.canlii.org/v1";

async function canliiRequest(
	apiKey: string,
	path: string,
	params: Record<string, string> = {},
): Promise<unknown> {
	await acquireSlot();
	try {
		const url = new URL(`${BASE_URL}${path}`);
		url.searchParams.set("api_key", apiKey);
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== "") url.searchParams.set(k, v);
		}
		const res = await fetch(url.toString());
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`CanLII API ${res.status}: ${body}`);
		}
		return await res.json();
	} finally {
		releaseSlot();
	}
}

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function ok(data: unknown): ToolResult {
	return { content: [{ text: JSON.stringify(data, null, 2), type: "text" }] };
}

function err(message: string): ToolResult {
	return { content: [{ text: message, type: "text" }], isError: true };
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

export function createServer(apiKey: string): McpServer {
	const server = new McpServer({
		name: "canlii",
		version: "1.0.0",
	});

	const request = (path: string, params?: Record<string, string>) =>
		canliiRequest(apiKey, path, params);

	// 1. List case databases
	server.registerTool(
		"list_case_databases",
		{
			annotations: { readOnlyHint: true },
			description:
				"List all courts and tribunals in the CanLII collection with their database IDs.",
			inputSchema: {
				language: z.enum(["en", "fr"]).default("en").describe("Response language"),
			},
			title: "List Case Databases",
		},
		async ({ language }) => {
			try {
				return ok(await request(`/caseBrowse/${language}/`));
			} catch (e) {
				return err(String(e));
			}
		},
	);

	// 2. List cases
	server.registerTool(
		"list_cases",
		{
			annotations: { readOnlyHint: true },
			description:
				"List decisions from a specific caselaw database. Returns case titles, citations, and IDs.",
			inputSchema: {
				databaseId: z
					.string()
					.describe('Database ID from list_case_databases (e.g. "onca", "csc-scc")'),
				decisionDateAfter: z
					.string()
					.optional()
					.describe("Filter: decision date after (YYYY-MM-DD)"),
				decisionDateBefore: z
					.string()
					.optional()
					.describe("Filter: decision date before (YYYY-MM-DD)"),
				language: z.enum(["en", "fr"]).default("en").describe("Response language"),
				offset: z.number().int().min(0).default(0).describe("Starting record index"),
				publishedAfter: z
					.string()
					.optional()
					.describe("Filter: published on CanLII after this date (YYYY-MM-DD)"),
				publishedBefore: z
					.string()
					.optional()
					.describe("Filter: published on CanLII before this date (YYYY-MM-DD)"),
				resultCount: z
					.number()
					.int()
					.min(1)
					.max(10000)
					.default(25)
					.describe("Number of results to return (max 10000)"),
			},
			title: "List Cases",
		},
		async ({
			language,
			databaseId,
			offset,
			resultCount,
			publishedBefore,
			publishedAfter,
			decisionDateBefore,
			decisionDateAfter,
		}) => {
			try {
				const params: Record<string, string> = {
					offset: String(offset),
					resultCount: String(resultCount),
				};
				if (publishedBefore) params.publishedBefore = publishedBefore;
				if (publishedAfter) params.publishedAfter = publishedAfter;
				if (decisionDateBefore) params.decisionDateBefore = decisionDateBefore;
				if (decisionDateAfter) params.decisionDateAfter = decisionDateAfter;
				return ok(await request(`/caseBrowse/${language}/${databaseId}/`, params));
			} catch (e) {
				return err(String(e));
			}
		},
	);

	// 3. Get case metadata
	server.registerTool(
		"get_case",
		{
			annotations: { readOnlyHint: true },
			description:
				"Get metadata for a specific case including title, citation, decision date, keywords, and URL.",
			inputSchema: {
				caseId: z.string().describe('Case ID from list_cases (e.g. "2008scc9")'),
				databaseId: z.string().describe('Database ID (e.g. "csc-scc")'),
				language: z.enum(["en", "fr"]).default("en").describe("Response language"),
			},
			title: "Get Case",
		},
		async ({ language, databaseId, caseId }) => {
			try {
				return ok(await request(`/caseBrowse/${language}/${databaseId}/${caseId}/`));
			} catch (e) {
				return err(String(e));
			}
		},
	);

	// 4. Case citator
	server.registerTool(
		"get_case_citations",
		{
			annotations: { readOnlyHint: true },
			description:
				"Get citation information for a case: what it cites, what cites it, or what legislation it references. Note: the CanLII API currently only supports English for this endpoint; French requests will fall back to English.",
			inputSchema: {
				caseId: z.string().describe('Case ID (e.g. "1999canlii1527")'),
				citationType: z
					.enum(["citedCases", "citingCases", "citedLegislations"])
					.describe("Type of citation data to retrieve"),
				databaseId: z.string().describe('Database ID (e.g. "onca")'),
				language: z
					.enum(["en", "fr"])
					.default("en")
					.describe("Response language (currently only 'en' is supported by the API)"),
			},
			title: "Get Case Citations",
		},
		async ({ databaseId, caseId, citationType }) => {
			try {
				return ok(await request(`/caseCitator/en/${databaseId}/${caseId}/${citationType}`));
			} catch (e) {
				return err(String(e));
			}
		},
	);

	// 5. List legislation databases
	server.registerTool(
		"list_legislation_databases",
		{
			annotations: { readOnlyHint: true },
			description: "List all legislation and regulation databases in the CanLII collection.",
			inputSchema: {
				language: z.enum(["en", "fr"]).default("en").describe("Response language"),
			},
			title: "List Legislation Databases",
		},
		async ({ language }) => {
			try {
				return ok(await request(`/legislationBrowse/${language}/`));
			} catch (e) {
				return err(String(e));
			}
		},
	);

	// 6. List legislation
	server.registerTool(
		"list_legislation",
		{
			annotations: { readOnlyHint: true },
			description: "List statutes or regulations from a specific legislation database.",
			inputSchema: {
				databaseId: z
					.string()
					.describe(
						'Legislation database ID from list_legislation_databases (e.g. "ons" for Ontario statutes)',
					),
				language: z.enum(["en", "fr"]).default("en").describe("Response language"),
			},
			title: "List Legislation",
		},
		async ({ language, databaseId }) => {
			try {
				return ok(await request(`/legislationBrowse/${language}/${databaseId}/`));
			} catch (e) {
				return err(String(e));
			}
		},
	);

	// 7. Get legislation metadata
	server.registerTool(
		"get_legislation",
		{
			annotations: { readOnlyHint: true },
			description:
				"Get metadata for a specific piece of legislation including title, citation, dates, and repeal status.",
			inputSchema: {
				databaseId: z.string().describe("Legislation database ID"),
				language: z.enum(["en", "fr"]).default("en").describe("Response language"),
				legislationId: z
					.string()
					.describe('Legislation ID from list_legislation (e.g. "rso-1990-c-a1")'),
			},
			title: "Get Legislation",
		},
		async ({ language, databaseId, legislationId }) => {
			try {
				return ok(await request(`/legislationBrowse/${language}/${databaseId}/${legislationId}/`));
			} catch (e) {
				return err(String(e));
			}
		},
	);

	return server;
}
