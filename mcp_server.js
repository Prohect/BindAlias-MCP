#!/usr/bin/env node
/**
 * MCP stdio bridge for BindAliasPlus mod (Node.js version).
 *
 * Connects to the mod's HTTP API (default 127.0.0.1:25575; override with
 * `--port N` or `--port=N`) and exposes 7 tools to AI agents via the Model
 * Context Protocol (JSON-RPC 2.0 on stdio).
 *
 * Usage:
 *     node mcp_server.js [--port 25575]
 *
 * The mod must be running with the MCP HTTP server active.
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
  "SILENT FAILURES: misspelled alias_name and invalid args. ",
  "SCREENS: `+attack`/`+use`'s effects to game logic are suppressed when any screen is open. " +
    "These aliases (+-attack, +-use, +-forward, +-back, +-left, +-right, +-jump, +-sneak, +-sprint, +-drop, +-playerList, +-advancements, `esc`, `closeScreen`, `toggleInventory`, `swapHand`, `pickItem`, `swapSlot`, `sendCommand`, `reapply`) are suppressed while a text-screen (chat, sign, book, command block) is open. " +
    "These aliases (`+forward`, `+left`, `+right`, `+back`, `+jump`, `+sneak`, `+drop`) work on non-text-screens.  All builtin +aliases would be reapplied once per screen close event. ",
  "VARIABLES: numbers stored via the var alias can be used as numeric args (`slot`, `wait`, `yaw`, `pitch`, `setYaw`, `setPitch`, `swapSlot`), e.g. `var\\s\\hotbarSlot slot\\1 +drop -drop slot\\s`. Variables set from a `cN` source (`var\\name\\c3`) are stored in a special map only accessible by `swapSlot` and treated as container_slot references by `swapSlot`.",
];

// KEY aliases — simulate vanilla keybinds: +x = key down (held), -x = key up.
const KEY_ALIASES = [
  "`+attack / -attack` — hold to mine, tap to attack (not same as left click event)",
  "`+use / -use` — hold to use item / interact with block, tap to place block (not same as right click event)",
  "`+forward` `+back` `+left` `+right` (and - forms) — hold to move",
  "`+jump` / `-jump` — hold to jump on ground, swim up in water",
  "`+sneak` / `-sneak` — hold to sneak",
  "`+sprint` / `-sprint` — hold with `+forward` to sprint",
  "`+drop` / `-drop` — hold to continuously drop items(1 or hold_client_tick-3), tap to drop 1 item. Drop from the hovered slot in a container screen. Split a stack: drop part of a stack, then `swapSlot` the remainder into a container_slot so the piles won't re-merge to remainder, wait [move to item] for pickup",
  "`+playerList` / `-playerList` — hold to show the online-player overlay",
  "`+advancements` / `-advancements` — toggle the advancements screen, `-advancements` has no toggle effect",
];

// SWITCH aliases — boolean state: +x = ON, -x = OFF. Never toggles.
const SWITCH_ALIASES = [
  "`+silent` / `-silent` — suppress / restore mod feedback messages in chat",
  "`+freeCursor` / `-freeCursor` — keep the OS cursor free from the game, bypass minging logic guard for experience; camera driven only by yaw/pitch aliases, pin the hovered slot to inventory slot 14 in any container screen",
];

// ACTION aliases — one-shot calls, no +/- form.
const ACTION_ALIASES = [
  "`esc` — close current screen; if none is open, open pause screen",
  "`closeScreen` — close the current screen if there is one",
  "`cyclePerspective` — cycle camera: `FPS` -> `TPS` -> `TPS2`",
  "`FPS` / `TPS` / `TPS2` — set camera: first person / third-person back / third-person front",
  "`toggleInventory` — open the inventory if closed, close it if open",
  "`swapHand` — swap main hand and offhand items",
  "`pickItem` — select the hotbar slot if one matches the targeted block/entity, otherwise try move(by SWAP) an item stack that matches the targeted block/entity in your inventory to the selected slot",
  "`reloadCFG` — reload the cfg file",
  "`unloadCFGAliases` / `unloadCFGVars` / `unloadCFGAll` — unload aliases / variables previously autoloaded from the cfg (runtime-created ones are kept)",
  "`builtinShutdown` — shut the game down",
];

// COMMAND aliases — take arguments (backslash-separated).
const COMMAND_ALIASES = [
  "`slot\\N` — select hotbar slot N(1-9) (works on/not on screen)",
  "`wait\\N` — defer the rest of the chain by N client_tick (N >= 0), `wait\\0` NOP",
  "`yaw\\deg` / `pitch\\deg` — rotate the camera by deg",
  "`setYaw\\deg` — set absolute yaw",
  "`setPitch\\deg` — set absolute pitch, -90 <= deg <= 90",
  "`swapSlot\\a\\b` or `swapSlot\\a` — SWAP(not implemented by left click event) two item stacks (1-arg form swaps with the selected hotbar slot). Slots: 1-9 hotbar, 10-36 inventory, 37 feet, 38 legs, 39 chest, 40 head, 41 offhand, `cN` Nth slot of a container menu. `cN` is valid on container screen if Nth slot exists. Works on container screen when `cN` or `cN` var is included. Works whether or not on screen when `cN` or `cN` var is not included. Arg order not matter. Examples: `swapSlot\\1\\c2`",
  '`applyRecipe\\query` — apply an unlocked craftable recipe into the crafting grid on screen (by recipe book event); NO crafting performed. query = result-item id ("minecraft:torch" or "torch") or a case-insensitive locale-name substring ("iron sword"). Errors go to the local game chat. See also the `listRecipes` tool',
  "`say\\text` — send a chat text to server (quote arg if needed)",
  "`localSay\\text` — client-side-only chat text (quote arg if needed)",
  "`sendCommand\\cmd` — send a command to server (no leading slash)(quote arg if needed)",
  "`log\\text` — send text to the mod log (quote arg if needed)",
  "`var\\name\\source` — store a number for use as an arg. sources: `hotbarSlot`, `yaw`, `pitch`, `itemsOfSlotN` (N=0-9, 0=offhand, 1-9=hotbar) (stack count), a literal number, or specially `cN` which is in a different map that only `swapSlot` could access as a container_slot reference.",
  "`alias\\name_with_definition` — define or redefine an alias (\" quoted arg, or ';' repacing space arg) during alias (chain) execution",
  "`builtinRunAlias\\name` — run a alias by name (support optional \\args)(not support inline multi-alias chain)",
  "`reapply\\action` — re-sync all held key alias to game's KeyMapping after a screen transition. Actions: `attack`, `use`, `forward`, `back`, `left`, `right`, `jump`, `sneak`, `sprint`, `drop`, `playerList`. Make most actions possible to beat the vanilla releaseAll() on setScreen event (make sure reapply is deferred after the setScreen event), `+attack` and `+use` have builtin guard to avoid this bypass for safety",
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
  ". RETURNS the standard envelope: the state diff captured BEFORE execution, or AFTER the nap when the nap arg is given.";

const TOOLS = [
  {
    name: "getFullState",
    description:
      "Get a full snapshot of the current game state and drain all message channels. " +
      "Prefer reading the standard envelope (state diffs) attached to other tool response ('runAlias', 'getScreenshot', 'defineAlias' with OP needed or NOP) over polling 'getFullState'.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "getScreenshot",
    description:
      "Take an immediate in-game screenshot and return it as a PNG image, plus the standard envelope. Fails when not in a world.",
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
            'Alias chain definition of 0 or more alias(es). Space for alias(with arg) separator, backslash for alias_name-arg separator or arg-arg separator, " quotes multi-word arg preventing space inside to be treated as alias(with arg) separator: e.g. `say\\"hello world"`. Semicolon for alias\'s (the alias named as `alias`) extra separator: e.g. `alias\\turnDown;setPitch\\90`, `alias\\turnRight;yaw\\90`',
        },
        nap: {
          type: "integer",
          description:
            "Take a nap: defer the tool call's response by N client_tick (integer, same unit as the wait\\N alias). The alias chain runs immediately; the response then blocks until N client_tick elapsed in game and returns the standard envelope captured AFTER the nap. WARNING: game KEEPS RUNNING while you nap, and you can neither react to anything happening nor poll info from game during nap until the api returns; DO NOT nap long(> 2 client_tick) unless you have to skip **safe** boring time.",
        },
      },
      required: ["def"],
    },
  },
  {
    name: "defineAlias",
    description:
      "Define a new alias. " +
      "Alias names must be single words. " +
      "Cannot overwrite builtin aliases (`+attack`, `slot`, ...). " +
      "Returns the standard envelope.",
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
      "cfg syntax and rules: " +
      "One command per line: alias <name> <definition>, " +
      "var <name> <source>, runAlias <def>; '#' starts a comment, a leading '/' is optional. " +
      "IMPORTANT: Read cfg to understand what is defined as own capability expansions and instructions of them.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "writeCFG",
    description:
      "Overwrite the cfg file with new content and immediately reload it. " +
      "Same line format as 'readCFG'. NOTE: reloading only adds/overwrites. Put \"runAlias unloadCFGAll +freeCursor\" as the " +
      "first line, then the cfg content to write. " +
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
            "Optional list of recipe queries: result-item ids ('minecraft:torch', 'torch') or name substrings ('iron sword'). Omit to list newly unlocked recipes (diff).",
        },
      },
      required: [],
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
    //back compatibility with old client
    case "getState":
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
      // nap is measured in client_tick and served by the mod: it runs the
      // chain immediately, then holds the response until N client_tick
      // elapsed and captures the envelope fresh (newest state + messages).
      const nap = Number(args.nap);
      const napTicks =
        Number.isInteger(nap) && nap >= 1 && nap <= 1200 ? nap : 0;
      const params = { def: args.def || "" };
      if (napTicks > 0) params.nap = String(napTicks);
      // The mod answers only after the nap — the (inactivity) timeout must
      // outlast the nap's expected wall time (20 client_tick = 1 s).
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
      // Content travels as a query parameter — the same as-is transport used
      // for runAlias defs: percent-encoding only, no JSON escaping layers.
      // The mod checks the query first and decodes %XX back to exact bytes.
      return wrapResult(
        await apiPost("/writeCFG", { content: args.content || "" }),
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

    default:
      return errorResult("unknown tool: " + toolName);
  }
}

// ---- Main ----
// Use raw stdin instead of readline — on Windows pipes, readline may not
// emit "line" events reliably when the parent process keeps stdin open.

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
        serverInfo: { name: "bind-alias-plus-mcp", version: "2.0.0" },
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
