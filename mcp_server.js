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
const fs = require("fs");

const API_BASE = "http://127.0.0.1:25575";

// ===========================================================================
// BindAliasPlus alias-language reference.
// Embedded into the runAlias tool description. Every rule below was verified
// against the running mod (MC 26.2 branch) and the decompiled game sources.
// ===========================================================================

// Core syntax/semantics. READ THESE FIRST — most failures come from
// ignoring the quoting rule or assuming errors are reported.
const ALIAS_SYNTAX = [
  "CHAIN SYNTAX: 'def' is a space-separated chain of alias calls, and a backslash separates an alias name from its args (and arg from arg), e.g. 'slot\\2 wait\\1 +forward'.",
  'QUOTING (critical): spaces split the chain, so a multi-word argument must be wrapped in double quotes with the opening quote right after the backslash arg-divider: say\\"hello world" or sendCommand\\"time set day". Write the alias-language form exactly as shown — the bridge passes the def to the mod verbatim (as-is) and your tool framework handles JSON encoding.',
  "FAILURES ARE SILENT: a misspelled or nonexistent alias name is ignored without any error, and runAlias still returns ok. When something didn't work, call getLogDiff to see the game log.",
  "+name presses/holds a key (enter state), -name releases it (exit state). Movement keys (+forward, +sprint, ...) are meant to be held; remember to release them when done.",
  "MOMENTARY KEYS MUST BE RELEASED: a still-held key is re-asserted every time a screen closes and the cursor re-grabs, re-firing its action. One-shot pattern: '+screenshot wait\\1 -screenshot'.",
  "wait\\N defers the REST of the chain by N ticks (20 ticks = 1 second). runAlias returns immediately; it does NOT wait for deferred parts. Chain all time-sensitive steps inside ONE runAlias call — never spread a timed sequence across multiple tool calls (inter-call timing is unpredictable). Use getState/getScreenshot/getLogDiff after enough real time to verify the result.",
  "VARIABLES: numbers stored via the var alias can be used as numeric args anywhere (slot, wait, yaw, pitch, setYaw, setPitch, swapSlot), e.g. 'var\\s\\hotbarSlot ... slot\\s'.",
  "SCREENS: while any GUI screen is open, +attack/+use presses are suppressed (releases still work) and +openInventory does nothing. While a text-input screen is open (chat, sign, book, command block), all key-like presses are suppressed.",
];

// Aliases without args: +x enters/holds a state, -x releases it.
const ALIAS_WITHOUT_ARGS = [
  "+attack / -attack — hold to mine blocks and attack entities (left click)",
  "+use / -use — hold to use items / place blocks / interact (right click)",
  "+forward +back +left +right (and - forms) — hold movement keys",
  "+jump / -jump — hold to jump, swim up, or fly up (creative)",
  "+sneak / -sneak — hold sneak (shift)",
  "+sprint / -sprint — hold sprint (combine with +forward to run)",
  "+drop / -drop — press drops one item of the held stack; keep holding to keep dropping. In a container screen it drops from the hovered slot instead, and in agent play (no mouse events reach the unfocused game window) the hover stays where the screen put it on open — for the inventory screen that's slot 14 (center of the first main-inventory row 10-18, hotbar being 1-9). Stack-split workflow: drop part of the hovered stack onto the ground, then swapSlot the remainder into a container slot so picking up the dropped pile won't re-merge it — two separate stacks, useful for crafting and other split-stack operations",
  "+screenshot — take a screenshot on press (F2); release right after (see momentary-key rule)",
  "+playerList / -playerList — hold to show the online-player (Tab) overlay",
  "+advancements — open the advancements screen on press; release right after (see momentary-key rule)",
  "+debugOverlay / -debugOverlay — show / hide the F3 debug overlay (NOT a toggle)",
  "+openInventory / -openInventory — open the player inventory (no-op if another screen is open) / close the current container screen",
  "+silent / -silent — suppress / restore the mod's own feedback messages in chat (game log unaffected)",
  "+freeCursor / -freeCursor — (dev) keep the OS cursor free while the game behaves as if grabbed; the physical mouse no longer turns the camera, view is driven only by yaw/pitch aliases",
  "esc — close the current screen; if no screen is open, toggle the pause menu",
  "closeScreen — close the current screen only (never opens the pause menu)",
  "cyclePerspective — cycle camera: first person -> third-person back -> third-person front",
  "FPS / TPS / TPS2 — set camera: first person / third-person back / third-person front",
  "toggleInventory — open the inventory if closed, close it if open",
  "swapHand — swap main hand and offhand items (F)",
  "pickItem — pick-block the targeted block/entity (middle click)",
  "reloadCFG — reload the .cfg file",
  "unloadCFGAliases / unloadCFGBinds / unloadCFGVars / unloadCFGAll — remove aliases / key binds / variables previously autoloaded from the cfg (runtime-created ones are kept)",
  "builtinShutdown — quit the game cleanly",
];

