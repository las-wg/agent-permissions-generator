import { NextResponse } from "next/server";
import { crawlSite } from "@/lib/crawl";
import { fetchRobots, getUserAgent } from "@/lib/robots";
import path from "path";
import { promises as fs } from "fs";

interface GenerateRequest {
  url?: string;
  instructions?: string;
  mode?: "static" | "browserless";
}

interface LlmResult {
  model: string;
  raw: string;
  policy: unknown | null;
  error?: string;
}

interface ProcessLogEntry {
  step: string;
  detail?: string;
  elapsedMs: number;
}

interface GenerateResponseBody {
  input: {
    url: string;
    instructions: string;
    mode: string;
  };
  notes: string[];
  existingPolicy: Awaited<ReturnType<typeof fetchExistingPolicy>>;
  llm: LlmResult;
  processLog: ProcessLogEntry[];
  crawlSummary: {
    totalPages: number;
    pagesWithForms: number;
    pagesWithLogins: number;
    robots: {
      present: boolean;
      crawlDelay?: number | null;
    };
  };
  crawlPages: Awaited<ReturnType<typeof crawlSite>>["pages"];
}

const STANDARD_PATH = path.join(process.cwd(), "design", "standard.md");
const standardContentPromise = fs.readFile(STANDARD_PATH, "utf8").catch(() => null);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let payload: GenerateRequest;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload." },
      { status: 400 },
    );
  }

  const wantsStream = new URL(request.url).searchParams.get("stream") === "1";

  if (!process.env.OPENAI_API_KEY) {
    if (wantsStream) {
      const message = "OPENAI_API_KEY is not configured on the server.";
      return new Response(
        `event: error\ndata: ${JSON.stringify({ message })}\n\n`,
        {
          status: 500,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    }
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured on the server." },
      { status: 500 },
    );
  }

  if (!payload.url) {
    return NextResponse.json(
      { error: "Missing required field 'url'." },
      { status: 400 },
    );
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(payload.url);
  } catch {
    return NextResponse.json(
      { error: "URL could not be parsed. Provide a valid absolute URL." },
      { status: 400 },
    );
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    return NextResponse.json(
      { error: "Only HTTP and HTTPS URLs are supported." },
      { status: 400 },
    );
  }

  if (wantsStream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const send = async (event: string, data: unknown) => {
      await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };

    (async () => {
      const logger = createProcessLogger((entry) => send("log", entry));
      try {
        const responseBody = await buildResponse({ targetUrl, payload, logger });
        await send("result", responseBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await send("error", { message });
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  const logger = createProcessLogger();
  const responseBody = await buildResponse({ targetUrl, payload, logger });
  return NextResponse.json(responseBody);
}

function createProcessLogger(emit?: (entry: ProcessLogEntry) => void) {
  const startedAt = Date.now();
  const processLog: ProcessLogEntry[] = [];

  return {
    log: (step: string, detail?: string) => {
      const entry = {
        step,
        detail,
        elapsedMs: Date.now() - startedAt,
      } satisfies ProcessLogEntry;
      processLog.push(entry);
      if (emit) emit(entry);
    },
    entries: processLog,
  };
}

async function buildResponse({
  targetUrl,
  payload,
  logger,
}: {
  targetUrl: URL;
  payload: GenerateRequest;
  logger: ReturnType<typeof createProcessLogger>;
}): Promise<GenerateResponseBody> {
  const instructions = payload.instructions?.slice(0, 2000) ?? "";
  const notes: string[] = [];
  const effectiveMode = payload.mode === "browserless" ? "static" : "static";

  if (payload.mode === "browserless") {
    notes.push(
      "Browserless mode is not yet available in this preview; fell back to static HTTP fetches.",
    );
  }

  const [robots, existingPolicy] = await Promise.all([
    (async () => {
      logger.log("Fetching robots.txt", targetUrl.origin);
      const result = await fetchRobots(targetUrl);
      logger.log("Robots fetched", result ? "Found robots.txt" : "No robots.txt found");
      return result;
    })(),
    (async () => {
      logger.log("Checking for existing agent-permissions.json");
      const result = await fetchExistingPolicy(targetUrl);
      logger.log(
        "Existing policy lookup complete",
        result ? `Status ${result.status ?? "unknown"}` : "None found",
      );
      return result;
    })(),
  ]);

  notes.push("Single-page retrieval enabled; links are not followed during capture.");

  logger.log("Fetching landing page snapshot", targetUrl.toString());
  const crawlResult = await crawlSite(targetUrl.toString(), robots, { respectRobots: true });
  logger.log(
    "Page snapshot complete",
    crawlResult.pages.length
      ? `Captured ${crawlResult.pages[0].wordCount} words`
      : "No HTML content returned",
  );

  const standardContent = await standardContentPromise;
  logger.log(
    "Loaded agent-permissions standard",
    standardContent ? "Local copy loaded" : "Standard missing; continuing without it",
  );
  if (!standardContent) {
    notes.push("Unable to load local agent-permissions standard; proceeding without it.");
  }

  logger.log("Requesting draft policy from OpenAI");
  const llm = await requestPolicyFromOpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    instructions,
    pages: crawlResult.pages,
    standard: standardContent ?? "",
  });
  logger.log("Model response received", llm.error ? llm.error : "Draft policy ready");

  return {
    input: {
      url: targetUrl.toString(),
      instructions,
      mode: effectiveMode,
    },
    notes,
    existingPolicy,
    llm,
    processLog: logger.entries,
    crawlSummary: {
      totalPages: crawlResult.pages.length,
      pagesWithForms: crawlResult.pages.filter((p) => p.hasForms).length,
      pagesWithLogins: crawlResult.pages.filter((p) => p.containsLogin).length,
      robots: robots
        ? {
            present: true,
            crawlDelay: robots.rules.crawlDelay ?? null,
          }
        : { present: false },
    },
    crawlPages: crawlResult.pages,
  } satisfies GenerateResponseBody;
}

async function fetchExistingPolicy(
  targetUrl: URL,
): Promise<
  | {
      url: string;
      status: number;
      body?: unknown;
      raw?: string;
    }
  | null
> {
  const policyUrl = new URL(
    "/.well-known/agent-permissions.json",
    `${targetUrl.protocol}//${targetUrl.host}`,
  );

  try {
    const response = await fetch(policyUrl, {
      headers: { "User-Agent": getUserAgent(), Accept: "application/json" },
    });

    if (!response.ok) {
      return response.status === 404
        ? null
        : {
            url: policyUrl.toString(),
            status: response.status,
          };
    }

    const text = await response.text();
    try {
      return {
        url: policyUrl.toString(),
        status: response.status,
        body: JSON.parse(text),
      };
    } catch {
      return {
        url: policyUrl.toString(),
        status: response.status,
        raw: text,
      };
    }
  } catch {
    return null;
  }
}

async function requestPolicyFromOpenAI({
  apiKey,
  instructions,
  pages,
  standard,
}: {
  apiKey: string;
  instructions: string;
  pages: Awaited<ReturnType<typeof crawlSite>>["pages"];
  standard: string;
}): Promise<LlmResult> {
  const model = "gpt-5-mini";

  const pageSections = pages.slice(0, 1).map((page, index) => {
    const notes: string[] = [];
    if (page.isTextTruncated) {
      notes.push("Plain text truncated to maxTextChars limit.");
    }
    if (page.isHtmlTruncated) {
      notes.push("HTML body truncated to maxHtmlChars limit.");
    }

    return [
      `### Page ${index + 1}: ${page.url}`,
      page.title ? `Title: ${page.title}` : "Title: (none detected)",
      `Word count ~${page.wordCount}`,
      `Forms: ${page.hasForms ? "yes" : "no"} | Login detected: ${page.containsLogin ? "yes" : "no"} | Search input: ${page.hasSearch ? "yes" : "no"}`,
      notes.length ? `Notes: ${notes.join(" ")}` : null,
      `Plain text content:\n${page.textContent}`,
      `Sanitized HTML body (no <script>/<style>):\n${page.htmlContent}`,
    ].join("\n");
  });

  const promptSections = [
    "You are drafting an agent-permissions.json document.",
    "You must output strictly valid JSON with no surrounding commentary or code fences.",
    "Use the schema and semantics described in the provided standard.",
    "",
    "=== Agent Permissions Standard ===",
    standard,
    "",
    "=== User Instructions ===",
    instructions || "(none provided)",
    "",
    "=== Page Snapshots ===",
    pageSections.join("\n\n") || "(crawl returned no pages)",
    "",
    "Generate the recommended agent-permissions.json document, adding page-specific overrides if appropriate.",
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        //temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an expert assistant generating agent-permissions.json files. Follow the provided standard precisely and return only valid JSON.",
          },
          {
            role: "user",
            content: promptSections,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        model,
        raw: errorText,
        policy: null,
        error: `OpenAI API error (${response.status})`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    const policy = parseJsonSafely(raw);

    return {
      model,
      raw,
      policy,
      error: policy ? undefined : "Unable to parse JSON from model output.",
    };
  } catch (error) {
    return {
      model,
      raw: error instanceof Error ? error.message : String(error),
      policy: null,
      error: "Failed to contact OpenAI API.",
    };
  }
}

function parseJsonSafely(raw: string): unknown | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
