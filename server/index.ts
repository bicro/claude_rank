import { auth } from "./src/auth";
import { migrate } from "./src/migrate";
import { handleApiRequest } from "./src/routes";
import { join } from "path";

await migrate();

const WEBSITE_DIR = join(import.meta.dir, "../website");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://clauderank.com";

const SECURITY_HEADERS: Record<string, string> = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://us-assets.i.posthog.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://pbs.twimg.com https://avatars.githubusercontent.com https://*.licdn.com https://*.googleusercontent.com https://cdn.discordapp.com https://api.dicebear.com https://randomuser.me",
    "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com https://pbs.twimg.com https://avatars.githubusercontent.com https://*.licdn.com https://*.googleusercontent.com https://cdn.discordapp.com https://api.dicebear.com https://randomuser.me",
    "font-src 'self'",
    "frame-ancestors * tauri://localhost http://tauri.localhost https://tauri.localhost",
  ].join("; "),
};

function withSecurityHeaders(response: Response, url: URL): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  // Allow widget.html to be embedded in any site
  if (url.pathname === "/widget.html" || url.pathname === "/widget") {
    headers.set(
      "Content-Security-Policy",
      SECURITY_HEADERS["Content-Security-Policy"].replace(
        /frame-ancestors [^;]+/,
        "frame-ancestors * tauri://localhost http://tauri.localhost https://tauri.localhost"
      )
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

const server = Bun.serve({
  port: process.env.PORT || 3001,
  async fetch(request) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...SECURITY_HEADERS, ...corsHeaders() },
      });
    }

    let response: Response;

    // Auth routes — handled by Better Auth
    if (url.pathname.startsWith("/api/auth")) {
      response = await auth.handler(request);
    }
    // API routes — handled directly by TypeScript routes
    else if (url.pathname.startsWith("/api")) {
      response = await handleApiRequest(url, request)
        ?? new Response(JSON.stringify({ detail: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
    }
    // Static website files
    else {
      let filePath = join(WEBSITE_DIR, url.pathname);

      // Serve index.html for directory requests
      if (url.pathname === "/" || url.pathname.endsWith("/")) {
        filePath = join(filePath, "index.html");
      }

      const file = Bun.file(filePath);
      if (await file.exists()) {
        response = new Response(file);
      } else {
        // Try with .html extension
        const htmlFile = Bun.file(filePath + ".html");
        if (await htmlFile.exists()) {
          response = new Response(htmlFile);
        } else {
          response = new Response("Not Found", { status: 404 });
        }
      }
    }

    // Add CORS headers to API responses
    if (url.pathname.startsWith("/api")) {
      const cors = corsHeaders();
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return withSecurityHeaders(response, url);
  },
});

console.log(`ClaudeRank running on ${server.url}`);
console.log(`  Website: ${server.url}`);
console.log(`  Auth:    ${server.url}api/auth`);
console.log(`  API:     ${server.url}api (native)`);
