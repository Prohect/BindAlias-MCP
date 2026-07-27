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
// Embedded into the runAlias tool description. Aliases are grouped into four
// behavior types:
//   KEY aliases     +x holds a vanilla key, -x releases it (keybind simulation)
//   SWITCH aliases  +x turns a state ON, -x turns it OFF (never a toggle)
//   ACTION aliases  plain name, one immediate effect, no +/- form
//   COMMAND aliases take \-separated arguments
// Every rule below was verified against the running mod (MC 26.2 branch)
// and the decompiled game sources.
// ===========================================================================

const ALIAS_RULES = [
  "CHAIN SYNTAX: 'def' is a space-separated chain of alias calls, and a backslash separates an alias name from its args (and arg from arg), e.g. 'slot\\2 wait\\1 +forward swapSlot\\2\\c3'.",
  'QUOTING: spaces split the chain, so a multi-word argument must be wrapped in double quotes with the opening quote right after the backslash arg-divider: say\\"hello world" or sendCommand\\"time set day".',
  "NESTING: in alias's args, ';' converts to a real space — write ';' instead of spaces to keep a nested chain intact, e.g. 'alias\\newAlias;+forward;wait\\20;-forward'. Elsewhere ';' is literal.",
  "SILENT FAILURES: misspelled names and bad args are skipped silently (runAlias still returns ok) — verify with getState, getScreenshot, or the logDiff field returned by runAlias/getState/getScreenshot.",
  "DETERMINISM: the host injects no physical input — state changes come only from your chains or game logic, so held keys behave exactly as vanilla and screens change only from your chains or game events (e.g. death).",
  'TIMING: wait\\N defers the rest of the chain by N ticks; runAlias returns immediately without waiting chain of alias done. At default speed keep time-sensitive steps in ONE runAlias call (inter-call latency is unpredictable); at a low tick rate (sendCommand\\"tick rate 1") an observe->reason->react cycle costs low ticks, so steps spread across calls — and keys held between calls — could stay predictable.',
  "RELEASE RULE: +x persists until -x, across tool calls and screen transitions. Held states re-fire their press action whenever a screen closes and the cursor re-grabs. Release when the effect should stop; one-shot keys right after press: '+advancements wait\\1 -advancements'.",
  "SCREENS: while any GUI screen is open, +attack/+use presses are suppressed (releases still work). While a text-input screen is open (chat, sign, book, command block), all key-like presses are suppressed. Movement aliases (+forward, +jump, +sneak, etc.) still work under non-text screens like inventory and containers.",
  "VARIABLES: numbers stored via the var alias can be used as numeric args anywhere (slot, wait, yaw, pitch, setYaw, setPitch, swapSlot), e.g. 'var\\s\\hotbarSlot slot\\1 ... slot\\s'. Variables set from a c<N> source (var\\name\\c3) are stored in a special map only accessible by swapSlot and treated as container-slot references by swapSlot.",
];

// KEY aliases — simulate vanilla keybinds: +x = key down (held), -x = key up.
const KEY_ALIASES = [
  "+attack / -attack — hold to mine blocks and attack entities (left click)",
  "+use / -use — hold to use items / place blocks / interact (right click)",
  "+forward +back +left +right (and - forms) — hold movement keys",
  "+jump / -jump — hold to hop on land, swim up in water, or ascend while flying (creative)",
  "+sneak / -sneak — hold sneak (shift)",
  "+sprint / -sprint — hold sprint",
  "+drop / -drop — press drops one item of the held stack; hold to keep dropping. In a container screen drops from the hovered slot. When +freeCursor is active, hover is pinned to the player-inventory slot 14 on all container screens, so +drop targets that slot regardless of OS cursor position. Stack split: drop part of a stack, then swapSlot the remainder into a container slot so the piles won't re-merge",
  "+playerList / -playerList — hold to show the online-player (Tab) overlay",
  "+advancements / -advancements — toggle the advancements screen, -advancements has no toggle effect; release right after (RELEASE RULE)",
];

