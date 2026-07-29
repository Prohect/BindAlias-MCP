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
// Response envelope + state field reference (shared by all game tools).
// ===========================================================================

const ENVELOPE_DOC =
  'RESPONSE ENVELOPE — every game tool (all except readCFG) answers with the same JSON object: {"tick":N, "state":{...}, "chat":[...], "mod":[...], "sound":[...], "recipe":[...]}. ' +
  "Rules: (1) tick = client ticks since world join, -1 when not in a world. " +
  "(2) state holds game state fields; getState returns the FULL snapshot, every other tool returns only fields CHANGED since the previous tool response (a field set to null means it disappeared, e.g. the container screen was closed); state is omitted when nothing changed; held_keys is the exception — it is present in EVERY response while non-empty. All state info is also visible on the vanilla HUD or the open screen — never hidden/debug data. " +
  "(3) chat/mod/sound/recipe are message channels drained on every response: each message is delivered exactly once, in the first response after it arrived; a channel is omitted when it has no new messages. " +
  "chat = game chat (server/system/player messages). mod = BindAliasPlus mod log (alias feedback, errors, log\\ messages). " +
  "sound = sound events, the ones vanilla subtitles would show, but with precise 3D direction and distance: '[tick:<tick>] <subtitle> [yaw<±N> pitch<±N> <dist>m]' (e.g. '[tick:123] Zombie groans [yaw-40 pitch+20 4.2m]' — direction is the yaw/pitch relative to your view at the moment the sound was heard, rounded to 20° steps, so yaw\\<relYaw> turns you onto the source; 'here <dist>m' for sounds at your own position); repeats of the same sound coalesce with ' xN' (even when interleaved with other sounds). " +
  "recipe = newly unlocked recipes (result item locale names).";

const STATE_FIELDS_DOC =
  "STATE FIELDS (snake_case): world_name; dimension (e.g. 'minecraft:overworld'); screen (simple class name of the open screen, e.g. 'InventoryScreen'/'FurnaceScreen', null = in-game HUD); " +
  "pos {x,y,z,yaw,pitch,feet} with feet one of on_ground|midair|in_water|in_lava|in_powder_snow|fall_flying; health; absorption (only when >0); hunger (0-20); saturation; armor; xp {level,percent}; " +
  "effects ['Speed II (0:12)']; target {kind:block|entity|player, name (locale name), distance} — the vanilla crosshair target; " +
  "players ['Steve [yaw+40 pitch-0 12.5m]'] (other players in the world, locator-bar style, same relative-direction format as the sound channel, nearest first); " +
  "held_keys ['+attack','+forward'] (builtin boolean aliases currently held — automatically re-applied after screen transitions, so they may (re)appear at any time); " +
  "held_item + held_item_count; selected_hotbar_slot (1-9); durability {remaining,max} (selected item, when damageable); hotbar [{slot:1-9,name,count}] (occupied slots only) + hotbar_empty (range-compressed empty hotbar slots, e.g. '1-2 5-9'; omitted when none empty); " +
  "container (only while a container screen is open) {inventory_items:[{index,item,name,count,...}], empty_inv:'1-9 10-36', container_grid:[rows]} — full on getState / open / menu change; afterwards the container member diffs at SLOT granularity: inventory_items lists only changed slots ({\"index\":K,\"item\":null} = that slot became empty), and empty_inv / container_grid re-send only when changed. inventory_items index is a swapSlot argument: 1-41 player inventory or 'cNN' container slot; optional members durability/enchanted:true/tooltip appear only when relevant (tooltip only when it shows more than the item name — a plain unnamed stone has none). " +
  "container_grid is an ASCII layout of the container slots: runs of adjacent slots share one '|c01:* c02:o|' group (* = occupied, o = empty), blank cells are plain padding, every row ends with \\n; cNN matches swapSlot's c<N> addressing.";

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
  "SILENT FAILURES: misspelled names and bad args are skipped silently (runAlias still returns ok) — verify with getState, getScreenshot, or the state/channels returned in the response envelope.",
  "DETERMINISM: the host injects no physical input — state changes come only from your chains or game logic, so held keys behave exactly as vanilla and screens change only from your chains or game events (e.g. death).",
  'TIMING: wait\\N defers the rest of the chain by N ticks; runAlias returns immediately without waiting chain of alias done. At default speed keep time-sensitive steps in ONE runAlias call (inter-call latency is unpredictable); at a low tick rate (sendCommand\\"tick rate 1") an observe->reason->react cycle costs low ticks, so steps spread across calls — and keys held between calls — could stay predictable.',
  "RELEASE RULE: +x persists until -x, across tool calls and screen transitions. Held states re-fire their press action whenever a screen closes and the cursor re-grabs. Release when the effect should stop; one-shot keys right after press: '+advancements wait\\1 -advancements'. Watch the held_keys state field to see what is currently held.",
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
  "applyRecipe\\query — place an unlocked, craftable recipe into the crafting grid of the open recipe menu (inventory / crafting table / furnace), like clicking it in the recipe book; NO crafting is performed (take the result afterwards, e.g. swapSlot\\c1\\10 for the crafting table). query = result-item id ('minecraft:torch' or 'torch') or a case-insensitive locale-name substring ('iron sword'). Errors (no recipe menu open / not unlocked / missing ingredients) go to the local game chat (chat channel). See also the listRecipes tool",
  "say\\text — send a chat message to the server",
  "localSay\\text — client-side-only chat message (never sent)",
  "sendCommand\\cmd — run a server command (no leading slash)",
  "log\\text — append a line to the game log (comes back via the mod channel of the response)",
  "var\\name\\source — store a number for use as an arg. sources: hotbarSlot, yaw, pitch, itemsOfSlot0-9 (0=offhand, 1-9=hotbar) (stack count), a literal number, or specially c<N> which is in a different map that only swapSlot could access as a container-slot reference.",
  'alias\\"name definition..." — define an alias from inside a chain (one quoted arg, or \';\' as space — NESTING). Prefer the defineAlias tool if you dont need dynamic alias definitions',
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
  ". RETURNS the standard envelope (full reference in the getState description): the state diff is captured BEFORE execution; message channels are drained AFTER the immediate part of the chain ran, so log\\ and chat feedback inside the chain arrives with this response; deferred effects (after wait\\N) show up in later responses.";

