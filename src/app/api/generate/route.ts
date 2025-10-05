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

  if (!process.env.OPENAI_API_KEY) {
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

  const instructions = payload.instructions?.slice(0, 2000) ?? "";
  const notes: string[] = [];
  const effectiveMode = payload.mode === "browserless" ? "static" : "static";

  if (payload.mode === "browserless") {
    notes.push(
      "Browserless mode is not yet available in this preview; fell back to static HTTP fetches.",
    );
  }

  const [robots, existingPolicy] = await Promise.all([
    fetchRobots(targetUrl),
    fetchExistingPolicy(targetUrl),
  ]);

  const crawlResult = await crawlSite(targetUrl.toString(), robots, {
    respectRobots: true,
  });

  const standardContent = await standardContentPromise;
  if (!standardContent) {
    notes.push("Unable to load local agent-permissions standard; proceeding without it.");
  }

  const llm = await requestPolicyFromOpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    instructions,
    pages: crawlResult.pages,
    standard: standardContent ?? "",
  });

  const responseBody = {
    input: {
      url: targetUrl.toString(),
      instructions,
      mode: effectiveMode,
    },
    notes,
    existingPolicy,
    llm,
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
    crawlLog: crawlResult.log,
    crawlPages: crawlResult.pages,
  };

  return NextResponse.json(responseBody);
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
