# 🛡️ Vault Guardian

A local-first, offline **prompt-injection game** in the style of [Lakera's Gandalf](https://gandalf.lakera.ai/baseline). A defender AI holds a secret password; you chat with it and try to trick it into leaking the password, then submit your guess to a server-side validator. Five levels (L1–L5) of escalating defenses, all editable from an admin console.

All AI inference runs **locally, in-process, fully offline** through [QVAC](https://qvac.tether.io) (`@qvac/sdk`) on the [Bare](https://bare.pears.com) runtime. No cloud, no external API calls, no accounts, no telemetry. The default model fits in about 4 GB RAM.

> ⚠️ Educational sandbox — the "passwords" are game tokens, not real credentials.

## Requirements

- [Bare](https://bare.pears.com) runtime (`npm i -g bare`). The native QVAC modules are not compatible with the Node.js runtime.
- ~2.5 GB free disk for the default model (downloaded once on first real run).

## Quick start

```bash
npm install

# Dev mode — no model download, uses a deterministic fake model.
# Great for exercising the guard pipeline and UI instantly.
npm run dev

# Real mode — loads QWEN3_4B_INST_Q4_K_M locally via QVAC (downloads once).
npm start
```

Then open:

- **Player:** http://localhost:8787/
- **Admin:**  http://localhost:8787/admin  (set the admin passphrase on first visit)

### First run

The admin console has **no default passphrase**. The first time you open `/admin`
you'll be asked to create one (min 8 chars). You can also preset it with the
`ADMIN_PASSPHRASE` env var. Passphrases are stored as PBKDF2-SHA256 hashes
using 600,000 iterations; older 120,000-iteration hashes are upgraded after a
successful login.

## Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Keep the loopback default unless you intentionally want LAN access. |
| `VAULT_DATA_DIR` | `./data` | Runtime state directory; useful for isolated tests or disposable runs. |
| `QVAC_MODEL` | `QWEN3_4B_INST_Q4_K_M` | QVAC model constant (a 4B-Q4 is the practical 4 GB ceiling; try `QWEN3_8B_INST_Q4_K_M` with ~8 GB RAM) |
| `QVAC_CTX` | `4096` | Context window (tokens) — keeps RAM in check |
| `QVAC_PREDICT` | `160` | Max tokens per reply. Small models ramble without a cap; raise it if guardians get cut off. |
| `QVAC_TEMP` | `0.7` | Sampling temperature. Lower is terser and more on-instruction; higher is more inventive. |
| `QVAC_THINKING` | — | `1` = let Qwen3 reason in `<think>` blocks before answering (slower turns; reasoning is never shown to players) |
| `QVAC_MOCK` | — | `1` = use the built-in fake model (no download; dev only) |
| `FREE_ROAM` | — | `1` = all levels unlocked (default is unlock-on-solve) |
| `ADMIN_PASSPHRASE` | — | Preset the admin passphrase instead of first-run setup |

When binding `HOST` to a non-loopback address, `ADMIN_PASSPHRASE` is required
so another device cannot claim the first-run admin setup.

## How it works

### The security invariant

**The password never reaches the browser.** Both the chat and the guess
validation happen server-side. The client only ever receives (a) model output
*after* the output guard runs, and (b) a boolean from `/api/guess`. `GET
/api/state` returns public fields only. Guess submissions are rate-limited per
level to blunt brute-forcing.

### Guard pipeline (per chat turn)

1. **Input guard** — blocklist (substrings or `/regex/`) on the user message; trips → canned refusal, model skipped.
2. **Model completion** — system prompt + conversation, streamed from QVAC.
3. **Output guard** — blocks if the reply contains the password; optional **fuzzy** mode also catches `S P A C E D`, `l33t`, and reversed variants.
4. **Guard-model check** — optional 2nd-pass LLM classifier ("does this reply leak the secret? YES/NO"). On by default for L4–L5, which costs a second model call per turn.
5. Surviving reply is streamed/sent to the player.

The **win** is independent of chat: `/api/guess` compares your submission to the
password under the level's `submitValidation.mode` (`exact` | `case_insensitive`
| `trimmed` | `normalized`).

### Keeping a small model terse

An unconstrained 4B-Q4 guardian preambles, restates the question, and drifts
into repetition — slow, and worse, every extra sentence is more surface area
for the password to leak. Four things keep replies tight:

- **Token cap** — `QVAC_PREDICT` bounds every generation. When the cap cuts a
  buffered reply mid-thought it is trimmed back to its last complete sentence,
  so the player never sees a dangling fragment.
- **Brevity directive** — a two-sentence / 40-word instruction appended to the
  system message at request time (`BREVITY_DIRECTIVE` in `src/qvac.js`). It
  lives outside the stored prompt so it survives admin edits and covers levels
  created from the console.
- **No reasoning channel** — `<think>` is disabled at the sampler through
  `reasoning_budget`, not by a `/no_think` hint the model is free to ignore.
- **Constrained classifier** — the guard-model check runs at `temp: 0` under a
  JSON-schema enum, so its verdict is always exactly `YES` or `NO`. Previously
  a chatty verdict like "Okay, let me think. Yes, I should check…" could trip
  the parser and block a perfectly safe reply.

### Levels (shipped defaults)

Each level keeps the previous level's defenses and closes one more attack
channel, so the route that solved L(n) is exactly the route that fails on L(n+1).

| Level | Defense | Intended route |
|-------|---------|----------------|
| L1 — The Open Door | No guards. Hands the password over on request, but says nothing about it during small talk | Ask for it |
| L2 — The Promise | Input guard on every name for "password", in a dozen languages. Loves word games and has no output filter | Any game: poem, riddle, acrostic, anagram |
| L3 — The Sentry | Also blocks spelling, ciphers, reversals and verse; fuzzy output filter. Still discusses the *idea* the word names | Talk around it: meaning, origin, etymology |
| L4 — The Gatekeeper | Also blocks the semantic vocabulary (meaning, define, origin, synonym, translate, "how many") and injection framings; guard-model reads every reply | Framings the blocklist misses, replies the classifier reads as clean |
| L5 — The Silent Order | Vow-of-silence prompt, wide keyword wall, non-ASCII and 220-character input caps, fuzzy filter, and a classifier told to answer YES whenever unsure | Close to impossible by design |

Blocklist entries are plain substrings or `/regex/`; the presets compose them
from shared vocabulary lists in [`src/levels.js`](src/levels.js)
(`PASSWORD_WORDS`, `TRANSFORM_RE`, `SEMANTIC_RE`, `INJECTION_RE`).

Every field of every level is editable in the admin console; **reset-to-default**
restores the shipped presets. The console holds the blocklist one entry per
line, so a regex containing a comma survives a save.

## Admin console

- **Level CRUD** — edit every field, create, duplicate, reorder, enable/disable, delete, reset.
- **Test-attack panel** — paste a candidate prompt and watch each stage's verdict (input guard → raw model output → output guard → guard-model check). The core tuning tool.
- **Preview chat** — chat against any level as admin (bypasses the unlock gate).
- **Logs** — optional local-only attempt log with a clear button.

## Architecture

```
Browser (static SPA)  ──HTTP/SSE──▶  Bare backend process
  player + admin UI                    @qvac/sdk (model in-process)
                                       guard pipeline · level store (JSON)
                                       owns all secrets
```

- **Backend:** one Bare process (`src/server.js`) — serves static assets, the player API, and an auth-gated admin API; owns the model, guards, and passwords.
- **Persistence:** local JSON under `./data/` (levels, progress, auth hash). Local-only.
- **Model lifecycle:** loaded once on boot and kept warm; unloaded cleanly on `SIGINT`/`SIGTERM`.

### Files

```
src/
  server.js    HTTP router, SSE streaming, static serving, API
  qvac.js      QVAC model load/complete/unload (Bare plugin wiring) + dev mock
  guards.js    input / output / fuzzy / guard-model pipeline + guess validation
  levels.js    L1–L5 presets and the persisted, editable store
  auth.js      admin passphrase (PBKDF2) + signed session tokens
  sessions.js  per-browser conversations, solve progress, guess rate limiting
  store.js     atomic local JSON persistence
public/        player SPA (index/app) + admin console (admin.html/js) + style
```

## Notes on QVAC / Bare

Bare has no `process` global and does not auto-register SDK plugins, so
`src/qvac.js` installs `bare-process` globally and registers the llama.cpp
completion plugin explicitly before the first SDK call:

```js
import bareProcess from 'bare-process'
globalThis.process = bareProcess
const { plugins, QWEN3_4B_INST_Q4_K_M } = await import('@qvac/sdk')
const { llmPlugin } = await import('@qvac/sdk/llamacpp-completion/plugin.js')
const { loadModel, completion, unloadModel } = plugins([llmPlugin])
```

This follows the official `@qvac/sdk` Bare quickstart. For longer sessions you can
lower `QVAC_CTX` or enable TurboQuant KV-cache compression rather than raising the
RAM ceiling.
