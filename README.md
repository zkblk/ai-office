# Devies AI Office

Web-first visual workspace for AI agents.

## Baseline strategy

We keep both upstream forks intact and build from working systems instead of reimplementing their animation.

- **zkblk/pixel-agents** — Claude Office visual baseline: isometric room, directional sprites, desks, coffee/water breaks, events, day/night and working simulation. The public AI Office deployment is built directly from this fork.
- **zkblk/claude-office** — Pixel Agents runtime foundation: agent-agnostic HookProvider architecture, standalone server, Claude Code detection, Canvas office/layout editor, typed AgentEvent runtime. This is the connector/runtime source for the Devies product.
- **zkblk/ai-office** — product/deployment repository. The previous hand-built prototype is preserved on branch `prototype-old`.

## Product direction

Keep the proven Claude Office scene behavior intact. Integrate Pixel Agents runtime/providers behind it through a normalized event boundary. Then add Devies building/floor/room navigation, agent inspector, model/token/skill telemetry, and multi-user relay without sending source code, prompts, terminal output or chain-of-thought.

## Security

Metadata-only by default. Explicit allowlist for provider/model/status/task alias/token counters/skill IDs and project aliases.
