import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS } from "./settings.mjs";

const run = promisify(execFile);

export function createSpokenSummary({
    request = globalThis.fetch,
    getSettings = () => ({ ...DEFAULT_SETTINGS, enabled: false }),
    play = (path, signal, speed) =>
        run("/usr/bin/afplay", ["--rate", String(speed), "--rQuality", "1", path], {
            signal,
            timeout: 45_000,
        }),
    reportError = () => {},
} = {}) {
    let queued = "";
    let finished = false;
    let active;
    let work = Promise.resolve();

    async function speak(summary, controller, settings) {
        let directory;
        try {
            const response = await request("http://127.0.0.1:11434/v1/audio/speech", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "phonon",
                    input: summary,
                    voice: settings.voice,
                    response_format: "wav",
                }),
                signal: AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(30_000),
                ]),
            });
            if (!response.ok) {
                throw new Error(`Ollama speech API returned HTTP ${response.status}`);
            }
            const audio = Buffer.from(await response.arrayBuffer());
            if (
                audio.toString("ascii", 0, 4) !== "RIFF" ||
                audio.toString("ascii", 8, 12) !== "WAVE"
            ) {
                throw new Error("Ollama did not return WAV audio");
            }
            controller.signal.throwIfAborted();
            directory = await mkdtemp(join(tmpdir(), "copilot-spoken-summary-"));
            const path = join(directory, "summary.wav");
            await writeFile(path, audio, { mode: 0o600 });
            controller.signal.throwIfAborted();
            await play(path, controller.signal, settings.speed);
        } catch (error) {
            if (!controller.signal.aborted) {
                await Promise.resolve(
                    reportError(`Spoken summary unavailable: ${error.message}`),
                ).catch(() => {});
            }
        } finally {
            if (directory) await rm(directory, { recursive: true, force: true });
            if (active === controller) active = undefined;
        }
    }

    function cancel() {
        active?.abort();
        active = undefined;
    }

    return {
        queue(summary) {
            if (!getSettings().enabled) return "Spoken summaries are muted.";
            if (typeof summary !== "string" || !summary.trim() || summary.length > 600) {
                throw new Error("Provide a nonempty plain-text summary of at most 600 characters");
            }
            queued = summary.trim();
            return "Summary queued. Give your normal final answer now; speech starts at turn completion.";
        },
        reset() {
            cancel();
            queued = "";
            finished = false;
        },
        stop({ stopHookActive } = {}) {
            if (finished) return;
            const settings = { ...getSettings() };
            if (!settings.enabled) {
                queued = "";
                finished = true;
                return;
            }
            if (!queued) {
                if (!stopHookActive) {
                    return {
                        decision: "block",
                        reason:
                            "Queue a brief spoken summary with queue_spoken_summary, " +
                            "then finish. Summarize only the outcome or question; do not redo the work.",
                    };
                }
                finished = true;
                return;
            }
            finished = true;
            const summary = queued;
            queued = "";
            cancel();
            const controller = new AbortController();
            active = controller;
            work = speak(summary, controller, settings).catch(() => {});
            return work;
        },
        async dispose() {
            cancel();
            queued = "";
            finished = true;
            await work;
        },
    };
}
