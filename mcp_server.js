#!/usr/bin/env node
/**
 * MCP stdio bridge for BindAlias mod.
 */

const http = require("http");
const fs = require("fs");

// ---- port: --port N | --port=N | default 25575 ----
function parsePort() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && i + 1 < argv.length) {
      const p = parseInt(argv[i + 1], 10);
      if (p > 0 && p < 65536) return p;
    }
    const m = /^--port=(\d+)$/.exec(argv[i]);
    if (m) {
      const p = parseInt(m[1], 10);
      if (p > 0 && p < 65536) return p;
    }
  }
  return 25575;
}

const API_BASE = "http://127.0.0.1:" + parsePort();

// ===========================================================================
// runAlias description — wire-protocol facts only (chain syntax lives on the
// `def` param below). The alias catalog and gameplay semantics (which aliases
// exist, screens/variables interplay, etc.) change with the mod and per-world
// cfg, so they live in src/agent_system_prompt.md instead of here — paste
// that into your agent's system prompt. Run src/sync_mcp_instructions.sh
// after editing this file to refresh "src/raw api instruction.json", a preview of
// exactly what a caller receives from tools/list.
// ===========================================================================

const RUNALIAS_DESCRIPTION =
  "Execute a chain of aliases against the running game. " +
  "SILENT FAILURES: an unknown alias name or invalid args fails that step with no thrown error. " +
  "Returns the standard envelope: the state diff captured before execution, or after the nap when `nap` is given.";

const TOOLS = [
  {
    name: "runAlias",
    description: RUNALIAS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        def: {
          type: "string",
          description:
            'Alias chain definition. Space for alias(with arg) separator, backslash for alias_name-arg separator or arg-arg separator, " quotes multi-word arg preventing space inside to be parsed as alias(with arg) separator: e.g. `say\\"hello world"`. Semicolon for alias\'s (the alias named as `alias`) extra separator: e.g. `alias\\turnDown;setPitch\\90`, `alias\\turnRight;yaw\\90`',
        },
        nap: {
          type: "integer",
          description:
            "Defer the tool call's response by N client_tick. The chain runs immediately; the response then blocks until N client_tick have elapsed. The game keeps running the whole time — you cannot react to anything or poll state until the call returns.",
        },
      },
      required: ["def"],
    },
  },
  {
    name: "getFullState",
    description: "Get full state and drain messages.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "getScreenshot",
    description: "Screenshot, and standard envelope.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "defineAlias",
    description: "Define a new alias. Returns the standard envelope.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Alias name to create (single word).",
        },
        def: {
          type: "string",
          description:
            "Alias definition string (chain syntax, same as 'runAlias').",
        },
      },
      required: ["name", "def"],
    },
  },
  {
    name: "readCFG",
    description:
      "Read the cfg file, returned as plain text. " +
      "cfg syntax: one command(optional leading '/') per line — alias <name> <definition>, " +
      "var <name> <source>, runAlias <def>; '#' starts a comment. " +
      "Read it to discover the currently defined custom aliases/variables — the live capability catalog beyond the builtins.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "writeCFG",
    description:
      "Overwrite the cfg file with new content and immediately reload it. " +
      "Same line format as 'readCFG'. Reloading only adds/overwrites — put \"runAlias unloadCFGAll\" as the " +
      "first line to clear stale entries before the new content. " +
      "Returns the standard envelope.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Full config file content to write.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "readNotes",
    description:
      "Read the entire content of a file. " +
      'Returns {"content":"..."} (empty string if the file does not exist).',
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "Plain filename (with extension) inside the agent directory. No path separators or '..' allowed.",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "writeNotes",
    description: "Write a file.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "Plain filename (with extension) inside the agent directory. No path separators or '..' allowed.",
        },
        content: {
          type: "string",
          description: "Full file content to write.",
        },
      },
      required: ["file", "content"],
    },
  },
  {
    name: "listRecipes",
    description:
      "List recipes unlocked in the recipe book. Only works while a recipe-book screen is open (player inventory via toggleInventory, crafting table, furnace, ...). " +
      "Without 'queries': returns recipes learned since the previous 'listRecipes' call (a diff — the first call after joining the world returns everything). " +
      "With 'queries' (result-item ids like 'minecraft:torch' or 'torch', or locale-name substrings like 'iron sword'): every query is answered independently — matches land in 'recipes', per-query failures in 'recipe_errors'. " +
      "Entries: {name, item, craftable}. craftable=true means the ingredients are in your inventory right now. " +
      "Returns the standard envelope plus recipes/recipe_errors (see the 'getFullState' description).",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of recipe queries. Omit to list newly unlocked recipes.",
        },
      },
      required: [],
    },
  },
];

// ---- HTTP helpers ----

function buildUrl(path, params) {
  let url = API_BASE + path;
  if (params) {
    const qs = Object.entries(params)
      .map(function (e) {
        return encodeURIComponent(e[0]) + "=" + encodeURIComponent(e[1]);
      })
      .join("&");
    url += "?" + qs;
  }
  return url;
}

function apiGet(path, params) {
  const url = buildUrl(path, params);
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 10000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: "Invalid JSON response" });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", (e) => {
      resolve({ error: "Cannot connect to mod: " + e.message });
    });
  });
}

