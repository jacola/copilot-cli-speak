# Copilot CLI Speak

A personal GitHub Copilot CLI extension that speaks a short summary when the
agent finishes a turn, using local Ollama Phonon.

Copilot itself writes the speech-friendly summary while answering. Phonon
converts that text to audio; no second language model summarizes the response.
The spoken summary can differ from the visible final answer.

## Requirements

- macOS on Apple Silicon. Playback currently uses macOS `afplay`.
- GitHub Copilot CLI with experimental extensions enabled. Tested with
  CLI build `1.0.113-1`; extension APIs are experimental.
- Node.js 20.3 or later for installation and tests.
- Ollama 0.40.9 or later, running locally on port 11434.
- The `phonon` model package, including its named voices.

## Install

```sh
git clone https://github.com/jacola/copilot-cli-speak.git
cd copilot-cli-speak
ollama pull phonon
npm run install:extension
copilot --experimental
```

In Copilot, run `/speak on` when you want spoken summaries for that session.

Ollama must be running; start it using your normal Ollama service or
`ollama serve`. No `npm install` is needed: there are no package dependencies,
and Copilot supplies the extension SDK.

The installer copies the three extension modules to
`~/.copilot/extensions/spoken-summary/`, or beneath `COPILOT_HOME` when set.
It preserves existing preferences. This is a user-scoped installation across
projects, not a repository-local extension.

For an already-open Copilot CLI instance, use `/restart` to load the update.
Repeat `npm run install:extension` after changing the source in this repository.
The installed extension is a copy, not a live link to the checkout.

## Commands

| Command | Action |
| --- | --- |
| `/speak` or `/speak status` | Show current settings |
| `/speak on` | Enable spoken summaries for this session |
| `/speak off` | Mute spoken summaries for this session |
| `/speak stop` | Stop speech without changing this session's mute setting |
| `/speak test` | Play a sample using the current voice and speed |
| `/speak voice` | Open the voice picker |
| `/speak voice Freya` | Select a voice directly |
| `/speak voices` | List the installed Phonon voices |
| `/speak speed` | Show current settings |
| `/speak speed 1.4` | Set playback speed; `1.4x` also works |
| `/speak help` | Show available subcommands |

`/voice` remains reserved for Copilot's own dictation feature. Hosts without
interactive form support display the voice names and direct-selection syntax
instead of opening a picker.
The former `/voice-name`, `/voice-list`, and `/voice-speed` commands have been
replaced by the `/speak` subcommands above.

## Behavior and settings

Speech starts off in every new session. Use `/speak on` to enable it for that
session only; `/speak off` mutes it again. The on/off state is not saved or
shared with other sessions. Reloading the extension also resets speech to off.

The default voice and playback speed are Freya and 1.4x. These preferences are
saved in `settings.json` beside the installed extension, shared across projects.
Each session refreshes them when a new user prompt is submitted or a voice
command is run. Old saved `enabled` values are ignored.

The extension asks Copilot to queue one or two plain-text sentences, at most
50 words, before the final answer. It asks for outcomes, blockers, or questions
and tells the model not to include code, secrets, URLs, or Markdown. This is
model guidance, not a content sanitizer. The queue checks for nonempty text and
a maximum of 600 characters.

Only the queued summary is sent to the local speech endpoint, not the full
conversation. This does not change how Copilot's main model is hosted or
authenticated.

Speech starts at the top-level agent's natural stop. If the agent forgets to
queue a summary, the stop hook asks it once to do so. New prompts cancel
outstanding synthesis or playback. Speed adjustment is applied locally by
`afplay`, not sent to Ollama. Temporary audio is removed after playback or
cancellation; speech errors are shown as warnings.

## Development

```sh
npm run check
npm test
```

Tests use fake speech responses and playback, plus temporary settings and
installation directories. They do not call Ollama, use a microphone, play
audio, or make paid Copilot requests.

The source files are `extension.mjs` (SDK integration and slash commands),
`speech.mjs` (synthesis and playback lifecycle), and `settings.mjs`
(preferences). Local settings, generated audio, and dependencies are excluded
from Git.
