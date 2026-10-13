import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostIsBlocked, htmlToText, isLinkLocal, LINK_LOCAL_MESSAGE, readPage } from "./tools";

describe("htmlToText", () => {
  it("removes scripts, styles and tags, decodes entities, and collapses whitespace", () => {
    const html = `<!doctype html><html><head><title>My &amp; Page</title><style>body{color:red}</style>
      <script>alert("x")</script></head><body><nav>Menu</nav>
      <h1>Hello   world</h1><p>First&nbsp;line &lt;ok&gt;.</p><!-- note --><p>Second <b>bold</b> line.</p>
      <script type="module">console.log(1)</script></body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("My & Page");
    expect(text).toBe("Menu\nHello world\nFirst line <ok>.\nSecond bold line.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });
});

describe("htmlToText on hostile pages", () => {
  it("stays fast on many unclosed tags", () => {
    const started = performance.now();
    const { text } = htmlToText(`<html><body><p>Start</p>${"<svg ".repeat(40_000)}`);
    expect(performance.now() - started).toBeLessThan(300);
    expect(text).toBe("Start");
  });

  it("stays fast on many stray angle brackets and unclosed comments", () => {
    const started = performance.now();
    htmlToText(`<p>a</p>${"<!-- x ".repeat(30_000)}${"a < b ".repeat(30_000)}`);
    htmlToText(`<div>${"<title>x".repeat(30_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("only reads the first 500,000 characters of HTML", () => {
    const page = `<p>Early text.</p>${" ".repeat(600_000)}<p>Late text.</p>`;
    const { text } = htmlToText(page);
    expect(text).toBe("Early text.");
  });
});

describe("link-local addresses", () => {
  it("recognizes 169.254.0.0/16 and fe80::/10 in their common forms", () => {
    expect(isLinkLocal("169.254.169.254")).toBe(true);
    expect(isLinkLocal("169.254.0.1")).toBe(true);
    expect(isLinkLocal("[fe80::1]")).toBe(true);
    expect(isLinkLocal("febf::1")).toBe(true);
    expect(isLinkLocal("::ffff:169.254.169.254")).toBe(true);
    expect(isLinkLocal("::ffff:a9fe:a9fe")).toBe(true);
    expect(isLinkLocal("127.0.0.1")).toBe(false);
    expect(isLinkLocal("192.168.1.10")).toBe(false);
    expect(isLinkLocal("10.0.0.5")).toBe(false);
    expect(isLinkLocal("::1")).toBe(false);
    expect(isLinkLocal("fec0::1")).toBe(false);
  });

  it("checks what a host name resolves to", async () => {
    const fakeLookup = async (host: string) => (host === "metadata.internal" ? ["169.254.169.254"] : ["192.168.1.20"]);
    expect(await hostIsBlocked("metadata.internal", fakeLookup)).toBe(true);
    expect(await hostIsBlocked("staging.local", fakeLookup)).toBe(false);
  });

  it("refuses link-local URLs and keeps other hosts reachable", async () => {
    expect(await readPage("http://169.254.169.254/latest/meta-data")).toEqual({
      url: "http://169.254.169.254/latest/meta-data",
      error: LINK_LOCAL_MESSAGE,
    });
    expect(await readPage("http://[fe80::1]/")).toMatchObject({ error: LINK_LOCAL_MESSAGE });
    expect(await readPage("http://2852039166/")).toMatchObject({ error: LINK_LOCAL_MESSAGE });
  });
});

describe("readPage", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><head><title>Local page</title></head><body><p>${"word ".repeat(3000)}</p></body></html>`);
      } else if (req.url === "/to-metadata") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
        res.end();
      } else if (req.url === "/to-page") {
        res.writeHead(301, { Location: "/page" });
        res.end();
      } else if (req.url === "/image") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from([1, 2, 3]));
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not here");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("reads a local page and returns the title and the first 8000 characters", async () => {
    const result = await readPage(`${base}/page`);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.title).toBe("Local page");
    expect(result.text.length).toBe(8000);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("word word")).toBe(true);
  });

  it("follows redirects on local hosts and refuses a redirect to a link-local address", async () => {
    const followed = await readPage(`${base}/to-page`);
    expect(followed).toMatchObject({ url: `${base}/page`, title: "Local page" });
    expect(await readPage(`${base}/to-metadata`)).toEqual({ url: `${base}/to-metadata`, error: LINK_LOCAL_MESSAGE });
  });

  it("reports pages it cannot read in plain words", async () => {
    expect(await readPage(`${base}/missing`)).toEqual({ url: `${base}/missing`, error: "The page returned status 404." });
    expect(await readPage(`${base}/image`)).toMatchObject({ error: "The page is not text. Its content type is image/png." });
    expect(await readPage("ftp://example.org/file")).toMatchObject({ error: "Only http and https pages can be read." });
    expect(await readPage("not a url")).toMatchObject({ error: "The URL is not valid. Use a full http or https URL." });
  });
});
