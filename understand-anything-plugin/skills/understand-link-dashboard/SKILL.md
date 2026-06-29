---
name: understand-link-dashboard
description: Launch the interactive split-screen dashboard to visualize a multi-repo system graph (services + cross-service calls) with drill-down
argument-hint: [workspace-path]
---

# /understand-link-dashboard

Start the Understand Anything dashboard in multi-repo "system" mode to visualize the federated system graph produced by `/understand-link`. The view shows the system overview — services as nodes, business domains, and the cross-service Dubbo/HTTP calls between them — and lets you drill down into any service's own graph in a split-screen layout.

## Instructions

1. Determine the workspace directory:
   - If `$ARGUMENTS` contains a path, use that as the workspace directory
   - Otherwise, use the current working directory

   This is the `/understand-link` workspace root — the directory that contains the link manifest and the `.understand-link/` folder, not a single repo.

2. Check that `.understand-link/system-graph.json` exists in the workspace directory. If not, tell the user:
   ```
   No system graph found. Run /understand-link first to build the cross-service system graph.
   ```

3. Find the dashboard code. The dashboard is at `packages/dashboard/` relative to this plugin's root directory. Check these paths in order and use the first that exists:
   - `${CLAUDE_PLUGIN_ROOT}/packages/dashboard/` (Claude Code runtime root, highest priority)
   - `~/.understand-anything-plugin/packages/dashboard/` (universal symlink, all installs)
   - Two levels up from `~/.agents/skills/understand-link-dashboard` real path (self-relative fallback)
   - Two levels up from `~/.copilot/skills/understand-link-dashboard` real path (Copilot personal skills fallback)
   - Common clone-based install roots:
     - `~/.codex/understand-anything/understand-anything-plugin/packages/dashboard/`
     - `~/.opencode/understand-anything/understand-anything-plugin/packages/dashboard/`
     - `~/.pi/understand-anything/understand-anything-plugin/packages/dashboard/`
     - `~/understand-anything/understand-anything-plugin/packages/dashboard/`

   Use the Bash tool to resolve:
   ```bash
   SKILL_REAL=$(realpath ~/.agents/skills/understand-link-dashboard 2>/dev/null || readlink -f ~/.agents/skills/understand-link-dashboard 2>/dev/null || echo "")
   SELF_RELATIVE=$([ -n "$SKILL_REAL" ] && cd "$SKILL_REAL/../.." 2>/dev/null && pwd || echo "")
   COPILOT_SKILL_REAL=$(realpath ~/.copilot/skills/understand-link-dashboard 2>/dev/null || readlink -f ~/.copilot/skills/understand-link-dashboard 2>/dev/null || echo "")
   COPILOT_SELF_RELATIVE=$([ -n "$COPILOT_SKILL_REAL" ] && cd "$COPILOT_SKILL_REAL/../.." 2>/dev/null && pwd || echo "")

   PLUGIN_ROOT=""
   for candidate in \
     "${CLAUDE_PLUGIN_ROOT}" \
     "$HOME/.understand-anything-plugin" \
     "$SELF_RELATIVE" \
     "$COPILOT_SELF_RELATIVE" \
     "$HOME/.codex/understand-anything/understand-anything-plugin" \
     "$HOME/.opencode/understand-anything/understand-anything-plugin" \
     "$HOME/.pi/understand-anything/understand-anything-plugin" \
     "$HOME/understand-anything/understand-anything-plugin"; do
     if [ -n "$candidate" ] && [ -d "$candidate/packages/dashboard" ]; then
       PLUGIN_ROOT="$candidate"; break
     fi
   done

   if [ -z "$PLUGIN_ROOT" ]; then
     echo "Error: Cannot find the understand-anything plugin root."
     echo "Checked:"
     echo "  - ${CLAUDE_PLUGIN_ROOT:-<unset CLAUDE_PLUGIN_ROOT>}"
     echo "  - $HOME/.understand-anything-plugin"
     echo "  - ${SELF_RELATIVE:-<unresolved path derived from ~/.agents/skills/understand-link-dashboard>}"
     echo "  - ${COPILOT_SELF_RELATIVE:-<unresolved path derived from ~/.copilot/skills/understand-link-dashboard>}"
     echo "  - $HOME/.codex/understand-anything/understand-anything-plugin"
     echo "  - $HOME/.opencode/understand-anything/understand-anything-plugin"
     echo "  - $HOME/.pi/understand-anything/understand-anything-plugin"
     echo "  - $HOME/understand-anything/understand-anything-plugin"
     echo "Make sure you followed the installation instructions for your platform."
     exit 1
   fi
   ```

4. Install dependencies and build if needed:
   ```bash
   cd <dashboard-dir> && pnpm install --frozen-lockfile 2>/dev/null || pnpm install
   ```
   Then ensure the core package is built (the dashboard depends on it):
   ```bash
   cd <plugin-root> && pnpm --filter @understand-anything/core build
   ```

5. Start the Vite dev server in system mode pointing at the workspace's system graph:
   ```bash
   cd <dashboard-dir> && LINK_DIR=<workspace-dir> DASHBOARD_MODE=system npx vite --host 127.0.0.1
   ```
   Run this in the background so the user can continue working. `LINK_DIR` points the server at the workspace's `.understand-link/system-graph.json` and the sibling service graphs it references, and `DASHBOARD_MODE=system` switches the frontend into split-screen system mode.

6. **Capture the access token URL from the server output.** The Vite server prints a line like:
   ```
   🔑  Dashboard URL: http://127.0.0.1:<PORT>?token=<TOKEN>
   ```
   Extract the full URL including the `?token=` parameter. The token is required to access the system graph data — without it the dashboard will show an "Access Token Required" gate.

7. Report to the user, including the full tokenized URL:
   ```
   Dashboard started at http://127.0.0.1:<PORT>?token=<TOKEN>
   Viewing: <workspace-dir>/.understand-link/system-graph.json (system overview)

   Click a service to inspect it, or double-click to drill into its own graph in the right pane.
   The dashboard is running in the background. Press Ctrl+C in the terminal to stop it.
   ```
   **Important:** Always include the `?token=` parameter in the URL you share. If you omit it, the user will be blocked by the token gate and have to manually find the token in the terminal output.

## Notes

- Double-clicking a service node (or using the sidebar "Open" buttons) loads that service's own graph in the right pane for side-by-side drill-down.
- Services and edges with no own graph available have their drill action disabled.
- The dashboard auto-opens in the default browser via `--open`
- If port 5173 is already in use, Vite will pick the next available port
- The `LINK_DIR` environment variable tells the dashboard where to find the system graph and its sibling service graphs; `DASHBOARD_MODE=system` enables the split-screen system view
- Same token gate as the single-repo dashboard — always share the URL with its `?token=` parameter
