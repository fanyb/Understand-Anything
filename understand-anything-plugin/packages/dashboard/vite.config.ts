/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import {
  graphFileCandidates,
  readAndSanitizeGraph,
  readSourceFile,
  readServiceFile,
  readSystemGraph,
  readServiceGraph,
  readServiceDomainGraph,
  loadAllowedRefs,
} from "./server/graphFiles";

// Generate a one-time token when the server process starts.
// This token is printed to the terminal and must be in the URL
// to fetch any data endpoint.
const ACCESS_TOKEN = process.env.UNDERSTAND_ACCESS_TOKEN || crypto.randomBytes(16).toString("hex");

// Multi-repo (system) mode: set by /understand-link-dashboard. LINK_DIR is the
// workspace root (where the manifest + .understand-link/ live); DASHBOARD_MODE
// tells the frontend which shell to boot (single vs split system view).
const LINK_DIR = process.env.LINK_DIR || null;
const DASHBOARD_MODE = process.env.DASHBOARD_MODE === "system" ? "system" : "single";

function sendJson(res: import("http").ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/__tests__/**/*.test.ts",
      "server/**/__tests__/**/*.test.ts",
    ],
  },

  // FIX 1 — bind only to localhost, not 0.0.0.0
  // This blocks access from any other device on the same LAN / WiFi.
  server: {
    host: "127.0.0.1",
    port: 5173,
    open: `/?token=${ACCESS_TOKEN}`,
  },

  resolve: {
    alias: {
      "@understand-anything/core/schema": path.resolve(__dirname, "../core/dist/schema.js"),
      "@understand-anything/core/search": path.resolve(__dirname, "../core/dist/search.js"),
      "@understand-anything/core/types": path.resolve(__dirname, "../core/dist/types.js"),
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor";
          }
          if (id.includes("node_modules/@xyflow/")) return "xyflow";
          // ELK is ~1.6MB raw — split into its own chunk so it doesn't
          // bloat the main bundle. graphology is similarly large.
          if (id.includes("node_modules/elkjs/")) return "elk";
          if (id.includes("node_modules/graphology")) return "graphology";
          if (
            id.includes("node_modules/@dagrejs/") ||
            id.includes("node_modules/d3-force/")
          ) {
            return "graph-layout";
          }
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/hast-util-to-jsx-runtime/") ||
            /[\\/]node_modules[\\/](remark|rehype|mdast|hast|unist|micromark|decode-named-character-reference|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|devlop|bail|ccount|character-entities|is-plain-obj|trim-lines|trough|unified|vfile|zwitch)/.test(id)
          ) {
            return "markdown";
          }
        },
      },
    },
  },

  plugins: [
    react(),
    tailwindcss(),
    {
      name: "serve-knowledge-graph",
      configureServer(server) {
        // Print the access URL once so the developer can open it.
        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          const port = typeof address === "object" && address ? address.port : 5173;
          console.log(
            `\n  🔑  Dashboard URL: http://127.0.0.1:${port}/?token=${ACCESS_TOKEN}\n`
          );
        });

        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1:5173");
          const pathname = url.pathname;
          const isProtectedEndpoint =
            pathname === "/knowledge-graph.json" ||
            pathname === "/domain-graph.json" ||
            pathname === "/diff-overlay.json" ||
            pathname === "/meta.json" ||
            pathname === "/config.json" ||
            pathname === "/file-content.json" ||
            pathname === "/system-graph.json" ||
            pathname === "/service-graph.json" ||
            pathname === "/service-domain-graph.json";

          if (!isProtectedEndpoint) {
            next();
            return;
          }

          // FIX 3 — require the one-time token on all data endpoints.
          if (url.searchParams.get("token") !== ACCESS_TOKEN) {
            sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
            return;
          }

          // --- Multi-repo (system) endpoints ---
          if (pathname === "/system-graph.json") {
            const r = readSystemGraph(LINK_DIR);
            sendJson(res, r.statusCode, r.payload);
            return;
          }
          if (pathname === "/service-graph.json") {
            const r = readServiceGraph(LINK_DIR, url.searchParams.get("ref"), loadAllowedRefs(LINK_DIR));
            sendJson(res, r.statusCode, r.payload);
            return;
          }
          if (pathname === "/service-domain-graph.json") {
            const r = readServiceDomainGraph(LINK_DIR, url.searchParams.get("ref"), loadAllowedRefs(LINK_DIR));
            sendJson(res, r.statusCode, r.payload);
            return;
          }

          // --- File content (single-repo by path, or per-service by ref+path) ---
          if (pathname === "/file-content.json") {
            const ref = url.searchParams.get("ref");
            const requestedPath = url.searchParams.get("path") ?? "";
            const r = ref
              ? readServiceFile(LINK_DIR, ref, requestedPath, loadAllowedRefs(LINK_DIR))
              : readSourceFile(requestedPath);
            sendJson(res, r.statusCode, r.payload);
            return;
          }

          // --- Config (single-repo file if present) + server-injected mode ---
          if (pathname === "/config.json") {
            const configCandidates = graphFileCandidates("config.json");
            for (const candidate of configCandidates) {
              if (fs.existsSync(candidate)) {
                try {
                  const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
                  sendJson(res, 200, { ...raw, mode: DASHBOARD_MODE });
                  return;
                } catch {
                  sendJson(res, 500, { error: "Failed to read config file" });
                  return;
                }
              }
            }
            sendJson(res, 200, { autoUpdate: false, outputLanguage: "en", mode: DASHBOARD_MODE });
            return;
          }

          // --- Single-repo graph endpoints (sanitised) ---
          const fileName =
            pathname === "/diff-overlay.json"
              ? "diff-overlay.json"
              : pathname === "/meta.json"
              ? "meta.json"
              : pathname === "/domain-graph.json"
              ? "domain-graph.json"
              : "knowledge-graph.json";

          for (const candidate of graphFileCandidates(fileName)) {
            if (!fs.existsSync(candidate)) continue;
            const r = readAndSanitizeGraph(candidate);
            sendJson(res, r.statusCode, r.payload);
            return;
          }

          // No matching file found on disk.
          res.statusCode = 404;
          if (pathname === "/knowledge-graph.json") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "No knowledge graph found. Run /understand first." }));
          } else {
            res.end();
          }
        });
      },
    },
  ],
});
