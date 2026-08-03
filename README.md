# BindAlias MCP

MCP bridge for the [BindAlias](https://github.com/Prohect/BindAlias) Minecraft mod. Lets AI agents control Minecraft: query game state, take screenshots, execute aliases, and edit the mod config.

## Prerequisites

- [Minecraft](https://www.minecraft.net) with the [BindAlias](https://github.com/Prohect/BindAlias) mod loaded
- The mod's HTTP API enabled (listens on `127.0.0.1:25575`)

## Install in Zed

Add to your `settings.json`:

```json
{
  "context_servers": {
    "bind-alias": {
      "command": {
        "path": "<[npx]|[<<path_to>node.exe>]>",
        "args": ["<<path_to>BindAlias-MCP/mcp_server.js>"]
      }
    }
  }
}
```

## Install via CLI

```bash
npx bind-alias-mcp
# or globally
npm install -g bind-alias-mcp
```

The server speaks MCP on stdio. Point any MCP client at it.

## Tools

| Tool | What it does |
|---|---|
| `getFullState` | Game state snapshot: screen, world, dimension, player pos/rot, health, held item |
| `getScreenshot` | Trigger F2 screenshot, return as base64 PNG |
| `runAlias` | Execute a BindAlias alias (34+ argless, 18 with args) |
| `defineAlias` | Define a new alias (requires being in a world) |
| `readCFG` | Read `bind-alias.cfg` contents |
| `writeCFG` | Overwrite `bind-alias.cfg` and reload |

The tool descriptions only cover the wire protocol — see the [mod docs](https://github.com/Prohect/BindAlias) and the [system prompt patch](#agent-system-prompt-patch) for the full alias reference.

## Agent system prompt patch

The tool descriptions this server advertises only cover the wire protocol — the fixed facts the tools themselves must know. The gameplay knowledge (the full alias catalog, screens, variables, per-world cfg semantics) changes with the mod and your world, so it lives separately in a flexible patch:

- [`PATCH TO YOUR PROJECT RULE.md`](PATCH%20TO%20YOUR%20PROJECT%20RULE.md) — paste this into your agent's system prompt / project rules (e.g. Zed's `AGENTS.md`) to teach it how to drive the game.

## Related

- [BindAlias mod](https://github.com/Prohect/BindAlias) — the Minecraft mod this server bridges to
- [MCP Registry](https://registry.modelcontextprotocol.io) — registered as `io.github.Prohect/bind-alias-mcp`
