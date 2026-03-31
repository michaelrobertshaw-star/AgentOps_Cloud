# Pre-configured Connectors

## Claude API (claude_api)
- **ANTHROPIC_API_KEY**: Already in apps/server/.env
- **Default model**: claude-sonnet-4-6
- **Browser/computer-use model**: claude-3-5-sonnet-20241022 (required for computer-use beta)

## Claude Browser (claude_browser)
- Uses Playwright + claude-3-5-sonnet computer-use beta
- Install: `pnpm add playwright @anthropic-ai/sdk` in apps/server
- Requires: ANTHROPIC_API_KEY (above)

## When building M6.3 connector registry:
1. The connectors table stores type, name, config (jsonb), secrets_encrypted (AES-256-GCM)
2. At execution time, decrypt secrets and inject into the Claude SDK call
3. ANTHROPIC_API_KEY is the secret field for claude_api connector type
4. Seed a default "Claude Sonnet" connector on first company setup using the env key
