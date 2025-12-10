import { load } from "cheerio";
import { getUserAgent, isPathAllowed, RobotsInfo } from "./robots";

export interface CrawlOptions {
  respectRobots?: boolean;
  maxHtmlChars?: number;
  maxTextChars?: number;
}

export interface CrawlLogEntry {
  url: string;
  status?: number;
  reason?: string;
}

export interface PageSummary {
  url: string;
  title: string | null;
  textContent: string;
  htmlContent: string;
  isTextTruncated: boolean;
  isHtmlTruncated: boolean;
  wordCount: number;
  hasForms: boolean;
  hasSearch: boolean;
  containsLogin: boolean;
}

export interface CrawlResult {
  pages: PageSummary[];
  log: CrawlLogEntry[];
}

const DEFAULT_OPTIONS: Required<CrawlOptions> = {
  respectRobots: true,
  maxHtmlChars: 20000,
  maxTextChars: 12000,
};

export async function crawlSite(
  targetUrl: string,
  robots: RobotsInfo | null,
  options?: CrawlOptions,
): Promise<CrawlResult> {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  const url = new URL(targetUrl);
  const normalizedUrl = normalizeUrl(url);
  const log: CrawlLogEntry[] = [];
  const pages: PageSummary[] = [];

  if (!normalizedUrl) {
    return { pages, log };
  }

  if (merged.respectRobots && robots && !isPathAllowed(url.pathname, robots.rules)) {
    log.push({
      url: normalizedUrl,
      reason: "Skipped (disallowed by robots.txt)",
    });
    return { pages, log };
  }

  try {
    const response = await fetch(normalizedUrl, {
      headers: {
        "User-Agent": getUserAgent(),
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });

    log.push({
      url: normalizedUrl,
      status: response.status,
      reason: "Fetched landing page (single-page snapshot; links not followed)",
    });

    if (!response.ok) {
      return { pages, log };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return { pages, log };
    }

    const html = await response.text();
    const $ = load(html);

    $("script,style,noscript").remove();

    const title = $("title").first().text().trim() || null;
    const body = $("body");

    const bodyHtml = body.html()?.trim() ?? "";
    const htmlContent = truncate(bodyHtml, merged.maxHtmlChars);
    const isHtmlTruncated = bodyHtml.length > htmlContent.length;

    const rawText = body.text().replace(/\s+/g, " ").trim();
    const textContent = truncate(rawText, merged.maxTextChars);
    const isTextTruncated = rawText.length > textContent.length;
    const wordCount = rawText ? rawText.split(/\s+/).length : 0;
    const hasForms = $("form").length > 0;
    const hasSearch = $("form input[type='search']").length > 0;
    const containsLogin =
      hasForms &&
      ($("input[type='password']").length > 0 ||
        /log[\s-]?in/i.test(rawText) ||
        $("form")
          .toArray()
          .some((form) => $(form).attr("id")?.toLowerCase().includes("login")));

    pages.push({
      url: normalizedUrl,
      title,
      textContent,
      htmlContent,
      isTextTruncated,
      isHtmlTruncated,
      wordCount,
      hasForms,
      hasSearch,
      containsLogin,
    });
  } catch (error) {
    log.push({
      url: normalizedUrl,
      reason: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return { pages, log };
}

function normalizeUrl(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  url.hash = "";
  return url.toString();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}
