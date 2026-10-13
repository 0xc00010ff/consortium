// Browsing tools for seats with browsing on: the gateway web search, and a
// local page reader. The page reader runs on this server, so it can reach
// localhost, private network addresses and staging sites. It refuses
// link-local addresses (169.254.0.0/16 and fe80::/10), where cloud metadata
// services live, including after redirects.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gateway, tool, type ToolSet } from "ai";
import { z } from "zod";

export const READ_PAGE_LIMIT = 8000;
const READ_PAGE_TIMEOUT_MS = 10_000;
const MAX_HTML_CHARS = 500_000; // the most HTML passed to tag stripping
const MAX_BODY_BYTES = 600_000;
const MAX_REDIRECTS = 5;

export const LINK_LOCAL_MESSAGE =
  "This address is blocked. The page reader does not open link-local addresses such as 169.254.169.254, because cloud metadata services use them.";

export type ReadPageResult =
  | { url: string; title: string; text: string; truncated: boolean }
  | { url: string; error: string };

type LookupAll = (hostname: string) => Promise<string[]>;

const systemLookup: LookupAll = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

export const readPageTool = tool({
  description:
    "Read a web page by its URL. Returns the page title and up to 8000 characters of its text. Works with http and https URLs, including local and staging sites.",
  inputSchema: z.object({
    url: z.string().describe("The full http or https URL of the page to read."),
  }),
  execute: async ({ url }, { abortSignal }) => readPage(url, abortSignal),
});

export function browsingTools(): ToolSet {
  return {
    web_search: gateway.tools.parallelSearch({ mode: "agentic", maxResults: 5 }),
    read_page: readPageTool,
  };
}

// ---------- Address checks ----------

// True for 169.254.0.0/16 and fe80::/10, including IPv4-mapped IPv6 forms.
export function isLinkLocal(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(a) === 4) {
    const [first, second] = a.split(".").map(Number);
    return first === 169 && second === 254;
  }
  if (isIP(a) !== 6) return false;
  const mapped = /^(?:0*:)*:?ffff:(.+)$/.exec(a.startsWith("::") ? a.slice(1) : a);
  if (mapped) {
    const rest = mapped[1];
    if (isIP(rest) === 4) return isLinkLocal(rest);
    const hextets = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hextets) {
      const high = parseInt(hextets[1], 16);
      return high >> 8 === 169 && (high & 0xff) === 254;
    }
  }
  const firstHextet = a.split(":")[0];
  if (!firstHextet) return false;
  const value = parseInt(firstHextet, 16);
  return value >= 0xfe80 && value <= 0xfebf;
}

// True when the host is, or resolves to, a link-local address.
export async function hostIsBlocked(hostname: string, lookupAll: LookupAll = systemLookup): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isLinkLocal(host);
  try {
    const addresses = await lookupAll(host);
    return addresses.some(isLinkLocal);
  } catch {
    return false; // the fetch will report that the host could not be found
  }
}

// ---------- Reading a page ----------

export async function readPage(
  url: string,
  signal?: AbortSignal,
  lookupAll: LookupAll = systemLookup,
): Promise<ReadPageResult> {
  let target: URL;
  try {
    target = new URL(url.trim());
  } catch {
    return { url, error: "The URL is not valid. Use a full http or https URL." };
  }

  const timeout = AbortSignal.timeout(READ_PAGE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    // Follow redirects one at a time, so every address can be checked.
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return { url, error: "Only http and https pages can be read." };
      }
      if (await hostIsBlocked(target.hostname, lookupAll)) return { url, error: LINK_LOCAL_MESSAGE };

      const hopResponse = await fetch(target, {
        signal: combined,
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Consortium page reader)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
      const location = hopResponse.headers.get("location");
      if (hopResponse.status >= 300 && hopResponse.status < 400 && location) {
        await hopResponse.body?.cancel().catch(() => {});
        target = new URL(location, target);
        continue;
      }
      response = hopResponse;
      break;
    }
    if (!response) return { url, error: `The page redirected more than ${MAX_REDIRECTS} times.` };
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { url, error: `The page returned status ${response.status}.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/|html|xml|json/i.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      return { url, error: `The page is not text. Its content type is ${contentType.split(";")[0]}.` };
    }

    const body = await readBody(response, MAX_BODY_BYTES);
    const looksLikeHtml = /html|xml/i.test(contentType) || /<(!doctype|html|body|head)\b/i.test(body.slice(0, 2000));
    const page = looksLikeHtml ? htmlToText(body) : { title: "", text: collapseWhitespace(body) };
    return {
      url: target.toString(),
      title: page.title,
      text: page.text.slice(0, READ_PAGE_LIMIT),
      truncated: page.text.length > READ_PAGE_LIMIT,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) return { url, error: "The page did not respond within 10 seconds." };
    const message = err instanceof Error ? err.message : String(err);
    return { url, error: `The page could not be loaded. ${message}` };
  }
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return text + decoder.decode();
}

// ---------- HTML to text ----------

// Elements whose content is never page text.
const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "iframe", "canvas", "object", "title"]);
// Elements that start a new line.
const BLOCKS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "li", "ul", "ol", "tr", "table",
  "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "pre", "blockquote", "dd", "dt",
]);

// Removes scripts, styles and tags, decodes common entities, and collapses
// whitespace. A single forward scan keeps the work linear in the input size,
// and the input is capped at 500,000 characters.
export function htmlToText(input: string): { title: string; text: string } {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const lower = html.toLowerCase();
  const out: string[] = [];
  let title = "";
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      out.push(" ");
      continue;
    }

    // Declarations such as <!doctype html> and processing instructions.
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64))?.[1]?.toLowerCase();
    if (!name) {
      // A "<" that does not start a tag is ordinary text.
      out.push("<");
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) break; // an unclosed tag runs to the end
    const closing = html[lt + 1] === "/";
    i = gt + 1;

    // The title is read here and kept out of the page text.
    if (!closing && name === "title" && !title) {
      const end = lower.indexOf("</title", i);
      const titleEnd = Math.min(end < 0 ? html.length : end, i + 2000);
      title = collapseWhitespace(decodeEntities(html.slice(i, titleEnd).replace(/<[^<>]*>/g, " ")));
    }
    if (!closing && SKIPPED.has(name) && html[gt - 1] !== "/") {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) {
        i = html.length;
      } else {
        const endGt = html.indexOf(">", end);
        i = endGt < 0 ? html.length : endGt + 1;
      }
      out.push(" ");
      continue;
    }
    out.push(BLOCKS.has(name) ? "\n" : " ");
  }

  return { title, text: collapseWhitespace(decodeEntities(out.join(""))) };
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "-",
  ndash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  copy: "(c)",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}
