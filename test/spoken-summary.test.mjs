import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createSpokenSummary } from "../speech.mjs";
import { DEFAULT_SETTINGS, readSettings, updateSettings } from "../settings.mjs";

const wav = Buffer.from("RIFF0000WAVEfake-audio");
const response = () => new Response(wav);

async function eventually(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("Timed out waiting for speech work");
}

test("queues without speaking, sends only summary, plays once and removes audio", async () => {
    const calls = [];
    let audioPath;
    let played = false;
    const speech = createSpokenSummary({
        request: async (url, options) => {
            calls.push([url, JSON.parse(options.body)]);
            return response();
        },
        play: async (path) => {
            audioPath = path;
            assert.deepEqual(await readFile(path), wav);
            played = true;
        },
    });
    speech.queue("  The fix is ready. Tests passed.  ");
    assert.equal(calls.length, 0);
    const completion = speech.stop();
    speech.stop();
    await eventually(() => played);
    await completion;
    await speech.dispose();
    assert.deepEqual(calls, [
        ["http://127.0.0.1:11434/v1/audio/speech", {
            model: "phonon",
            input: "The fix is ready. Tests passed.",
            voice: "Freya",
            response_format: "wav",
        }],
    ]);
    await assert.rejects(access(audioPath), { code: "ENOENT" });
});

test("requests a missing summary once without an infinite stop loop", () => {
    const speech = createSpokenSummary();
    assert.equal(speech.stop().decision, "block");
    assert.equal(speech.stop({ stopHookActive: true }), undefined);
    assert.equal(speech.stop(), undefined);
});

test("new prompt clears stale queued speech", () => {
    const speech = createSpokenSummary({
        request: () => assert.fail("Stale summary must not be sent"),
    });
    speech.queue("Old summary.");
    speech.reset();
    assert.equal(speech.stop().decision, "block");
});

test("new prompt aborts in-flight synthesis without warning or playback", async () => {
    let signal;
    const speech = createSpokenSummary({
        request: async (_url, options) => {
            signal = options.signal;
            return new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason)),
            );
        },
        play: () => assert.fail("Cancelled audio must not play"),
        reportError: () => assert.fail("Cancellation should not warn"),
    });
    speech.queue("Interrupted summary.");
    speech.stop();
    assert.equal(signal.aborted, false);
    speech.reset();
    assert.equal(signal.aborted, true);
    await speech.dispose();
});

test("reset cancels playback and cleans temporary audio", async () => {
    let signal;
    let audioPath;
    const speech = createSpokenSummary({
        request: async () => response(),
        play: async (path, playbackSignal) => {
            audioPath = path;
            signal = playbackSignal;
            await new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason)),
            );
        },
    });
    speech.queue("Interrupt playback.");
    speech.stop();
    await eventually(() => signal);
    speech.reset();
    await speech.dispose();
    assert.equal(signal.aborted, true);
    await assert.rejects(access(audioPath), { code: "ENOENT" });
});

test("HTTP errors warn without blocking the completed turn", async () => {
    const errors = [];
    const speech = createSpokenSummary({
        request: async () => new Response("Not found", { status: 404 }),
        reportError: (message) => errors.push(message),
        play: () => assert.fail("Failed response must not play"),
    });
    speech.queue("An outcome.");
    const completion = speech.stop();
    await eventually(() => errors.length);
    await completion;
    assert.match(errors[0], /HTTP 404/);
    await speech.dispose();
});

test("non-audio responses warn instead of invoking the player", async () => {
    const errors = [];
    const speech = createSpokenSummary({
        request: async () => new Response('{"error":"missing model"}'),
        reportError: (message) => errors.push(message),
        play: () => assert.fail("Invalid audio must not play"),
    });
    speech.queue("An outcome.");
    speech.stop();
    await eventually(() => errors.length);
    assert.match(errors[0], /did not return WAV/);
    await speech.dispose();
});

test("invalid or unbounded summaries are rejected", () => {
    const speech = createSpokenSummary();
    for (const summary of [undefined, "", "   ", "a".repeat(601)]) {
        assert.throws(() => speech.queue(summary), /nonempty plain-text summary/);
    }
});

test("a fresh turn can speak after a completed turn", async () => {
    let plays = 0;
    const speech = createSpokenSummary({
        request: async () => response(),
        play: async () => { plays++; },
    });
    speech.queue("First.");
    speech.stop();
    await eventually(() => plays === 1);
    await setImmediate();
    speech.reset();
    speech.queue("Second.");
    speech.stop();
    await eventually(() => plays === 2);
    await speech.dispose();
});

test("muting skips synthesis and does not request a summary", () => {
    const speech = createSpokenSummary({
        getSettings: () => ({ ...DEFAULT_SETTINGS, enabled: false }),
        request: () => assert.fail("Muted speech must not synthesize"),
    });
    assert.match(speech.queue("Muted."), /muted/);
    assert.equal(speech.stop(), undefined);
});

test("selected voice and playback speed reach the speech pipeline", async () => {
    let playedSpeed;
    const speech = createSpokenSummary({
        getSettings: () => ({ enabled: true, voice: "Freya", speed: 1.4 }),
        request: async (_url, options) => {
            assert.equal(JSON.parse(options.body).voice, "Freya");
            return response();
        },
        play: async (_path, _signal, speed) => { playedSpeed = speed; },
    });
    speech.queue("Updated voice preferences.");
    await speech.stop();
    assert.equal(playedSpeed, 1.4);
    await speech.dispose();
});

test("voice settings persist, merge updates, and reject invalid speeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copilot-voice-settings-test-"));
    const path = pathToFileURL(join(directory, "settings.json"));
    try {
        assert.deepEqual(await readSettings(path), DEFAULT_SETTINGS);
        await updateSettings({ speed: 1.4 }, path);
        await updateSettings({ enabled: false }, path);
        assert.deepEqual(await readSettings(path), {
            enabled: false, voice: "Freya", speed: 1.4,
        });
        for (const speed of [0, -1, NaN, Infinity, "1.4"]) {
            await assert.rejects(updateSettings({ speed }, path), /positive number/);
        }
        assert.equal((await readSettings(path)).speed, 1.4);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
