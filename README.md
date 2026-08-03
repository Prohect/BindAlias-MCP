# BindAlias MCP

MCP bridge for the [BindAlias](https://github.com/Prohect/BindAlias) Minecraft mod. Lets AI agents control Minecraft: query game state, take screenshots, execute aliases, manage recipes, read/write notes, and edit the per-save agent config.

## Prerequisites

- [Minecraft](https://www.minecraft.net) with the [BindAlias](https://github.com/Prohect/BindAlias) mod loaded
- The mod's HTTP API enabled (listens on `127.0.0.1:25575` by default, with automatic port fallback)

## Install in Zed

Add to your `settings.json`:

```json
{
  "context_servers": {
    "bind-alias": {
      "command": {
        "path": "npx",
        "args": ["bind-alias-mcp"]
      }
    }
  }
}
```

Or with a local checkout:

```json
{
  "context_servers": {
    "bind-alias": {
      "command": {
        "path": "node",
        "args": ["path/to/BindAlias-MCP/mcp_server.js"]
      }
    }
  }
}
```

Use `--port N` to match a non-default mod port:

```json
"args": ["path/to/BindAlias-MCP/mcp_server.js", "--port", "25576"]
```

Zed spawns MCP servers at startup — reload Zed (`zed-reload`) after editing to pick up the new server.

## Install via CLI

```bash
npx bind-alias-mcp
# or globally
npm install -g bind-alias-mcp
```

The server speaks MCP on stdio. Point any MCP client at it.

## Tools

| Tool            | What it does                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `getFullState`  | Full game state snapshot — screen, world, dimension, player pos/rot, health, hotbar, inventory, effects, nearby players, plus drained chat/mod/sound/recipe messages |
| `getScreenshot` | Take a screenshot, return as base64 PNG with the standard state envelope                                         |
| `runAlias`      | Execute a chain of aliases. Optional `nap` (client ticks) defers the response while the game keeps running.      |
| `defineAlias`   | Define a new alias at runtime (requires being in a world).                                                       |
| `readCFG`       | Read the per-save agent config (`saves/<save>/bind-alias/agent.cfg`). Requires being in a singleplayer world.   |
| `writeCFG`      | Overwrite the per-save agent config and reload. Requires being in a singleplayer world.                         |
| `readNotes`     | Read a file from the per-save agent directory (`saves/<save>/bind-alias/`). Plain filenames only, no paths.     |
| `writeNotes`    | Write a file to the per-save agent directory. Plain filenames only, no paths.                                   |
| `listRecipes`   | List unlocked recipes (diff or by query). Only works with a recipe-book screen open (inventory, crafting table, furnace, …). |

The tool descriptions only cover the wire protocol — see the [mod docs](https://github.com/Prohect/BindAlias) and the [system prompt patch](#agent-system-prompt-patch) for the full alias reference.

## Agent system prompt patch

The tool descriptions this server advertises only cover the wire protocol — the fixed facts the tools themselves must know. The gameplay knowledge (the full alias catalog, screens, variables, per-world cfg semantics) changes with the mod and your world, so it lives separately in a flexible patch:

- [`PATCH TO YOUR PROJECT RULE.md`](PATCH%20TO%20YOUR%20PROJECT%20RULE.md) — paste this into your agent's system prompt / project rules (e.g. Zed's `AGENTS.md`) to teach it how to drive the game.

## Related

- [BindAlias mod](https://github.com/Prohect/BindAlias) — the Minecraft mod this server bridges to
- [MCP Registry](https://registry.modelcontextprotocol.io) — registered as `io.github.Prohect/bind-alias-mcp`