const TOOLS = [
  {
    name: "getState",
    description:
      "Get a full snapshot of the current game state and drain all message channels. " +
      ENVELOPE_DOC +
      " " +
      STATE_FIELDS_DOC +
      " Prefer reading the incremental state diffs attached to every other tool response over polling getState repeatedly.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "getScreenshot",
    description:
      "Take an immediate in-game screenshot and return it as a PNG image, plus the standard envelope as text (see the getState description). Fails when not in a world.",
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
        nap: {
          type: "number",
          description:
            "Take a nap: seconds (float, 0.0-60.0) to keep waiting after the immediate game response before returning — gives deferred chain effects (after wait\\N) time to land in this response's channels and lets you pace calls without an external sleep. WARNING: the game keeps running while you nap — the response snapshot/channels were captured BEFORE the nap, and you cannot react to anything happening during it (mobs approaching, deferred chains firing, other actors acting) until this call returns; keep naps short in dangerous situations.",
        },
      },
      required: ["def"],
    },
  },
  {
    name: "defineAlias",
    description:
      "Define a new alias (macro) through the game's real /alias command. The game's feedback line (e.g. 'Alias x = ...' or 'Can't replace builtinAlias x') is delivered in the response's chat channel. " +
      "'def' uses the exact same chain syntax as runAlias (space-separated chain, backslash for args, " +
      '\\"-quoted multi-word args like say\\"hi all"). Alias names must be single words and cannot overwrite ' +
      "builtin or predefined aliases (+attack, slot, ...). Must be in a world (not on the title screen). " +
      "Returns the standard envelope (see the getState description).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Alias name to create (single word).",
        },
        def: {
          type: "string",
          description: "Alias definition string (chain syntax, same as runAlias).",
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
      "Returns the standard envelope — the reload log lines arrive via the mod channel (see the getState description).",
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
      "List recipes unlocked in the recipe book. Only works while a recipe-book screen is open (player inventory via +openInventory, crafting table, furnace, ...). " +
      "Without 'queries': returns recipes learned since the previous listRecipes call (a diff — the first call after joining the world returns everything). " +
      "With 'queries' (result-item ids like 'minecraft:torch' or 'torch', or locale-name substrings like 'iron sword'): every query is answered independently — matches land in 'recipes', per-query failures in 'recipe_errors' (one bad query never eats valid results). " +
      "Entries: {name, item, craftable}. craftable=true means the ingredients are in your inventory right now — place the recipe into the crafting grid with the applyRecipe alias (see runAlias). " +
      "Returns the standard envelope plus recipes/recipe_errors (see the getState description).",
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
      const result = await apiPost("/runAlias", { def: args.def || "" });
      if (result.error) return wrapResult(result);
      // Take a nap (seconds, float) before returning
      const nap = Number(args.nap);
      if (Number.isFinite(nap) && nap > 0 && nap <= 60) {
        await new Promise((resolve) => setTimeout(resolve, nap * 1000));
      }
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
