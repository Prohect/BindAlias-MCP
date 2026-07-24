# BindAliasPlus MCP

MCP bridge for the [BindAliasPlus](https://github.com/Prohect/BindAliasPlus) Minecraft mod. Lets AI agents control Minecraft: query game state, take screenshots, execute aliases, and edit the mod config.

## Prerequisites

- [Minecraft](https://www.minecraft.net) with the [BindAliasPlus](https://github.com/Prohect/BindAliasPlus) mod loaded
- The mod's HTTP API enabled (listens on `127.0.0.1:25575`)

## Install in Zed

Add to your `settings.json`:

```json
{
  "context_servers": {
    "bind-alias-plus": {
      "command": {
        "path": "<[npx]|[<<path_to>node.exe>>]",
        "args": ["<<path_to>BindAliasPlus-MCP/mcp_server.js>"]
      }
    }
  }
}
```

## Install via CLI

```bash
npx bind-alias-plus-mcp
# or globally
npm install -g bind-alias-plus-mcp
```

The server speaks MCP on stdio. Point any MCP client at it.

## Tools

| Tool | What it does |
|---|---|
| `getState` | Game state snapshot: screen, world, dimension, player pos/rot, health, held item |
| `getScreenshot` | Trigger F2 screenshot, return as base64 PNG |
| `runAlias` | Execute a BindAliasPlus alias (34+ argless, 18 with args) |
| `defineAlias` | Define a new alias (requires being in a world) |
| `readCFG` | Read `bind-alias-plus.cfg` contents |
| `writeCFG` | Overwrite `bind-alias-plus.cfg` and reload |

See `runAlias` description for full alias reference, or the [mod docs](https://github.com/Prohect/BindAliasPlus).

## Related

- [BindAliasPlus mod](https://github.com/Prohect/BindAliasPlus) — the Minecraft mod this server bridges to
- [MCP Registry](https://registry.modelcontextprotocol.io) — registered as `io.github.Prohect/bind-alias-plus-mcp`
