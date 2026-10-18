# Decks: instructions for AI agents

Your person has asked you to help edit presentations on their decks service
(the host that sent you here — `DECKS_ORIGIN` or the connector's embedded
address). You act for them: you can open and edit exactly the decks shared
with their Google account, at most as an editor. These steps work on Windows,
macOS and Linux, and with any agent that can run shell commands, whatever the
model.

## 1. Check for Node.js

Run `node --version`. It needs to be 18 or newer. If it's missing, ask your
person before installing it: https://nodejs.org (or `winget install OpenJS.NodeJS.LTS`
on Windows, `brew install node` on macOS, your package manager on Linux).

## 2. Download the connector

Save the connector from this host into your person's home folder (below,
`HOST` is the address of the decks service that sent you here):

- macOS or Linux: `curl -fsSL HOST/agents/decks-agent.mjs -o ~/decks-agent.mjs`
- Windows (PowerShell): `Invoke-WebRequest HOST/agents/decks-agent.mjs -OutFile $HOME\decks-agent.mjs`

Below, `CONNECTOR` means the full path of that file, for example
`/Users/ana/decks-agent.mjs` or `C:\Users\ana\decks-agent.mjs`.

## 3. Sign in as your person (once per machine)

Run `node CONNECTOR login`. It prints a short code and https://www.google.com/device.
Show both to your person and ask them to open the link, sign in with the Google
account the decks were shared with, and enter the code. The command finishes by
itself once they approve. Then `node CONNECTOR decks` lists the decks you can reach.

## 4. Use it

**If you can add MCP servers** (Claude Code, Codex, OpenCode, Cursor, the Claude
desktop app and most others), add a local stdio server named `decks` with command
`node` and arguments `CONNECTOR` and `mcp`. The usual JSON form is:

```json
{ "mcpServers": { "decks": { "command": "node", "args": ["CONNECTOR", "mcp"] } } }
```

Or by command: `claude mcp add decks -- node CONNECTOR mcp`, or
`codex mcp add decks -- node CONNECTOR mcp`. On Windows, write the path in JSON
with forward slashes or doubled backslashes. Restart or reload your MCP servers.

**If you can run commands but not add MCP servers**, call the tools directly:

```sh
node CONNECTOR tools
node CONNECTOR call list_decks
node CONNECTOR call read_slide documentId=DOC slide=title locale=en
node CONNECTOR call update_catalog_text documentId=DOC locale=en key=KEY "expectedCurrent=OLD TEXT" "value=NEW TEXT"
```

**If you can't run commands at all** (a plain chat window), stop here and tell
your person: they can edit directly in their browser at the decks service, and
you can help by drafting the new wording for them to paste in.

If you work in a sandbox with limited internet access, it must reach the decks
service host, oauth2.googleapis.com and www.google.com.

## Tools

- `list_decks`: decks shared with your person, with document IDs and your role.
- `create_deck`: create a new deck owned by your person — a bilingual (EN+JA)
  starter deck with its own private copy of the theme, whose guidance and
  tokens your person may edit freely. Returns the documentId and URLs.
- `get_presentation`: title, slide order and languages of one deck.
- `read_slide`: one slide's HTML and its text keys in a language.
- `read_styles`: the deck's stylesheets, to reuse its classes and colour tokens.
- `update_catalog_text`: replace the text of one key.
- `write_slide`: create or rewrite a slide (a full HTML document with its text
  in `strings`); new slides go at `position` (0 = first).
- `set_slide_order`: reorder slides, or leave some out to remove them.
- `read_guidance` / `write_guidance`: the design guidance the editor checks against.
- `write_editor_tool`: add a button to the browser editor's tool sidebar for your
  person; each person must enable it before it runs.

Every deck tool takes the `documentId` from `list_decks`. Slides can include
`<style>` blocks; scripts don't run.

## Policy

- **Other people's edits win.** You may change anything your own person edited,
  but text or elements edited by anyone else are protected: the server refuses
  to change them, and a slide holding them can't be removed. Everything else is
  yours to change. Don't work around the protection; tell your person what you
  would change and let them decide.
- Decks are usually bilingual (English and Japanese). When you change text,
  change it in every language the deck has. Japanese should be friendly,
  polite and plain; keep names and product names in Latin script.
- Read before you write. Pass the exact text you read as `expectedCurrent`. If
  someone changed it meanwhile, read the slide again instead of retrying blindly.
- Change one piece of text at a time and tell your person what you changed.
  Collaborators see your edits live.
- You only have your person's access. If a deck is missing, ask them to have it
  shared with their Google account.
- Your person's email is used only to sign in and show who edited what; see the
  decks service's privacy policy for details.
