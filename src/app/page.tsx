"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
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

type ProcessLogEntry = {
  step: string;
  detail?: string;
  elapsedMs: number;
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
  processLog: ProcessLogEntry[];
  crawlSummary: CrawlSummary;
  crawlPages: CrawlPage[];
};

type QuickBuilderState = {
  siteName: string;
  allowReadContent: boolean;
  allowReadMetadata: boolean;
  allowNavigation: boolean;
  allowForms: boolean;
  requireHumanForForms: boolean;
  blockLogin: boolean;
  rateLimit: "gentle" | "standard" | "open";
  allowDownloads: boolean;
};

type ParsedPolicy = {
  error?: string;
  metadata?: {
    schema_version?: string;
    last_updated?: string;
    author?: string;
  };
  resourceRules: Array<{
    verb: string;
    selector: string;
    allowed: boolean;
    modifiers?: {
      burst?: number;
      rate_limit?: { max_requests?: number; window_seconds?: number };
      time_window?: string;
      human_in_the_loop?: boolean;
    };
  }>;
  actionGuidelines: Array<{
    directive: string;
    description: string;
    exceptions?: string;
  }>;
};

type TabKey = "quick" | "generator" | "parser";

const DEFAULT_QUICK_STATE: QuickBuilderState = {
  siteName: "",
  allowReadContent: true,
  allowReadMetadata: true,
  allowNavigation: true,
  allowForms: true,
  requireHumanForForms: false,
  blockLogin: false,
  rateLimit: "open",
  allowDownloads: true,
};

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabKey>("quick");
  const [themePref, setThemePref] = useState<"light" | "dark">("light");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
  const [url, setUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [processLog, setProcessLog] = useState<ProcessLogEntry[]>([]);
  const [quickState, setQuickState] = useState<QuickBuilderState>(DEFAULT_QUICK_STATE);
  const [parserInput, setParserInput] = useState<string>(`{
  "metadata": {
    "schema_version": "1.0.0",
    "last_updated": "2025-01-01T00:00:00Z",
    "author": "Example Corp"
  },
  "resource_rules": [
    {
      "verb": "read_content",
      "selector": "*",
      "allowed": true
    },
    {
      "verb": "follow_link",
      "selector": "nav a, main a",
      "allowed": true
    }
  ],
  "action_guidelines": [
    {
      "directive": "MUST NOT",
      "description": "Submit credentials or attempt to log in."
    }
  ]
}`);

  const quickPolicy = useMemo(() => buildQuickPolicy(quickState), [quickState]);
  const parsedPolicy = useMemo(() => parsePolicy(parserInput), [parserInput]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setThemePref(media.matches ? "dark" : "light");
    setResolvedTheme(media.matches ? "dark" : "light");
  }, []);

  useEffect(() => {
    setResolvedTheme(themePref);
  }, [themePref]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    setProcessLog([{ step: "Submitting request", detail: url, elapsedMs: 0 }]);

    const started = Date.now();

    try {
      const response = await fetch("/api/generate?stream=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          instructions,
          mode: "static",
        }),
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Request failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const flushChunk = (chunk: string) => {
        const parts = chunk.split("\n").filter(Boolean);
        if (!parts.length) return;
        const eventLine = parts.find((line) => line.startsWith("event:"));
        const dataLine = parts.find((line) => line.startsWith("data:"));
        const eventType = eventLine ? eventLine.replace("event:", "").trim() : "message";
        const dataRaw = dataLine ? dataLine.replace("data:", "").trim() : "";

        let parsed: unknown = null;
        if (dataRaw) {
          try {
            parsed = JSON.parse(dataRaw);
          } catch {
            parsed = null;
          }
        }

        if (eventType === "log" && parsed && typeof parsed === "object") {
          setProcessLog((prev) => [...prev, parsed as ProcessLogEntry]);
        } else if (eventType === "result" && parsed) {
          const payload = parsed as ApiResponse;
          setResult(payload);
          setProcessLog(payload.processLog ?? []);
        } else if (eventType === "error") {
          const message = (parsed as { message?: string } | null)?.message ?? "Request failed.";
          throw new Error(message);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            flushChunk(buffer);
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary);
          flushChunk(chunk);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      setResult(null);
      setProcessLog((prev) => [
        ...prev,
        {
          step: "Request failed",
          detail: err instanceof Error ? err.message : "Unknown error",
          elapsedMs: Date.now() - started,
        },
      ]);
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
  const activeTimeline = result?.processLog?.length ? result.processLog : processLog;

  return (
    <div
      className={`${styles.page} ${
        resolvedTheme === "dark" ? styles.darkMode : styles.lightMode
      }`}
    >
      <div className={styles.topBar}>
        <div className={styles.themeToggle}>
          <span>Theme</span>
          <button
            type="button"
            className={`${styles.pill} ${themePref === "light" ? styles.pillActive : ""}`}
            onClick={() => setThemePref("light")}
          >
            Light
          </button>
          <button
            type="button"
            className={`${styles.pill} ${themePref === "dark" ? styles.pillActive : ""}`}
            onClick={() => setThemePref("dark")}
          >
            Dark
          </button>
        </div>
      </div>
      <header className={styles.header}>
        <h1 className={styles.title}>agent-permissions.json Tools</h1>
        <p className={styles.subtitle}>
          Build a policy from presets, generate one for a specific page, or paste JSON to see a human-friendly explanation.
        </p>
      </header>

      <div className={styles.tabRow}>
        <TabButton
          label="Quick builder"
          active={activeTab === "quick"}
          onClick={() => setActiveTab("quick")}
        />
        <TabButton
          label="Generator"
          active={activeTab === "generator"}
          onClick={() => setActiveTab("generator")}
        />
        <TabButton
          label="Parser / explainer"
          active={activeTab === "parser"}
          onClick={() => setActiveTab("parser")}
        />
      </div>

      {activeTab === "quick" && (
        <div className={styles.splitPanel}>
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <h2>Quick agent-permissions builder</h2>
            </div>

            <label className={styles.label} htmlFor="site-name">
              Site or org name (optional)
            </label>
            <input
              id="site-name"
              name="site-name"
              className={styles.input}
              placeholder="Acme Inc"
              value={quickState.siteName}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setQuickState((prev) => ({ ...prev, siteName: event.currentTarget.value }))
              }
            />

            <div className={styles.toggleGroup}>
              <QuickToggle
                label="Allow reading page content"
                description="Let agents read visible text on the captured page."
                checked={quickState.allowReadContent}
                onChange={(value) => setQuickState((prev) => ({ ...prev, allowReadContent: value }))}
              />
              <QuickToggle
                label="Allow reading metadata"
                description="Permit reading titles, meta tags, and structured data."
                checked={quickState.allowReadMetadata}
                onChange={(value) =>
                  setQuickState((prev) => ({ ...prev, allowReadMetadata: value }))
                }
              />
            </div>

            <QuickToggle
              label="Allow navigation between links"
              description="Let agents follow standard navigation links inside the page context."
              checked={quickState.allowNavigation}
              onChange={(value) => setQuickState((prev) => ({ ...prev, allowNavigation: value }))}
            />

            <div className={styles.toggleGroup}>
              <QuickToggle
                label="Allow form filling & submission"
                description="Permit inputs and form submits on the captured page."
                checked={quickState.allowForms}
                onChange={(value) => setQuickState((prev) => ({ ...prev, allowForms: value }))}
              />
              <QuickToggle
                label="Require human confirmation for forms"
                description="Keep forms human-in-the-loop to avoid accidental submissions."
                checked={quickState.requireHumanForForms}
                onChange={(value) =>
                  setQuickState((prev) => ({ ...prev, requireHumanForForms: value }))
                }
                disabled={!quickState.allowForms}
              />
            </div>

            <QuickToggle
              label="Block login or credential flows"
              description="Adds a MUST NOT guideline that forbids authentication attempts."
              checked={quickState.blockLogin}
              onChange={(value) => setQuickState((prev) => ({ ...prev, blockLogin: value }))}
            />

            <QuickToggle
              label="Allow file downloads"
              description="If disabled, downloads stay blocked by default."
              checked={quickState.allowDownloads}
              onChange={(value) => setQuickState((prev) => ({ ...prev, allowDownloads: value }))}
            />

            <div className={styles.rateLimitBlock}>
              <p className={styles.label}>Navigation throttle</p>
              <div className={styles.pillRow}>
                <button
                  type="button"
                  className={`${styles.pill} ${quickState.rateLimit === "gentle" ? styles.pillActive : ""}`}
                  onClick={() => setQuickState((prev) => ({ ...prev, rateLimit: "gentle" }))}
                >
                  Gentle (1 req/sec)
                </button>
                <button
                  type="button"
                  className={`${styles.pill} ${quickState.rateLimit === "standard" ? styles.pillActive : ""}`}
                  onClick={() => setQuickState((prev) => ({ ...prev, rateLimit: "standard" }))}
                >
                  Standard (5 req / 10s)
                </button>
                <button
                  type="button"
                  className={`${styles.pill} ${quickState.rateLimit === "open" ? styles.pillActive : ""}`}
                  onClick={() => setQuickState((prev) => ({ ...prev, rateLimit: "open" }))}
                >
                  No throttle
                </button>
              </div>
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.cardHeader}>
              <h2>agent-permissions.json preview</h2>
              <CopyButton text={quickPolicy} />
            </div>
            <pre className={styles.code}>{quickPolicy}</pre>
          </section>
        </div>
      )}

      {activeTab === "generator" && (
        <div className={styles.splitPanel}>
          <section className={styles.panel}>
            <form className={styles.form} onSubmit={handleSubmit}>
              <div className={styles.panelHeading}>
                <h2>Generator</h2>
              </div>

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
                onChange={(event: ChangeEvent<HTMLInputElement>) => setUrl(event.currentTarget.value)}
              />

              <label className={styles.label} htmlFor="instructions">
                Instructions for the agent
              </label>
              <textarea
                id="instructions"
                name="instructions"
                placeholder="Add any special rules or context..."
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

              <button className={styles.submit} type="submit" disabled={submitting}>
                {submitting ? "Generating…" : "Generate draft policy"}
              </button>

              {error && <p className={styles.error}>{error}</p>}
            </form>
          </section>

          <section className={styles.panel}>
            {activeTimeline.length > 0 && <ProcessTimeline log={activeTimeline} loading={submitting} />}

            {!hasResults && (
              <div className={styles.placeholder}>
                <h2>Results will appear here</h2>
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
              </div>
            )}
          </section>
        </div>
      )}

      {activeTab === "parser" && (
        <div className={styles.splitPanel}>
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <h2>Parse any agent-permissions.json</h2>
            </div>
            <textarea
              className={styles.textarea}
              rows={18}
              value={parserInput}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setParserInput(event.currentTarget.value)}
            />
          </section>
          <section className={styles.panel}>
            <ParserSummary parsed={parsedPolicy} />
          </section>
        </div>
      )}
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.tabButton} ${active ? styles.tabButtonActive : ""}`}
    >
      {label}
    </button>
  );
}

function QuickToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`${styles.quickToggle} ${disabled ? styles.quickToggleDisabled : ""}`}>
      <div>
        <div className={styles.quickToggleLabel}>{label}</div>
        <div className={styles.quickToggleDescription}>{description}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        disabled={disabled}
      />
    </label>
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
        {summary.totalPages} page snapshot
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

function CrawlPagesCard({ pages }: { pages: CrawlPage[] }) {
  if (!pages.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>Page snapshot</h2>
        </div>
        <p className={styles.muted}>The fetcher could not retrieve the landing page content.</p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>Page snapshot</h2>
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
    <button type="button" className={styles.copyButton} onClick={handleClick}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function ProcessTimeline({ log, loading }: { log: ProcessLogEntry[]; loading?: boolean }) {
  if (!log.length) return null;

  return (
    <div className={styles.timeline}>
      <div className={styles.cardHeader}>
        <h2>Run log</h2>
        {loading && <span className={styles.tag}>Running…</span>}
      </div>
      <ul className={styles.timelineList}>
        {log.map((entry, index) => (
          <li key={`${entry.step}-${index}`} className={styles.timelineItem}>
            <div className={styles.timelineMain}>{entry.step}</div>
            {entry.detail && <div className={styles.timelineDetail}>{entry.detail}</div>}
            <span className={styles.timelineTime}>{formatMs(entry.elapsedMs)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ParserSummary({ parsed }: { parsed: ParsedPolicy }) {
  if (parsed.error) {
    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>Explanation</h2>
        </div>
        <p className={styles.error}>Could not parse JSON: {parsed.error}</p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>Explanation</h2>
      </div>
      {parsed.metadata ? (
        <div className={styles.metaRow}>
          <span className={styles.tag}>Schema {parsed.metadata.schema_version ?? "?"}</span>
          {parsed.metadata.last_updated && (
            <span className={styles.tagNote}>
              Updated {formatDate(parsed.metadata.last_updated)}
            </span>
          )}
          {parsed.metadata.author && <span className={styles.tagNote}>Author {parsed.metadata.author}</span>}
        </div>
      ) : (
        <p className={styles.muted}>No metadata found.</p>
      )}

      <div className={styles.parserSection}>
        <h3>Resource rules</h3>
        {parsed.resourceRules.length === 0 && <p className={styles.muted}>None present.</p>}
        <ul className={styles.summaryList}>
          {parsed.resourceRules.map((rule, index) => (
            <li key={`${rule.verb}-${rule.selector}-${index}`}>
              <strong>{formatVerb(rule.verb)}</strong> on <code>{rule.selector}</code> →{" "}
              {rule.allowed ? "allowed" : "blocked"}
              {rule.modifiers?.rate_limit
                ? ` · rate limit ${rule.modifiers.rate_limit.max_requests ?? "?"}/${rule.modifiers.rate_limit.window_seconds ?? "?"}s`
                : ""}
              {rule.modifiers?.human_in_the_loop ? " · human confirmation" : ""}
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.parserSection}>
        <h3>Action guidelines</h3>
        {parsed.actionGuidelines.length === 0 && <p className={styles.muted}>None present.</p>}
        <ul className={styles.summaryList}>
          {parsed.actionGuidelines.map((item, index) => (
            <li key={`${item.directive}-${index}`}>
              <strong>{item.directive}</strong>: {item.description}
              {item.exceptions ? ` (Except: ${item.exceptions})` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function buildQuickPolicy(state: QuickBuilderState): string {
  const now = new Date().toISOString();
  const rules = [
    { verb: "read_content", selector: "*", allowed: state.allowReadContent },
    { verb: "read_metadata", selector: "*", allowed: state.allowReadMetadata },
    {
      verb: "follow_link",
      selector: "*",
      allowed: state.allowNavigation,
      modifiers: state.allowNavigation ? buildRateLimit(state.rateLimit) : undefined,
    },
    {
      verb: "set_input_value",
      selector: "form input, form textarea, form select, form option, form button",
      allowed: state.allowForms,
      modifiers: state.allowForms && state.requireHumanForForms ? { human_in_the_loop: true } : undefined,
    },
    {
      verb: "submit_form",
      selector: "form",
      allowed: state.allowForms,
      modifiers: state.allowForms && state.requireHumanForForms ? { human_in_the_loop: true } : undefined,
    },
    { verb: "execute_script", selector: "*", allowed: false },
    { verb: "upload_file", selector: "input[type='file']", allowed: false },
    {
      verb: "download_file",
      selector: state.allowDownloads ? "*" : "a[download], [role='button']",
      allowed: state.allowDownloads,
    },
  ];

  const guidelines = [
    state.blockLogin
      ? {
          directive: "MUST NOT",
          description: "Attempt to log in or submit credentials, MFA codes, or session tokens.",
        }
      : null,
    state.allowForms
      ? {
          directive: state.requireHumanForForms ? "SHOULD" : "SHOULD",
          description: state.requireHumanForForms
            ? "Confirm with a human before submitting forms or irreversible actions."
            : "Keep form submissions minimal and avoid sensitive personal data.",
        }
      : null,
    state.rateLimit === "gentle"
      ? {
          directive: "SHOULD",
          description: "Throttle navigation to roughly one request per second.",
        }
      : null,
    state.rateLimit === "standard"
      ? {
          directive: "SHOULD",
          description: "Stay within ~5 requests every 10 seconds to reduce load.",
        }
      : null,
  ].filter(Boolean) as ParsedPolicy["actionGuidelines"];

  const policy = {
    metadata: {
      schema_version: "1.0.0",
      last_updated: now,
      ...(state.siteName.trim() ? { author: state.siteName.trim() } : {}),
    },
    resource_rules: rules.map((rule) => {
      const cleaned = { ...rule } as typeof rule & { modifiers?: typeof rule["modifiers"] };
      if (!cleaned.modifiers) delete cleaned.modifiers;
      return cleaned;
    }),
    action_guidelines: guidelines,
  };

  return JSON.stringify(policy, null, 2);
}

function buildRateLimit(rateLimit: QuickBuilderState["rateLimit"]) {
  if (rateLimit === "open") return undefined;
  if (rateLimit === "standard") {
    return {
      rate_limit: {
        max_requests: 5,
        window_seconds: 10,
      },
    };
  }

  return {
    rate_limit: {
      max_requests: 1,
      window_seconds: 1,
    },
  };
}

function parsePolicy(raw: string): ParsedPolicy {
  if (!raw.trim()) {
    return { resourceRules: [], actionGuidelines: [] };
  }

  try {
    const data = JSON.parse(raw);
    const metadata = typeof data.metadata === "object" && data.metadata ? data.metadata : undefined;

    const resourceRuleCandidates = Array.isArray(data.resource_rules) ? (data.resource_rules as unknown[]) : [];
    const resourceRules = resourceRuleCandidates
      .filter(
        (rule): rule is { verb: string; selector: string; allowed: boolean; modifiers?: ParsedPolicy["resourceRules"][number]["modifiers"] } =>
          Boolean(
            rule &&
              typeof (rule as { verb?: unknown }).verb === "string" &&
              typeof (rule as { selector?: unknown }).selector === "string" &&
              typeof (rule as { allowed?: unknown }).allowed === "boolean",
          ),
      )
      .map((rule) => ({
        verb: rule.verb,
        selector: rule.selector,
        allowed: rule.allowed,
        modifiers: rule.modifiers,
      }));

    const actionGuidelineCandidates = Array.isArray(data.action_guidelines)
      ? (data.action_guidelines as unknown[])
      : [];
    const actionGuidelines = actionGuidelineCandidates
      .filter(
        (item): item is { directive: string; description: string; exceptions?: string } =>
          Boolean(
            item &&
              typeof (item as { directive?: unknown }).directive === "string" &&
              typeof (item as { description?: unknown }).description === "string",
          ),
      )
      .map((item) => ({
        directive: item.directive,
        description: item.description,
        exceptions: item.exceptions,
      }));

    return {
      metadata,
      resourceRules,
      actionGuidelines,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to parse JSON.",
      resourceRules: [],
      actionGuidelines: [],
    };
  }
}

function formatVerb(verb: string) {
  const labels: Record<string, string> = {
    all: "All actions",
    read_content: "Read content",
    read_metadata: "Read metadata",
    follow_link: "Follow links",
    click_element: "Click elements",
    scroll_page: "Scroll page",
    set_input_value: "Fill inputs",
    submit_form: "Submit forms",
    execute_script: "Execute script",
    play_media: "Play media",
    pause_media: "Pause media",
    mute_media: "Mute media",
    unmute_media: "Unmute media",
    upload_file: "Upload files",
    download_file: "Download files",
    copy_to_clipboard: "Copy to clipboard",
  };

  if (labels[verb]) return labels[verb];
  const spaced = verb.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatDate(raw: string) {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatMs(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.round(seconds / 60)} min`;
}