// Aliases with args. Arg separator is the backslash.
const ALIAS_WITH_ARGS = [
  "slot\\1-9 — select hotbar slot (packet-based, works even with a screen open)",
  "wait\\ticks — defer the rest of the chain by N ticks (20/s)",
  "yaw\\deg / pitch\\deg — rotate the camera by relative degrees",
  "setYaw\\deg — absolute yaw: 0=south(+Z), 90=west(-X), 180/-180=north(-Z), -90=east(+X)",
  "setPitch\\deg — absolute pitch: -90=straight up, 0=horizon, 90=straight down",
  "swapSlot\\a\\b or swapSlot\\a — swap two item stacks (1-arg form swaps with the currently selected hotbar slot). Player slots: 1-9=hotbar, 10-36=inventory, 37=feet(boots), 38=legs(leggings), 39=chest(chestplate), 40=head(helmet), 41=offhand. cN = Nth slot (1-based) of the open container menu (chest, crafting table, furnace, anvil, ...; getState lists these indices). Hotbar/offhand swaps work even while a container is open. Examples: swapSlot\\1\\9, swapSlot\\1\\c2 (hotbar 1 into crafting-grid slot 2)",
  'say\\text — send a chat message to the server; quote multi-word text: say\\"hi all"',
  'localSay\\text — client-side-only chat message (never sent); quote spaces: localSay\\"hi all"',
  'sendCommand\\cmd — run a server command (no leading slash); quote spaces: sendCommand\\"time set day"',
  'log\\text — append a line to the game log (read it back with getLogDiff); quote spaces: log\\"some text"',
  "var\\name\\source — store a number for later use as an arg. sources: hotbarSlot (1-9), pitch, yaw, itemsOfSlot0-9 (stack size; 0=offhand, 1-9=hotbar), or a literal number",
  'alias\\"name definition..." — define an alias from inside a chain (the whole name+definition must be one quoted arg, e.g. alias\\"myMacro log\\a wait\\10 log\\b"). Prefer the defineAlias tool instead',
  "builtinRunAlias\\name — run a registered alias by name (extra \\args allowed)",
  "reapply\\action — re-assert a held key after a screen transition. actions: attack,use,forward,back,left,right,jump,sneak,sprint,drop,openInventory,playerList",
  "+lockKey\\target / -lockKey\\target — block / unblock physical input for a game key (gameKey:attack, gameKey:use, gameKey:forward, gameKey:back, gameKey:left, gameKey:right, gameKey:jump, gameKey:sneak, gameKey:sprint) or for all keys bound to a custom alias name, so real input can't interfere with automation. Locks are auto-restored on disconnect",
  "bind\\key\\definition / unbind\\key — bind a physical key to a definition chain: pressing runs the definition, releasing runs its auto-opposite (+x becomes -x). If the definition is exactly an existing alias name, the key binds to it and its +- counterpart instead. Key names: a-z, 0-9, f1-f12, space, ... ; mouse1=left button, mouse2=right, mouse3=middle",
];

const RUNALIAS_DESCRIPTION =
  "Execute a chain of BindAliasPlus aliases (key/macro automation inside the running game). " +
  ALIAS_SYNTAX.join(" ") +
  " ALIASES WITHOUT ARGS (+x = press/hold, -x = release): " +
  ALIAS_WITHOUT_ARGS.join("; ") +
  ". ALIASES WITH ARGS (backslash separates args): " +
  ALIAS_WITH_ARGS.join("; ") +
  '. RETURNS: JSON {"ok": true} as soon as the synchronous part of the chain has run; wait-deferred steps complete later. ' +
  "This is NOT an error channel — bad args and unknown aliases only show up in the game log, so follow up with getLogDiff/getState/getScreenshot to verify the outcome.";

