#!/usr/bin/env node
/**
 * MCP stdio bridge for BindAliasPlus mod (Node.js version).
 *
 * Connects to the mod's HTTP API (127.0.0.1:25575) and exposes 7 tools
 * to AI agents via the Model Context Protocol (JSON-RPC 2.0 on stdio).
 *
 * Usage:
 *     node mcp_server.js
 *
 * The mod must be running with the MCP HTTP server active.
 */

const http = require("http");

const API_BASE = "http://127.0.0.1:25575";

// Args separator: \\ (backslash in alias syntax).
// Boolean aliases use \\1=press/hold, \\0=release.
// The 'def' parameter accepts a space-separated chain of aliases,
// with backslash for args, e.g. 'slot\\2 wait\\1 +forward'.
// Known aliases are split into two groups shown below.
const ALIAS_WITHOUT_ARGS = [
  "+attack",
  "-attack",
  "+use",
  "-use",
  "+forward",
  "-forward",
  "+back",
  "-back",
  "+left",
  "-left",
  "+right",
  "-right",
  "+jump",
  "-jump",
  "+sneak",
  "-sneak",
  "+sprint",
  "-sprint",
  "+drop",
  "-drop",
  "+screenshot",
  "-screenshot",
  "+playerList",
  "-playerList",
  "+advancements",
  "-advancements",
  "+debugOverlay",
  "-debugOverlay",
  "+openInventory",
  "-openInventory",
  "+silent",
  "-silent",
  "cyclePerspective",
  "swapHand",
  "pickItem",
  "toggleInventory",
  "reloadCFG",
  "unloadCFGAliases",
  "unloadCFGBinds",
  "unloadCFGVars",
  "unloadCFGAll",
  "builtinShutdown",
  "FPS",
  "TPS",
  "TPS2",
  "esc",
  "closeScreen",
];
const ALIAS_WITH_ARGS = [
  "slot",
  "log",
  "say",
  "localSay",
  "sendCommand",
  "alias",
  "swapSlot",
  "wait",
  "yaw",
  "pitch",
  "setYaw",
  "setPitch",
  "var",
  "builtinRunAlias",
  "reapply",
  "bind",
  "unbind",
  "+lockKey",
  "-lockKey",
];
const ALIAS_ARGS_HELP = [
  // name             args syntax
  ["slot", "\\<1-9>  switch hotbar slot  e.g. slot args=3"],
  ["log", "\\<message>  log to game console (debug)"],
  ["say", "\\<message>  send chat message"],
  ["localSay", "\\<message>  show client-side only"],
  [
    "sendCommand",
    "\\<command>  send command (spaces kept)  e.g. sendCommand\\time set day",
  ],
  ["alias", "\\<name>\\<definition>  define a new alias"],
  [
    "swapSlot",
    "\\<slot1>\\<slot2> or \\<slot1>  swap two slots or swap with current hotbar slot; slots 1-9=hotbar,10-36=inv,37-40=armor,41=offhand; c<N>=container slot N",
  ],
  ["wait", "\\<ticks>  pause execution for N ticks (20 ticks=1s)"],
  ["yaw", "\\<degrees>  rotate yaw relative"],
  ["pitch", "\\<degrees>  rotate pitch relative"],
  ["setYaw", "\\<degrees>  set absolute yaw (0=north,90=east,180=south)"],
  ["setPitch", "\\<degrees>  set absolute pitch (-90=up,90=down)"],
  [
    "var",
    "\\<varName>\\<source>  store value; sources: hotbarSlot,pitch,yaw,itemsOfSlot0-9,number",
  ],
  ["builtinRunAlias", "\\<aliasName>  execute another alias by name"],
  [
    "reapply",
    "\\<action>  re-assert held key (forward,attack,use,back,left,right,jump,sneak,sprint,drop,openInventory)",
  ],
  ["bind", "\\<key>\\<definition>  bind a key to alias definition(s)"],
  ["unbind", "\\<key>  unbind a key"],
  [
    "+lockKey",
    "\\<action>  lock game key; actions: gameKey:attack,gameKey:use,gameKey:forward,... or aliasName",
  ],
  ["-lockKey", "\\<action>  unlock a previously locked key/alias"],
];

