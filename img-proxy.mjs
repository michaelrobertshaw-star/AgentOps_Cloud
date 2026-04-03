#!/usr/bin/env node
// Tiny image proxy — fetches URLs on behalf of sandboxed processes.
// Listens on localhost:7788. Only allows icabbi S3 signature URLs.
import http from "http";
import https from "https";
import { URL } from "url";

const PORT = 7788;
const ALLOWED = /^https:\/\/s3\.amazonaws\.com\/icabbius\./i;

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const target = parsed.searchParams.get("url");

  if (!target || !ALLOWED.test(target)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  const targetUrl = new URL(target);
  const lib = targetUrl.protocol === "https:" ? https : http;
  const proxyReq = lib.get(target, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, {
      "Content-Type": proxyRes.headers["content-type"] || "image/png",
      "Content-Length": proxyRes.headers["content-length"] || "",
    });
    proxyRes.pipe(res);
  });
  proxyReq.setTimeout(12000, () => { proxyReq.destroy(); res.writeHead(504); res.end(); });
  proxyReq.on("error", (e) => { res.writeHead(502); res.end(String(e.message)); });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`img-proxy listening on http://127.0.0.1:${PORT}`);
});
