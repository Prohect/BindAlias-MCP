# BindAliasPlus MCP

MCP stdio bridge for the [BindAliasPlus](https://github.com/Prohect/BindAliasPlus) Minecraft mod. Connects AI agents (Zed, Claude Desktop, etc.) to a running Minecraft instance, letting them query game state, take screenshots, execute aliases, and edit the mod's config file — all through the Model Context Protocol.

## Prerequisites

- **Node.js** (runtime for the bridge)
- **Minecraft** with the [BindAliasPlus](https://github.com/Prohect/BindAliasPlus) mod loaded and its MCP HTTP server enabled (listens on `127.0.0.1:25575`)

## Quick Start

```bash
node mcp_server.js
```

The server starts, writes a `.mcp_startup` marker in its directory, and waits for JSON-RPC on stdin. It speaks MCP protocol version `2024-11-05`.

## Tools

| Tool | Description |
|---|---|
| `getState` | Snapshot of current game state: screen, world, dimension, player position/rotation, health, held item (registry name, count, hotbar slot). |
| `getScreenshot` | Trigger a native F2 screenshot, wait for the file, return it as a base64 PNG (plus path and filename). |
| `runAlias` | Execute a registered BindAliasPlus alias. Some aliases take backslash-separated arguments (`\`). |
| `defineAlias` | Define a new alias via `/alias` command (requires being in a world). |
| `readCFG` | Read the raw content of `bind-alias-plus.cfg`. |
| `writeCFG` | Overwrite `bind-alias-plus.cfg` with new content and reload it. |

### Aliases Without Arguments

`+attack` `-attack` `+use` `-use` `+forward` `-forward` `+back` `-back` `+left` `-left` `+right` `-right` `+jump` `-jump` `+sneak` `-sneak` `+sprint` `-sprint` `+drop` `-drop` `+screenshot` `-screenshot` `+playerList` `-playerList` `+advancements` `-advancements` `+debugOverlay` `-debugOverlay` `+openInventory` `-openInventory` `+silent` `-silent` `cyclePerspective` `swapHand` `pickItem` `toggleInventory` `reloadCFG` `unloadCFGAliases` `unloadCFGBinds` `unloadCFGVars` `unloadCFGAll` `builtinShutdown` `FPS` `TPS` `TPS2` `esc` `closeScreen`

### Aliases With Arguments

| Alias | Args syntax |
|---|---|
| `slot` | `\<1-9>` — switch hotbar slot |
| `log` | `\<message>` — log to game console |
| `say` | `\<message>` — send chat message |
| `localSay` | `\<message>` — client-side only message |
| `sendCommand` | `\<command>` — send command (spaces preserved) |
| `alias` | `\<name>\<definition>` — define a new alias |
| `swapSlot` | `\<slot1>\<slot2>` or `\<slot1>` — swap inventory slots (1–9 hotbar, 10–36 inv, 37–40 armor, 41 offhand) |
| `wait` | `\<ticks>` — pause N ticks (20 ticks = 1 second) |
| `yaw` | `\<degrees>` — rotate yaw relative |
| `pitch` | `\<degrees>` — rotate pitch relative |
| `setYaw` | `\<degrees>` — set absolute yaw (0=north, 90=east, 180=south) |
| `setPitch` | `\<degrees>` — set absolute pitch (−90=up, 90=down) |
| `var` | `\<varName>\<source>` — store value (sources: `hotbarSlot`, `pitch`, `yaw`, `itemsOfSlot0–9`, `number`) |
| `builtinRunAlias` | `\<aliasName>` — execute another alias by name |
| `reapply` | `\<action>` — re-assert held key (`forward`, `attack`, `use`, `back`, `left`, `right`, `jump`, `sneak`, `sprint`, `drop`, `openInventory`) |
| `bind` | `\<key>\<definition>` — bind a key to alias definition(s) |
| `unbind` | `\<key>` — unbind a key |
| `+lockKey` | `\<action>` — lock a game key (e.g. `gameKey:attack`, `gameKey:use`) |
| `-lockKey` | `\<action>` — unlock a previously locked key/alias |

## MCP Client Configuration (Zed)

Add to your Zed `settings.json`:

```json
{
  "context_servers": {
    "bind-alias-plus": {
      "command": {
        "path": "node",
        "args": [
          "F:/source/BindAliasPlus-MCP/mcp_server.js"
        ]
      }
    }
  }
}
```

Adjust the `args` path to match your local checkout.

## API Endpoints (Mod Side)

The server makes HTTP requests to the mod at `http://127.0.0.1:25575`:

| Endpoint | Method | Description |
|---|---|---|
| `/state` | GET | Return game state JSON |
| `/screenshot` | GET | Trigger screenshot, return base64 PNG |
| `/runAlias` | POST | Execute alias (query params: `name`, optional `args`) |
| `/defineAlias` | POST | Define alias (query params: `name`, `def`) |
| `/readCFG` | GET | Read config file contents |
| `/writeCFG` | POST | Write config file (JSON body: `{"content":"..."}`) |

## Troubleshooting

**Server won't start / Zed handshake times out**

Check that the `.mcp_startup` file was created in the server directory. If missing, Node.js may not be in `PATH` — verify with `node --version`.

**Stderr (diagnostic) output**

The server writes diagnostic messages to stderr (fd 2), including startup confirmation, raw stdin chunks, and fatal errors. In Zed, these appear in the language server log (`Toggle Language Server Logs` from the command palette).

**"Cannot connect to mod"**

Make sure Minecraft is running with BindAliasPlus loaded and the HTTP server active on port `25575`. The mod must be in a world (not on the title screen) for most operations.

**Buffered stdout on Windows**

This server uses `fs.writeSync(fd=1)` instead of `process.stdout.write()` to avoid Windows pipe buffering issues that can cause MCP initialization timeouts.
