# ElevenLabs official MCP in TEAMYRA

TEAMYRA connects to ElevenLabs' official hosted MCP server, not a browser automation page or a custom text-to-speech API. The canonical global endpoint is `https://api.us.elevenlabs.io/v1/mcp`; the public `api.elevenlabs.io` alias currently advertises OAuth resource metadata on `api.us`, which strict MCP clients reject as an origin mismatch.

The pinned `mcp-remote` dependency adapts the hosted HTTP/OAuth connection to TEAMYRA's existing shared stdio pool. Each account has its own pool entry, OAuth store and localhost callback port. No API key is required.

## One-time OAuth client publication

ElevenLabs advertises Client ID Metadata Documents (CIMD) and does not expose dynamic client registration. TEAMYRA therefore needs its own public HTTPS client metadata JSON before the first sign-in.

The prepared, non-secret document is `docs/oauth/elevenlabs-client.json`. Its `client_id` and the connector's `CLIENT_METADATA_URL` both point to:

`https://cdn.jsdelivr.net/gh/itsksrathore/TEAMYRA@main/docs/oauth/elevenlabs-client.json`

ElevenLabs requires `Content-Type: application/json`. The GitHub CDN serves the public JSON with that MIME type; a `raw.githubusercontent.com` URL serves it as `text/plain` and is rejected by the authorization page.

Publish only that document after the repository owner approves publication. It contains the app name and allowed localhost callbacks, with no account, key, token or client secret. If another HTTPS host is used, update the document's `client_id` and the connector URL together. Validate the hosted document against the actual ElevenLabs authorization page; a successful local test does not establish provider acceptance.

The connector checks that this document is available, matches its client ID, uses public-client authentication (`none`), and includes the selected callback before starting OAuth. A missing document is reported as setup required, not as a connected account. Ports 47681–47696 support up to 16 account profiles; each allocated port is persisted in its profile metadata.

## Connect and use

1. Restart TEAMYRA after installing the source changes.
2. Open **Agents → ElevenLabs MCP** and select **Connect** on the intended profile. This immediately opens browser OAuth authorization from the app.
3. Complete the official browser sign-in and confirm which account and workspace you authorize. **MCP Tools** opens the existing connection's tools; **Load tools** reuses its saved login.
4. After successful authentication, TEAMYRA discovers the actual available tool names and input schemas. Use a tool in the dialog or ask a TEAMYRA-connected coding agent to call it.

The app updates the dialog and Agents card as the connection changes. An already connected profile shows **Open**, which loads its saved connection; **Switch account** starts a new OAuth authorization. Connection state is refreshed from the shared pool after a desktop restart.

If browser authorization succeeds but the adapter's first initialize stalls, the connector detects newly saved OAuth credentials and reconnects that profile once automatically. The initial handshake has a 20-second deadline; browser authorization can still finish within its 240-second window. This recovery only repeats tool discovery, and never repeats a generation or switches profiles. Existing credentials, quota errors and other provider refusals do not trigger this recovery.

If a profile connected to the wrong account, switch to the intended account on ElevenLabs in the browser, then select **Connect** again (or **Connect / Login** inside its MCP dialog). This starts a fresh OAuth store for that profile, preserves the old store and opens the browser. A new local OAuth store does not clear browser cookies: ElevenLabs may automatically authorize the browser's existing account without showing an account picker. Other profiles keep their credentials. Separate local profiles do not by themselves prove separate ElevenLabs accounts.

The three configured local profiles map to these shared servers:

| Profile | Pool server |
| --- | --- |
| ElevenLabs 1 | `elevenlabs-elevenlabs-1` |
| ElevenLabs 2 | `elevenlabs-elevenlabs-2` |
| ElevenLabs 3 | `elevenlabs-elevenlabs-3` |

Agents use `teamyra.mcp_pool_tools` with `{"server":"elevenlabs-elevenlabs-1"}` to discover tools. ElevenLabs publishes about 160 tools with roughly 1.4 MB of input schemas, more than most MCP clients accept in one result, so this returns a compact list: each tool's name, a short description, its required arguments and its read-only/destructive hints. An agent then asks for the full input schemas of only the tools it will call, for example `{"server":"elevenlabs-elevenlabs-1","tool_names":["creative_list_voices","creative_generate_speech"]}`. `detail: "full"` returns every schema and is meant for the desktop dialog, not agents. Agents then use `teamyra.mcp_pool_call` with `server`, the discovered `tool_name`, and the tool's `arguments` object. Select an account explicitly. Quota rejection, authorization failure and an ambiguous network failure never switch accounts or automatically repeat a generation.

OAuth credentials stay in ignored `profiles/elevenlabs/<id>/oauth/` storage managed by the OAuth adapter. Pool configuration is under ignored `profiles/mcp-pool.json`. Do not commit either location. Accounts keep separate quotas; MCP does not pool free credits or change ElevenLabs' account rules.

## Verification

- `node --test apps/desktop/tests/elevenlabs-mcp.test.js`
- `python -m unittest discover -s tests -p test_elevenlabs_mcp_transport.py -v` (requires localhost networking)
- `npm run desktop:check`
- `npm --workspace @teamyra/desktop run build:renderer`

The transport tests run the actual installed adapter through TEAMYRA's pool using both Node and Electron's Node mode against a local HTTP MCP fixture. They do not use ElevenLabs accounts or credits. Real account authorization, available scopes, tool discovery and generated media require separate live verification.
