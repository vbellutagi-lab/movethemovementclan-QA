import { env } from "./env";

export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
  Created: string;
}

interface MailpitSearchResult {
  messages: MailpitMessageSummary[];
}

interface MailpitMessageDetail {
  Text: string;
  HTML: string;
  Subject: string;
}

/**
 * Polls Mailpit's REST API (the SMTP catcher docker-compose stands in for Mailtrap/SES — see
 * docker-compose.yml) for the newest message to `recipient`, optionally matching `subjectMatch`.
 * Polls instead of a fixed sleep since outbound email in this app goes through an async
 * dispatcher (security.html's "outbox" pattern) — arrival time isn't guaranteed instant.
 */
export async function waitForMessage(
  recipient: string,
  opts: { subjectMatch?: RegExp; timeoutMs?: number; sinceMs?: number } = {},
): Promise<MailpitMessageDetail & { ID: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const since = opts.sinceMs ?? 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(
      `${env.mailpitBaseUrl}/api/v1/search?query=${encodeURIComponent(`to:"${recipient}"`)}`,
    );
    if (res.ok) {
      const body = (await res.json()) as MailpitSearchResult;
      const candidates = body.messages
        .filter((m) => new Date(m.Created).getTime() >= since)
        .filter((m) => !opts.subjectMatch || opts.subjectMatch.test(m.Subject))
        .sort((a, b) => new Date(b.Created).getTime() - new Date(a.Created).getTime());
      const newest = candidates[0];
      if (newest) {
        const detailRes = await fetch(`${env.mailpitBaseUrl}/api/v1/message/${newest.ID}`);
        const detail = (await detailRes.json()) as MailpitMessageDetail;
        return { ...detail, ID: newest.ID };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `No message arrived for ${recipient} within ${timeoutMs}ms` +
      (opts.subjectMatch ? ` matching ${opts.subjectMatch}` : ""),
  );
}

/** Pulls the first http(s) URL out of a plain-text email body (every template here has exactly one CTA link). */
export function extractFirstUrl(text: string): string {
  const match = text.match(/https?:\/\/[^\s)]+/);
  if (!match) throw new Error(`No URL found in email body: ${text.slice(0, 200)}`);
  return match[0];
}
