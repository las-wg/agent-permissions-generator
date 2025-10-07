"use client";

import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import styles from "./page.module.css";

const PRESET_SNIPPETS = [
  {
    label: "Skip forms",
    text: "The agent MUST NOT fill or submit any forms.",
  },
  {
    label: "Read-only",
    text: "Limit the agent to reading content and following public navigation links only.",
  },
  {
    label: "Respect rate limits",
    text: "The agent SHOULD throttle requests and avoid more than one page fetch per second.",
  },
];

type ExistingPolicy = {
  url: string;
  status: number;
  body?: unknown;
  raw?: string;
} | null;

type CrawlLogEntry = {
  url: string;
  status?: number;
  reason?: string;
};

type CrawlSummary = {
  totalPages: number;
  pagesWithForms: number;
  pagesWithLogins: number;
  robots: {
    present: boolean;
    crawlDelay?: number | null;
  };
};

type CrawlPage = {
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
};

type ApiResponse = {
  input: {
    url: string;
    instructions: string;
    mode: string;
  };
  notes: string[];
  existingPolicy: ExistingPolicy;
  llm: {
    model: string;
    raw: string;
    policy: unknown | null;
    error?: string;
  };
  crawlSummary: CrawlSummary;
  crawlLog: CrawlLogEntry[];
  crawlPages: CrawlPage[];
};

const DEFAULT_MODE: "static" | "browserless" = "static";