// SWITCH aliases — boolean state: +x = ON, -x = OFF. Never toggles.
const SWITCH_ALIASES = [
  "+debugOverlay / -debugOverlay — show / hide the F3 debug overlay",
  "+silent / -silent — suppress / restore mod feedback messages in chat",
  "+freeCursor / -freeCursor — (dev) keep the OS cursor free from the game, bypass some vanilla logic guards for agent experience; camera driven only by yaw/pitch aliases. On any container screen the hovered slot is pinned to the player-inventory slot 14, making +drop and swapSlot target a deterministic slot",
];

// ACTION aliases — one-shot calls, no +/- form.
const ACTION_ALIASES = [
  "esc — close the current screen; if none is open, toggle the pause menu",
  "closeScreen — close the current screen if there is one",
  "cyclePerspective — cycle camera: FPS -> TPS -> TPS2",
  "FPS / TPS / TPS2 — set camera: first person / third-person back / third-person front",
  "toggleInventory — open the inventory if closed, close it if open",
  "swapHand — swap main hand and offhand items",
  "pickItem — select the hotbar slot if one matches the targeted block/entity, otherwise try move an item stack that matches the targeted block/entity in your inventory to the selected slot",
  "reloadCFG — reload the .cfg file",
  "unloadCFGAliases / unloadCFGVars / unloadCFGAll — remove aliases / variables previously autoloaded from the cfg (runtime-created ones are kept)",
  "builtinShutdown — shut the game down",
];

// COMMAND aliases — take arguments (backslash-separated).
const COMMAND_ALIASES = [
  "slot\\1-9 — select hotbar slot (works even with a screen open)",
  "wait\\ticks — defer the rest of the chain by N ticks (N >= 0), wait\\1 defer that to next tick, wait\\0 NOP",
  "yaw\\deg / pitch\\deg — rotate the camera by relative degrees",
  "setYaw\\deg — absolute yaw: 0=south(+Z), 90=west(-X), 180/-180=north(-Z), -90=east(+X)",
  "setPitch\\deg — absolute pitch: -90=up, 0=horizon, 90=down",
  "swapSlot\\a\\b or swapSlot\\a — swap two item stacks (1-arg form swaps with the selected hotbar slot). Slots: 1-9 hotbar, 10-36 inventory, 37 feet, 38 legs, 39 chest, 40 head, 41 offhand; c<N> = Nth slot of the open container menu (getState lists c-indices), works under a container screen if c<N> or c<N> valued var is included, works if no screen. Examples: swapSlot\\1\\9, swapSlot\\1\\c2",
  "say\\text — send a chat message to the server",
  "localSay\\text — client-side-only chat message (never sent)",
  "sendCommand\\cmd — run a server command (no leading slash)",
  "log\\text — append a line to the game log (read it back via the logDiff field on runAlias/getState/getScreenshot)",
  "var\\name\\source — store a number for use as an arg. sources: hotbarSlot, yaw, pitch, itemsOfSlot0-9 (0=offhand, 1-9=hotbar) (stack count), a literal number, or specially c<N> which is in a different map that only swapSlot could access as a container-slot reference.",
  "alias\\\"name definition...\" — define an alias from inside a chain (one quoted arg, or ';' as space — NESTING). Prefer the defineAlias tool if you dont need dynamic alias definitions",
  "builtinRunAlias\\name — run a registered alias by name (extra \\args allowed, do not support inline chain or alias definition)",
  "reapply\\action — re-assert a held key after a screen transition. actions: attack,use,forward,back,left,right,jump,sneak,sprint,drop,playerList. Most actions could work to beat the vanilla releaseAll() on setScreen event (make sure reapply is deferred after the setScreen event), +attack and +use have builtin guard to avoid the bypass for safety",
];

const RUNALIAS_DESCRIPTION =
  "Execute a chain of BindAliasPlus aliases (key/macro automation inside the running game). " +
  ALIAS_RULES.join(" ") +
  " KEY ALIASES: " +
  KEY_ALIASES.join("; ") +
  ". SWITCH ALIASES (+x ON, -x OFF): " +
  SWITCH_ALIASES.join("; ") +
  ". ACTION ALIASES (one-shot): " +
  ACTION_ALIASES.join("; ") +
  ". COMMAND ALIASES (backslash separates args): " +
  COMMAND_ALIASES.join("; ") +
  '. RETURNS: JSON {"tick": <N>, "x": <double>, "y": <double>, "z": <double>, "yaw": <float>, "pitch": <float>, "logDiff": "<messages>"} — ticks since world join and player POS snapshot captured BEFORE alias execution, plus new game-log messages since the last tool call (same as the former getLogDiff tool). tick is -1 if not in a world, and POS fields are omitted when not in a world.';

