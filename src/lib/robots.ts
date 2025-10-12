const DEFAULT_USER_AGENT = "AgentPermissionsPreviewBot/0.1";

export interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelay?: number;
}

export interface RobotsInfo {
  raw: string;
  rules: RobotsRules;
}

export function getUserAgent() {
  return DEFAULT_USER_AGENT;
}

export async function fetchRobots(
  origin: URL,
): Promise<RobotsInfo | null> {
  const robotsUrl = new URL("/robots.txt", origin.origin);
  try {
    const response = await fetch(robotsUrl, {
      headers: { "User-Agent": getUserAgent() },
    });
    if (!response.ok || response.status === 404) {
      return null;
    }
    const raw = await response.text();
    return {
      raw,
      rules: parseRobots(raw),
    };
  } catch {
    return null;
  }
}

export function parseRobots(content: string): RobotsRules {
  const rules: RobotsRules = {
    disallow: [],
    allow: [],
  };
  const lines = content.split(/\r?\n/);
  let applies = false;

  for (const line of lines) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#")) {
      continue;
    }
    const [rawKey, ...rest] = cleaned.split(":");
    if (!rawKey || rest.length === 0) continue;

    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      const ua = value.toLowerCase();
      applies = ua === "*" || ua.includes("agent-permissions");
      continue;
    }

    if (!applies) continue;

    if (key === "disallow") {
      if (value) rules.disallow.push(value);
    } else if (key === "allow") {
      if (value) rules.allow.push(value);
    } else if (key === "crawl-delay") {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay)) {
        rules.crawlDelay = delay;
      }
    }
  }

  return rules;
}

export function isPathAllowed(path: string, rules: RobotsRules | null): boolean {
  if (!rules) return true;

  const normalizedPath = path || "/";

  for (const allowed of rules.allow) {
    if (matchesRule(normalizedPath, allowed)) {
      return true;
    }
  }

  for (const disallowed of rules.disallow) {
    if (matchesRule(normalizedPath, disallowed)) {
      return false;
    }
  }

  return true;
}

function matchesRule(targetPath: string, rulePath: string): boolean {
  if (!rulePath || rulePath === "/") {
    return true;
  }

  if (rulePath.endsWith("$")) {
    const exact = rulePath.slice(0, -1);
    return targetPath === exact;
  }

  return targetPath.startsWith(rulePath);
}