export default function Home() {
  const [url, setUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState<"static" | "browserless">(DEFAULT_MODE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          instructions,
          mode,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "Request failed.");
      }

      const payload = (await response.json()) as ApiResponse;
      setResult(payload);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePreset = (snippet: string) => {
    setInstructions((current) =>
      current.includes(snippet)
        ? current
        : current.length > 0
          ? `${current.trim()}\n${snippet}`
          : snippet,
    );
  };

  const hasResults = Boolean(result);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Agent Permissions Playground</p>
        <h1 className={styles.title}>Draft policies for your site in minutes</h1>
        <p className={styles.subtitle}>
          Crawl a few pages, inspect what the bot saw, and get a starter{" "}
          <code>agent-permissions.json</code> you can tweak before publishing.
        </p>
      </header>

      <main className={styles.main}>
        <section className={styles.panel}>
          <form className={styles.form} onSubmit={handleSubmit}>
            <label className={styles.label} htmlFor="site-url">
              Website URL
            </label>
            <input
              id="site-url"
              name="url"
              type="url"
              placeholder="https://example.com"
              required
              className={styles.input}
              value={url}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setUrl(event.currentTarget.value)
              }
            />

            <label className={styles.label} htmlFor="instructions">
              Instructions for the agent
            </label>
            <textarea
              id="instructions"
              name="instructions"
              placeholder="Share any special rules or context..."
              className={styles.textarea}
              rows={6}
              value={instructions}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                setInstructions(event.currentTarget.value)
              }
            />

            <div className={styles.presets}>
              <p className={styles.presetLabel}>Quick additions</p>
              <div className={styles.presetButtons}>
                {PRESET_SNIPPETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={styles.preset}
                    onClick={() => handlePreset(preset.text)}
                    disabled={submitting}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>Crawler mode</legend>
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="mode"
                  value="static"
                  checked={mode === "static"}
                  onChange={() => setMode("static")}
                  disabled={submitting}
                />
                Static HTTP fetch (default)
              </label>
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="mode"
                  value="browserless"
                  checked={mode === "browserless"}
                  onChange={() => setMode("browserless")}
                  disabled={submitting}
                />
                Headless browser (experimental fallback)
              </label>
            </fieldset>

            <button
              className={styles.submit}
              type="submit"
              disabled={submitting}
            >
              {submitting ? "Generating…" : "Generate draft policy"}
            </button>

            {error && <p className={styles.error}>{error}</p>}
          </form>
        </section>

        <section className={styles.panel}>
          {!hasResults && (
            <div className={styles.placeholder}>
              <h2>Results will appear here</h2>
              <p>
                Submit a URL to see crawl highlights, suggested policies, and
                any existing <code>.well-known</code> file we discover.
              </p>
            </div>
          )}

          {result && (
            <div className={styles.resultsStack}>
              <StatusChips summary={result.crawlSummary} notes={result.notes} />
              {result.llm.error && (
                <div className={styles.alert}>
                  <strong>Model warning:</strong> {result.llm.error}
                </div>
              )}
              <JsonCard title="Generated policy" data={result.llm.policy} />
              <JsonCard
                title={`Raw response (${result.llm.model})`}
                data={result.llm.raw}
                emptyMessage="No response from the model."
              />

              <JsonCard
                title="Existing policy on site"
                data={result.existingPolicy?.body ?? result.existingPolicy?.raw ?? null}
                emptyMessage="No existing agent-permissions.json was found."
              />

              <CrawlPagesCard pages={result.crawlPages} />

              <CrawlLog log={result.crawlLog} />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function JsonCard({
  title,
  data,
  emptyMessage = "Nothing to show yet.",
}: {
  title: string;
  data: unknown;
  emptyMessage?: string;
}) {
  const pretty = useMemo(() => {
    if (data === null || data === undefined) return null;
    if (typeof data === "string") {
      return data;
    }
    return JSON.stringify(data, null, 2);
  }, [data]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>{title}</h2>
        {pretty && typeof pretty === "string" && <CopyButton text={pretty} />}
      </div>
      {pretty ? (
        <pre className={styles.code}>{pretty}</pre>
      ) : (
        <p className={styles.muted}>{emptyMessage}</p>
      )}
    </div>
  );
}

function StatusChips({
  summary,
  notes,
}: {
  summary: CrawlSummary;
  notes: string[];
}) {
  return (
    <div className={styles.statusRow}>
      <span className={styles.tag}>
        {summary.totalPages} page{summary.totalPages === 1 ? "" : "s"} crawled
      </span>
      {summary.pagesWithForms > 0 && (
        <span className={styles.tag}>
          {summary.pagesWithForms} page
          {summary.pagesWithForms === 1 ? "" : "s"} with forms
        </span>
      )}
      {summary.robots.present ? (
        <span className={styles.tag}>
          robots.txt found
          {typeof summary.robots.crawlDelay === "number"
            ? ` (crawl-delay ${summary.robots.crawlDelay}s)`
            : ""}
        </span>
      ) : (
        <span className={styles.tag}>robots.txt missing</span>
      )}

      {notes.map((note) => (
        <span key={note} className={styles.tagNote}>
          {note}
        </span>
      ))}
    </div>
  );
}

function CrawlLog({ log }: { log: CrawlLogEntry[] }) {
  if (!log.length) {
    return null;
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>Crawl log</h2>
      </div>
      <ul className={styles.logList}>
        {log.map((entry) => (
          <li key={entry.url} className={styles.logItem}>
            <span className={styles.logUrl}>{entry.url}</span>
            {typeof entry.status === "number" ? (
              <span className={styles.statusBadge}>{entry.status}</span>
            ) : null}
            {entry.reason ? (
              <span className={styles.logReason}>{entry.reason}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CrawlPagesCard({ pages }: { pages: CrawlPage[] }) {
  if (!pages.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>Pages crawled</h2>
        </div>
        <p className={styles.muted}>The crawler could not fetch any content.</p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>Pages crawled</h2>
      </div>
      <div className={styles.pageList}>
        {pages.map((page) => (
          <div key={page.url} className={styles.pageItem}>
            <div className={styles.pageHeading}>
              <span className={styles.pageUrl}>{page.url}</span>
              {page.title && <span className={styles.pageTitle}>{page.title}</span>}
            </div>
            <div className={styles.pageMeta}>
              <span>{page.wordCount} words</span>
              {page.hasForms && <span>Form detected</span>}
              {page.containsLogin && <span>Login flow</span>}
              {page.hasSearch && <span>Search input</span>}
            </div>
            {(page.isTextTruncated || page.isHtmlTruncated) && (
              <p className={styles.pageNote}>
                {[
                  page.isTextTruncated ? "Plain text truncated for length." : null,
                  page.isHtmlTruncated ? "HTML body truncated for length." : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
              </p>
            )}
            <details className={styles.pageDetails}>
              <summary>View plain text</summary>
              <p className={styles.pageText}>{page.textContent}</p>
            </details>
            <details className={styles.pageDetails}>
              <summary>View sanitized HTML</summary>
              <pre className={styles.pageCode}>{page.htmlContent}</pre>
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className={styles.copyButton}
      onClick={handleClick}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}
