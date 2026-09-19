# AI Office

A web-first, agent-agnostic visual workspace for live AI agent activity.

## MVP
- Pixel-office product shell
- Agent inspector
- Normalized telemetry model
- Codex + Claude Code connectors (next)
- Metadata-only security boundary

## Run
```bash
npm install
npm run dev
```

## Security principle
The shared office accepts allowlisted metadata only. No source code, prompts, terminal output, secrets, or chain-of-thought.

## Architecture
Local connectors -> normalized AgentEvent -> event server/WebSocket -> web office.

This first commit contains the interactive web shell with simulated agents. Runtime connectors and server transport are the next implementation slice.