const TOOLS = [
  {
    name: "getState",
    description:
      "Get a snapshot of the current game state as JSON: open screen class name (null = in-game HUD), " +
      "ticks since world join, world/server name, dimension, player x/y/z/yaw/pitch, health, " +
      "held item registry name + count, selected hotbar slot (1-9). " +
      "When a container screen is open, also returns a 'container' section: " +
      "items[] whose 'index' is directly usable as a swapSlot argument (a number 1-41 for player-inventory slots, " +
      "or a 'cN' string for container-menu slots), a 'grid' ASCII map of the container slots " +
      "('#' empty, '$' occupied, ' ' no slot) with aligned per-cell c-indices in 'cells', " +
      "and 'emptyInv' listing empty player-inventory slot ranges.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "getScreenshot",
    description:
      "Take an immediate in-game screenshot and return it as a PNG image, " +
      "plus a text line with the player's x/y/z/yaw/pitch and tick. Fails when not in a world.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "runAlias",
    description: RUNALIAS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        def: {
          type: "string",
          description:
            'Alias chain definition. Space-separated aliases, backslash for args, \\"-quoted multi-word args: e.g. \'slot\\2 wait\\1 +forward\' or sendCommand\\"time set day".',
        },
      },
      required: ["def"],
    },
  },
  {
    name: "defineAlias",
    description:
      "Define a new alias (macro) through the game's real /alias command and return the game's feedback. " +
      "'def' uses the exact same chain syntax as runAlias (space-separated chain, backslash for args, " +
      '\\"-quoted multi-word args like say\\"hi all"). Alias names must be single words and cannot overwrite ' +
      "builtin or predefined aliases (+attack, slot, ...). Must be in a world (not on the title screen).",
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
            "Alias definition string (chain syntax, same as runAlias).",
        },
      },
      required: ["name", "def"],
    },
  },
  {
    name: "readCFG",
    description:
      "Read the raw text of the bind-alias-plus.cfg config file, returned as plain text. The cfg is auto-loaded on world join " +
      "(and by reloadCFG / writeCFG). One command per line: alias <name> <definition>, " +
      "bind <key> <definition>, bindByAliasName <key> <aliasName>, unbind <key>, " +
      "var <name> <source>, runAlias <aliasName>; '#' starts a comment, a leading '/' is optional.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "writeCFG",
    description:
      "Overwrite the bind-alias-plus.cfg config file with new content and immediately reload it. " +
      "Same line format as readCFG. NOTE: reloading only adds/overwrites — entries that were removed " +
      "from the file stay registered. To make removals take effect, put 'runAlias unloadCFGAll' as the " +
      "first line (it clears everything the cfg previously autoloaded, then the rest of the file re-defines it). " +
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
      "Get new game-log messages since the last getLogDiff call (chat, command feedback, mod warnings/errors), " +
      "returned as plain multi-line text with a trailing '[N new message(s)]' marker ('(no new messages)' when nothing arrived). " +
      "The primary way to verify runAlias results, because unknown alias names fail silently.",
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
    // The timeout option only emits 'timeout' on socket idleness — it does
    // NOT abort the request. Destroy manually so the promise settles via
    // the 'error' handler instead of hanging forever.
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", (e) => {
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
    // Same manual abort as apiGet — 'timeout' alone does not end the request.
    req.on("timeout", () => req.destroy(new Error("request timed out")));
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
// Every tool result is normalized to { content: [...] } (plus isError on
// failures) so the caller always gets a well-formed, readable response —
// raw {error: ...} objects are never leaked as tool results.

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: "text", text: "Error: " + message }],
  };
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// JSON object -> text content: compact one-liner when short (acks like
// {"ok":true}), pretty-printed when long (getState snapshots).
function jsonResult(obj) {
  const compact = JSON.stringify(obj);
  return textResult(
    compact.length <= 120 ? compact : JSON.stringify(obj, null, 2),
  );
}

// Normalize a raw bridge/mod response into a proper MCP tool result.
function wrapResult(result) {
  if (result == null) return errorResult("no response from mod");
  if (Array.isArray(result.content)) return result; // already MCP-shaped (screenshot)
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
    case "getState":
      return wrapResult(await apiGet("/state"));

    case "getScreenshot": {
      const result = await apiGet("/screenshot");
      if (result.error) return wrapResult(result);
      if (result.base64) {
        const content = [
          { type: "image", data: result.base64, mimeType: "image/png" },
        ];
        if (result.x !== undefined) {
          content.push({
            type: "text",
            text:
              "x=" +
              result.x +
              " y=" +
              result.y +
              " z=" +
              result.z +
              " yaw=" +
              result.yaw +
              " pitch=" +
              result.pitch +
              " tick=" +
              result.tick,
          });
        }
        return { content };
      }
      return errorResult("screenshot failed: unexpected response from mod");
    }

    case "runAlias":
      return wrapResult(await apiPost("/runAlias", { def: args.def || "" }));

    case "defineAlias": {
      const result = await apiPost("/defineAlias", {
        name: args.name || "",
        def: args.def || "",
      });
      // Success: surface the game's feedback line directly, e.g. "Alias x = ..."
      if (result && result.ok && result.feedback)
        return textResult(result.feedback);
      return wrapResult(result);
    }

    case "readCFG":
      return wrapResult(await apiGet("/readCFG"));

    case "writeCFG":
      // Content travels as a query parameter — the same as-is transport used
      // for runAlias defs: percent-encoding only, no JSON escaping layers.
      // The mod checks the query first and decodes %XX back to exact bytes.
      return wrapResult(
        await apiPost("/writeCFG", { content: args.content || "" }),
      );

    case "getLogDiff": {
      const result = await apiGet("/logDiff");
      if (result.error) return wrapResult(result);
      const messages = result.messages || "";
      const count = result.count || 0;
      // Plain multi-line text is far more readable than a JSON-escaped string
      return textResult(
        count > 0
          ? messages + "\n[" + count + " new message(s)]"
          : "(no new messages)",
      );
    }

    default:
      return errorResult("unknown tool: " + toolName);
  }
}

// ---- Main ----
// Use raw stdin instead of readline — on Windows pipes, readline may not
// emit "line" events reliably when the parent process keeps stdin open.

let stdinBuffer = "";

function main() {
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