const TOOLS = [
  {
    name: "getState",
    description:
      "Get current Minecraft game state snapshot: screen class name, " +
      "world name, dimension, player x/y/z/yaw/pitch, health, " +
      "held item registry name + count + hotbar slot, adds slots info if there's any container screen.  Returns JSON.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "getScreenshot",
    description:
      "Trigger a immediately Minecraft screenshot. " +
      "Returns that screenshot. ",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "runAlias",
    description:
      "Execute a chain of BindAliasPlus aliases. " +
      "The 'def' parameter is a space-separated chain with backslash for args, " +
      "e.g. 'slot\\2 wait\\1 +forward'. " +
      "basicly +<aliasName> means enter a state, and -<aliasName> means exit a state." +
      "Known aliases: " +
      "Without args: " +
      ALIAS_WITHOUT_ARGS.join(", ") +
      ". " +
      "With args: " +
      ALIAS_WITH_ARGS.join(", ") +
      ". " +
      "ARG SYNTAX: " +
      ALIAS_ARGS_HELP.map(function (a) {
        return a[0] + ": " + a[1];
      }).join("; ") +
      ". " +
      "NOTE: each runAlias call is independent — do NOT spread a timed " +
      "sequence across multiple tool calls (timing between calls is unpredictable). " +
      "Instead, chain with 'wait' inside a single call. " +
      "runAlias returns immediately; it does NOT wait for the chain to finish. " +
      "Use 'getState' after a wait in the chain to verify results. " +
      'Returns JSON {"ok": true} on success.',
    inputSchema: {
      type: "object",
      properties: {
        def: {
          type: "string",
          description:
            "Alias chain definition. Space-separated aliases, backslash for args: e.g. 'slot\\2 wait\\1 +forward'.",
        },
      },
      required: ["def"],
    },
  },
  {
    name: "defineAlias",
    description:
      "Define a new alias. " +
      'Returns JSON {"ok": true} on success. ' +
      "Must be in a world (not on title screen).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Alias name to create." },
        def: { type: "string", description: "Alias definition string." },
      },
      required: ["name", "def"],
    },
  },
  {
    name: "readCFG",
    description:
      "Read the raw content of the bind-alias-plus.cfg config file. " +
      "the cfg is auto loaded. " +
      'Returns JSON {"content": "..."} with the file contents.',
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "writeCFG",
    description:
      "Overwrite the bind-alias-plus.cfg config file with new content " +
      "and reload it. Parameter 'content' is the full file text. " +
      'Returns JSON {"ok": true}.',
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
    name: "getLogDiff",
    description:
      "Get new game-log messages since the last getLogDiff call. " +
      "Returns messages that appeared since the previous invocation (or since startup on first call). " +
      "Use this to check command feedback, error messages, chat output, etc. " +
      "Returns JSON {\"messages\": \"...\", \"count\": N}.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ---- HTTP helpers ----
// Use encodeURIComponent (spaces → %20) to match the mod's decodePercent,
// which does NOT convert '+' to space.

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
    http
      .get(url, { timeout: 10000 }, (res) => {
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
      })
      .on("error", (e) => {
        resolve({ error: "Cannot connect to mod: " + e.message });
      });
  });
}

function apiPost(path, params, body) {
  const url = buildUrl(path, params);
  const bodyStr = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const req = http.request(
      url,
      {
        method: "POST",
        timeout: 10000,
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
    req.on("error", (e) => {
      resolve({ error: "Cannot connect to mod: " + e.message });
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---- MCP JSON-RPC ----
// Use fs.writeSync(fd=1) for stdout to avoid pipe buffering on Windows.
// process.stdout.write() can buffer when stdout is a pipe (not a TTY),
// causing Zed's initialize handshake to time out after 60s.
const fs = require("fs");
function send(obj) {
  fs.writeSync(1, JSON.stringify(obj) + "\n");
}

function makeResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleToolCall(toolName, args) {
  switch (toolName) {
    case "getState":
      return apiGet("/state");

    case "getScreenshot": {
      const result = await apiGet("/screenshot");
      if (result.base64) {
        const content = [
          { type: "image", data: result.base64, mimeType: "image/png" },
        ];
        if (result.x !== undefined) {
          content.push({
            type: "text",
            text: "x=" + result.x + " y=" + result.y + " z=" + result.z + " yaw=" + result.yaw + " pitch=" + result.pitch,
          });
        }
        return { content };
      }
      return result;
    }

    case "runAlias": {
      const params = {};
      if (args.def) {
        params.def = args.def;
      } else {
        // legacy: name + args
        params.name = args.name || "";
        if (args.args) params.args = args.args;
      }
      return apiPost("/runAlias", params);
    }

    case "defineAlias":
      return apiPost("/defineAlias", {
        name: args.name || "",
        def: args.def || "",
      });

    case "readCFG":
      return apiGet("/readCFG");

    case "writeCFG":
      return apiPost("/writeCFG", null, { content: args.content || "" });

    case "getLogDiff":
      return apiGet("/logDiff");

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ---- Main ----
// Use raw stdin instead of readline — on Windows pipes, readline may not
// emit "line" events reliably when the parent process keeps stdin open.

let stdinBuffer = "";

function main() {
  // Write a startup marker so we can tell if the process even starts.
  // If this file appears, the process launched; if not, node wasn't found.
  try {
    require("fs").writeFileSync(
      __dirname + "/.mcp_startup",
      Date.now().toString(),
    );
  } catch (_) {}

  fs.writeSync(2, "[mcp_server] started, waiting for stdin...\n");

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
        serverInfo: { name: "bind-alias-plus-mcp", version: "1.0.0" },
      }),
    );
  } else if (method === "tools/list") {
    send(makeResponse(id, { tools: TOOLS }));
  } else if (method === "tools/call") {
    const params = request.params || {};
    const toolName = params.name || "";
    const args = params.arguments || {};

    handleToolCall(toolName, args).then((result) => {
      // Wrap in MCP content format if not already
      if (!result.content && !result.error) {
        result = {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } else if (result.content && typeof result.content === "string") {
        // API returns {"content": "..."} — wrap string content in array
        result = {
          content: [{ type: "text", text: result.content }],
        };
      }
      send(makeResponse(id, result));
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
