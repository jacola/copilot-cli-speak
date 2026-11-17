import { joinSession } from "@microsoft/copilot-sdk/extension";
import { createSpokenSummary } from "./speech.mjs";
import { readSettings, updateSettings } from "./settings.mjs";

const guidance =
    "Before your final answer, call queue_spoken_summary with a plain-text, " +
    "one- or two-sentence summary (at most 50 words) of the outcome, important " +
    "blockers, or question needing the user's input. Do not narrate tools, " +
    "include code, secrets, URLs, or Markdown, or claim unfinished work succeeded. " +
    "The summary plays automatically when your turn ends; keep your normal final answer.";

let settings = await readSettings();
let enabled = false;
const speech = createSpokenSummary({
    getSettings: () => ({ ...settings, enabled }),
    reportError: (message) => session.log(message, { level: "warning" }),
});

function status() {
    return `Spoken summaries: ${enabled ? "on" : "off"}; voice: ${settings.voice}; speed: ${settings.speed}x.`;
}

async function voices() {
    const response = await fetch("http://127.0.0.1:11434/api/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "phonon" }),
        signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Ollama voice list returned HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.voices) || !result.voices.every((voice) => typeof voice === "string")) {
        throw new Error("Ollama returned an invalid voice list");
    }
    return result.voices;
}

function command(name, description, handler) {
    return {
        name,
        description,
        handler: async ({ args }) => {
            try {
                settings = await readSettings();
                await handler(args.trim());
            } catch (error) {
                await session.log(error.message, { level: "warning" });
            }
        },
    };
}

async function selectVoice(args) {
    const available = await voices();
    if (!args) {
        if (!session.capabilities.ui?.elicitation) {
            await session.log(`Available voices:\n${available.join("\n")}\nChoose with /speak voice <name>.`);
            return;
        }
        const result = await session.ui.elicitation({
            message: "Choose a voice for spoken summaries.",
            requestedSchema: {
                type: "object",
                properties: {
                    voice: {
                        type: "string",
                        title: "Voice",
                        enum: available,
                        default: settings.voice,
                    },
                },
                required: ["voice"],
            },
        });
        if (result.action !== "accept") return;
        args = result.content?.voice;
    }
    const voice = typeof args === "string"
        ? available.find((name) => name.toLowerCase() === args.toLowerCase())
        : undefined;
    if (!voice) throw new Error("Unknown voice. Use /speak voices to see available voices.");
    settings = await updateSettings({ voice });
    await session.log(status());
}

const usage = "Usage: /speak [on|off|status|test|stop|voice [name]|voices|speed [number]|help]";

const session = await joinSession({
    interaction: {
        commands: [
            command("speak", "Spoken summaries: on, off, voice, voices, speed, status, test, stop, or help", async (args) => {
                const [action, ...values] = args.split(/\s+/);
                const value = values.join(" ");
                if (!action || action === "status") {
                    await session.log(status());
                } else if (action === "on" || action === "off") {
                    enabled = action === "on";
                    speech.reset();
                    await session.log(status());
                } else if (action === "stop") {
                    await speech.dispose();
                    await session.log("Stopped speech playback.");
                } else if (action === "test") {
                    if (!enabled) throw new Error("Spoken summaries are off. Use /speak on first.");
                    speech.reset();
                    speech.queue(`Hello, I am ${settings.voice}. Your spoken summaries are ready.`);
                    await speech.stop();
                } else if (action === "speed") {
                    if (value) {
                        const speed = Number(value.replace(/x$/i, ""));
                        if (!Number.isFinite(speed) || speed <= 0) {
                            throw new Error("Usage: /speak speed <positive number>, e.g. /speak speed 1.4");
                        }
                        settings = await updateSettings({ speed });
                    }
                    await session.log(status());
                } else if (action === "voice") {
                    await selectVoice(value);
                } else if (action === "voices") {
                    await session.log(`Available voices: ${(await voices()).join(", ")}`);
                } else if (action === "help") {
                    await session.log(usage);
                } else {
                    throw new Error(usage);
                }
            }),
        ],
    },
    tools: {
        definitions: [
            {
                name: "queue_spoken_summary",
                description:
                    "Queue a brief spoken summary for the end of the current turn. " +
                    "Call once immediately before the final answer, after completing work. " +
                    "Use one or two plain-text sentences, at most 50 words. " +
                    "This only queues speech; it does not play until the agent stops.",
                parameters: {
                    type: "object",
                    properties: {
                        summary: { type: "string", minLength: 1, maxLength: 600 },
                    },
                    required: ["summary"],
                    additionalProperties: false,
                },
                skipPermission: true,
                defer: "never",
                handler: ({ summary }) => speech.queue(summary),
            },
        ],
    },
    hooks: {
        handlers: {
            onUserPromptSubmitted: async () => {
                speech.reset();
                settings = await readSettings();
                return {
                    additionalContext: enabled
                        ? guidance
                        : "Spoken summaries are muted. Do not call queue_spoken_summary.",
                };
            },
            onAgentStop: (input) => speech.stop(input),
            onSessionEnd: () => speech.dispose(),
        },
    },
});

session.on("session.idle", (event) => {
    if (event.data.aborted) speech.reset();
});
session.on("session.shutdown", () => void speech.dispose());
process.once("SIGTERM", async () => {
    await speech.dispose();
    process.exit(0);
});
