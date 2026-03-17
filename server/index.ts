import { auth } from "./src/auth";
import { migrate } from "./src/migrate";
import { handleApiRequest } from "./src/routes";
import { join } from "path";

await migrate();

const WEBSITE_DIR = join(import.meta.dir, "../website");

const server = Bun.serve({
  port: process.env.PORT || 3001,
  async fetch(request) {
    const url = new URL(request.url);

    // Auth routes — handled by Better Auth (same origin, no CORS needed)
    if (url.pathname.startsWith("/api/auth")) {
      return auth.handler(request);
    }

    // API routes — handled directly by TypeScript routes
    if (url.pathname.startsWith("/api")) {
      const response = await handleApiRequest(url, request);
      if (response) return response;
      return new Response(JSON.stringify({ detail: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
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
console.log(`  API:     ${server.url}api (native)`);