function apiPost(path, params, body, timeoutMs) {
  const url = buildUrl(path, params);
  const bodyStr = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const req = http.request(
      url,
      {
        method: "POST",
        timeout: timeoutMs || 10000,
        headers: bodyStr
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(bodyStr),
            }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ error: "Invalid JSON response" });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", (e) => {
      resolve({ error: "Cannot connect to mod: " + e.message });
    });
    req.end();
  });
}

// ---- MCP JSON-RPC ----

function send(obj) {
  fs.writeSync(1, JSON.stringify(obj) + "\n");
}

function makeResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---- MCP result formatting ----

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: "text", text: "Error: " + message }],
  };
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// JSON object -> text content: compact one-liner when short, pretty-printed
// when long (state snapshots).
function jsonResult(obj) {
  const compact = JSON.stringify(obj);
  return textResult(
    compact.length <= 120 ? compact : JSON.stringify(obj, null, 2),
  );
}

// Normalize a raw bridge/mod response into a proper MCP tool result.
function wrapResult(result) {
  if (result == null) return errorResult("no response from mod");
  if (Array.isArray(result.content)) return result; // already MCP-shaped
  if (result.error) return errorResult(result.error); // bridge/mod error
  if (typeof result.content === "string") {
    // readCFG: raw config file text
    return textResult(
      result.content.length ? result.content : "(config file is empty)",
    );
  }
  return jsonResult(result);
}

async function handleToolCall(toolName, args) {
  switch (toolName) {
    case "getFullState":
      return wrapResult(await apiGet("/state"));

    case "getScreenshot": {
      const result = await apiGet("/screenshot");
      if (result.error) return wrapResult(result);
      if (result.base64) {
        const { base64, ...envelope } = result;
        const content = [
          { type: "image", data: base64, mimeType: "image/png" },
        ];
        content.push({ type: "text", text: JSON.stringify(envelope) });
        return { content };
      }
      return errorResult("screenshot failed: unexpected response from mod");
    }

    case "runAlias": {
      const nap = Number(args.nap);
      const napTicks =
        Number.isInteger(nap) && nap >= 1 && nap <= 1200 ? nap : 0;
      const params = { def: args.def || "" };
      if (napTicks > 0) params.nap = String(napTicks);
      const result = await apiPost(
        "/runAlias",
        params,
        null,
        10000 + napTicks * 50,
      );
      return wrapResult(result);
    }

    case "defineAlias": {
      const result = await apiPost("/defineAlias", {
        name: args.name || "",
        def: args.def || "",
      });
      return wrapResult(result);
    }

    case "readCFG":
      return wrapResult(await apiGet("/readCFG"));

    case "writeCFG":
      return wrapResult(
        await apiPost(
          "/writeCFG",
          { content: args.content || "" },
          null,
          30000,
        ),
      );

    case "listRecipes": {
      let queries = args.queries;
      if (typeof queries === "string") queries = [queries];
      const params =
        Array.isArray(queries) && queries.length > 0
          ? { q: queries.join(",") }
          : null;
      return wrapResult(await apiGet("/listRecipes", params));
    }

    case "readNotes":
      return wrapResult(await apiGet("/readNotes", { file: args.file || "" }));

    case "writeNotes":
      return wrapResult(
        await apiPost(
          "/writeNotes",
          {
            file: args.file || "",
            content: args.content || "",
          },
          null,
          30000,
        ),
      );

    default:
      return errorResult("unknown tool: " + toolName);
  }
}

// ---- Main ----

let stdinBuffer = "";

function main() {
  fs.writeSync(
    2,
    "[mcp_server] started, API " + API_BASE + ", waiting for stdin...\n",
  );

  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  process.stdin.on("data", (chunk) => {
    fs.writeSync(
      2,
      "[mcp_server] received chunk: " + JSON.stringify(chunk) + "\n",
    );
    stdinBuffer += chunk;
    // Process complete lines
    let newlineIdx;
    while ((newlineIdx = stdinBuffer.indexOf("\n")) !== -1) {
      const line = stdinBuffer.slice(0, newlineIdx).trim();
      stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      handleLine(line);
    }
  });

  process.stdin.on("end", () => {
    fs.writeSync(2, "[mcp_server] stdin ended, exiting\n");
    process.exit(0);
  });

  process.stdin.on("error", (err) => {
    fs.writeSync(2, "[mcp_server] stdin error: " + err.message + "\n");
  });
}

function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const id = request.id;
  const method = request.method || "";

  if (method === "initialize") {
    send(
      makeResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bind-alias-mcp", version: "2.1.0" },
      }),
    );
  } else if (method === "ping") {
    send(makeResponse(id, {}));
  } else if (method === "tools/list") {
    send(makeResponse(id, { tools: TOOLS }));
  } else if (method === "tools/call") {
    const params = request.params || {};
    const toolName = params.name || "";
    const args = params.arguments || {};

    handleToolCall(toolName, args)
      .then((result) => {
        send(makeResponse(id, result));
      })
      .catch((e) => {
        // Never leave a tool call unanswered, even on an internal bug.
        send(makeError(id, -32603, String((e && e.message) || e)));
      });
  } else if (method === "notifications/initialized") {
    // No response for notifications
  } else {
    send(makeError(id, -32601, "Method not found: " + method));
  }
}

process.on("uncaughtException", (err) => {
  fs.writeSync(
    2,
    "[mcp_server] FATAL: " + err.message + "\n" + err.stack + "\n",
  );
  process.exit(1);
});

main();