const TOOLS = [
  {
    name: "getState",
    description:
      "Get a snapshot of the current game state: dimension, screen class name (null = in-game HUD), " +
      "player x/y/z/yaw/pitch, health, held item + count, selected_hotbar_slot (1-9), " +
      "durability of selected hotbar slot item (only for damageable items), ticks since world join. " +
      "When a container screen is open, also includes a 'container' object: " +
      "inventory_items[] whose 'index' is a swapSlot argument (number 1-41 for player-inventory, " +
      "'cNN' string for container slots), container_grid — 2D array of cell strings " +
      "('cNN:*' occupied, 'cNN:o' empty slot, '     ' format placeholder), " +
      "and empty_inv listing empty player-inventory slot ranges. " +
      "'cNN' indices match swapSlot's c<N> addressing.",
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
      "Read the raw text of the bind-alias-plus.cfg config file, returned as plain text. The cfg is auto-loaded (filtered non-comment lines executed by client command) on world join " +
      "(and loaded by the alias reloadCFG / the tool writeCFG). One command per line: alias <name> <definition>, " +
      "var <name> <source>, runAlias <def>; '#' starts a comment, a leading '/' is optional. " +
      "IMPORTANT: Read cfg to understand what is defined as own capability expansions and instructions of them.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "writeCFG",
    description:
      "Overwrite the bind-alias-plus.cfg config file with new content and immediately reload it. " +
      "Same line format as readCFG. NOTE: reloading only adds/overwrites. Put 'runAlias unloadCFGAll' as the " +
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

// Fetch and format log diff text. Returns null on error so callers can decide
// whether to omit or surface the failure.
async function fetchLogDiff() {
  try {
    const result = await apiGet("/logDiff");
    if (result.error) return null;
    const messages = result.messages || "";
    const count = result.count || 0;
    return count > 0
      ? messages + "\n[" + count + " new message(s)]"
      : "(no new messages)";
  } catch (_) {
    return null;
  }
}

async function handleToolCall(toolName, args) {
  switch (toolName) {
    case "getState": {
      const [state, logDiff] = await Promise.all([
        apiGet("/state"),
        fetchLogDiff(),
      ]);
      // Warn on log-diff fetch failure but still return state
      if (logDiff == null && state.error == null) state._logDiff = "(fetch failed)";
      else if (state.error == null) state.logDiff = logDiff;
      return wrapResult(state);
    }

    case "getScreenshot": {
      const [result, logDiff] = await Promise.all([
        apiGet("/screenshot"),
        fetchLogDiff(),
      ]);
      if (result.error) return wrapResult(result);
      if (result.base64) {
        const content = [
          { type: "image", data: result.base64, mimeType: "image/png" },
        ];
        if (result.x !== undefined) {
          content.push({
            type: "text",
            text: JSON.stringify({
              x: result.x,
              y: result.y,
              z: result.z,
              yaw: result.yaw,
              pitch: result.pitch,
              tick: result.tick,
            }),
          });
        }
        if (logDiff != null) {
          content.push({ type: "text", text: "[logDiff]\n" + logDiff });
        }
        return { content };
      }
      return errorResult("screenshot failed: unexpected response from mod");
    }

    case "runAlias": {
      const [result, logDiff] = await Promise.all([
        apiPost("/runAlias", { def: args.def || "" }),
        fetchLogDiff(),
      ]);
      if (result.error) return errorResult(result.error);
      const tick = result.tick;
      if (tick < 0) return jsonResult({ error: "not in world" });
      const out = { tick };
      if (result.x !== undefined) {
        out.x = result.x;
        out.y = result.y;
        out.z = result.z;
        out.yaw = result.yaw;
        out.pitch = result.pitch;
      }
      if (logDiff != null) out.logDiff = logDiff;
      return jsonResult(out);
    }

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
