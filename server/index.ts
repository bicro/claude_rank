import { auth } from "./src/auth";
import { migrate } from "./src/migrate";
import { join } from "path";

migrate();

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8001";
const WEBSITE_DIR = join(import.meta.dir, "../website");

const server = Bun.serve({
  port: process.env.PORT || 3001,
  async fetch(request) {
    const url = new URL(request.url);

    // Auth routes — handled by Better Auth (same origin, no CORS needed)
    if (url.pathname.startsWith("/api/auth")) {
      return auth.handler(request);
    }

    // API routes — proxy to FastAPI backend
    if (url.pathname.startsWith("/api")) {
      const backendUrl = `${BACKEND_URL}${url.pathname}${url.search}`;
      const res = await fetch(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" && request.method !== "HEAD"
          ? await request.blob()
          : undefined,
      });
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
    }

    // Static website files
    let filePath = join(WEBSITE_DIR, url.pathname);

    // Serve index.html for directory requests
    if (url.pathname === "/" || url.pathname.endsWith("/")) {
      filePath = join(filePath, "index.html");
    }

    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // Try with .html extension
    const htmlFile = Bun.file(filePath + ".html");
    if (await htmlFile.exists()) {
      return new Response(htmlFile);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`ClaudeRank running on ${server.url}`);
console.log(`  Website: ${server.url}`);
console.log(`  Auth:    ${server.url}api/auth`);
console.log(`  API:     proxying to ${BACKEND_URL}`);
