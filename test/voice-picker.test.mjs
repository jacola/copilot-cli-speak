import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

const source = await readFile(new URL("../extension.mjs", import.meta.url), "utf8");

async function setup({ capable = true, result = { action: "accept", content: { voice: "Zoey" } } } = {}) {
    let options;
    let form;
    let settings = { enabled: true, voice: "Freya", speed: 1.4 };
    const updates = [];
    const logs = [];
    const speechCalls = [];
    let speechOptions;
    const session = {
        capabilities: { ui: { elicitation: capable } },
        ui: {
            elicitation: async (request) => {
                form = request;
                return result;
            },
        },
        log: async (message) => { logs.push(message); },
        on() {},
    };
    const context = createContext({
        AbortSignal,
        process: { once() {} },
        fetch: async () => ({
            ok: true,
            json: async () => ({ voices: ["Freya", "Zoey", "Captain Silas Blackwater"] }),
        }),
    });
    const dependencies = {
        "@microsoft/copilot-sdk/extension": {
            joinSession: async (value) => { options = value; return session; },
        },
        "./speech.mjs": {
            createSpokenSummary: (value) => {
                speechOptions = value;
                return {
                    reset: () => { speechCalls.push("reset"); },
                    queue: () => { speechCalls.push("queue"); },
                    stop: () => { speechCalls.push("stop"); },
                    dispose: () => { speechCalls.push("dispose"); },
                };
            },
        },
        "./settings.mjs": {
            readSettings: async () => ({ ...settings }),
            updateSettings: async (changes) => {
                updates.push(changes);
                settings = { ...settings, ...changes };
                return settings;
            },
        },
    };
    const module = new SourceTextModule(source, { context });
    await module.link((specifier) => {
        const values = dependencies[specifier];
        return new SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    const invokeSpeak = (args = "") => options.interaction.commands
        .find((command) => command.name === "speak").handler({ args });
    return {
        invoke: (args = "") => invokeSpeak(`voice ${args}`),
        invokeSpeak,
        submitPrompt: () => options.hooks.handlers.onUserPromptSubmitted(),
        speechSettings: () => speechOptions.getSettings(),
        updates,
        logs,
        speechCalls,
        form: () => form,
    };
}

test("no-argument voice command offers all voices, defaults to current voice, and saves selection", async () => {
    const picker = await setup();
    await picker.invoke();
    const field = picker.form().requestedSchema.properties.voice;
    assert.deepEqual(Array.from(field.enum), ["Freya", "Zoey", "Captain Silas Blackwater"]);
    assert.equal(field.default, "Freya");
    assert.equal(picker.updates[0].voice, "Zoey");
    assert.match(picker.logs[0], /voice: Zoey; speed: 1.4x/);
});

test("cancel or decline leaves the saved voice unchanged", async () => {
    for (const action of ["cancel", "decline"]) {
        const picker = await setup({ result: { action } });
        await picker.invoke();
        assert.equal(picker.updates.length, 0);
    }
});

test("explicit voice names still work case-insensitively without opening a picker", async () => {
    const picker = await setup();
    await picker.invoke("captain silas blackwater");
    assert.equal(picker.form(), undefined);
    assert.equal(picker.updates[0].voice, "Captain Silas Blackwater");
});

test("noninteractive hosts list voices without modifying settings", async () => {
    const picker = await setup({ capable: false });
    await picker.invoke();
    assert.equal(picker.form(), undefined);
    assert.equal(picker.updates.length, 0);
    assert.match(picker.logs[0], /Freya\nZoey\nCaptain Silas Blackwater/);
});

test("invalid or missing accepted selections do not overwrite the voice", async () => {
    for (const content of [{ voice: "Imaginary" }, {}, { voice: 123 }]) {
        const picker = await setup({ result: { action: "accept", content } });
        await picker.invoke();
        assert.equal(picker.updates.length, 0);
        assert.match(picker.logs[0], /Unknown voice/);
    }
});

test("new sessions start muted even when legacy saved settings enable speech", async () => {
    const first = await setup();
    assert.equal(first.speechSettings().enabled, false);
    assert.match((await first.submitPrompt()).additionalContext, /muted/);
    await first.invokeSpeak("on");
    const second = await setup();
    assert.equal(second.speechSettings().enabled, false);
    assert.equal(first.speechSettings().enabled, true);
    assert.equal(first.updates.length, 0);
});

test("session opt-in survives prompts and preference updates without being persisted", async () => {
    const session = await setup();
    await session.invokeSpeak("on");
    await session.invokeSpeak("speed 1.2");
    await session.invoke("Zoey");
    assert.match((await session.submitPrompt()).additionalContext, /Before your final answer/);
    assert.equal(session.speechSettings().enabled, true);
    assert.equal(session.speechSettings().voice, "Zoey");
    assert.equal(session.speechSettings().speed, 1.2);
    assert.ok(session.updates.every((changes) => !("enabled" in changes)));
    await session.invokeSpeak("off");
    assert.equal(session.speechSettings().enabled, false);
    assert.match((await session.submitPrompt()).additionalContext, /muted/);
});

test("speak subcommands list voices, change speed, show help and reject invalid values while muted", async () => {
    const session = await setup();
    await session.invokeSpeak("voices");
    assert.match(session.logs.at(-1), /Freya, Zoey, Captain Silas Blackwater/);
    await session.invokeSpeak("speed 1.5x");
    assert.equal(session.speechSettings().speed, 1.5);
    assert.equal(session.speechSettings().enabled, false);
    await session.invokeSpeak("speed");
    assert.match(session.logs.at(-1), /off; voice: Freya; speed: 1.5x/);
    await session.invokeSpeak("speed invalid");
    assert.match(session.logs.at(-1), /Usage: \/speak speed/);
    assert.equal(session.speechSettings().speed, 1.5);
    await session.invokeSpeak("help");
    assert.match(session.logs.at(-1), /voice \[name\].*speed \[number\]/);
    await session.invokeSpeak("unknown");
    assert.match(session.logs.at(-1), /Usage: \/speak/);
});

test("speak test requires opt-in and stop does not mute the session", async () => {
    const session = await setup();
    await session.invokeSpeak("test");
    assert.match(session.logs.at(-1), /Use \/speak on first/);
    assert.deepEqual(session.speechCalls, []);
    await session.invokeSpeak("on");
    await session.invokeSpeak("test");
    await session.invokeSpeak("stop");
    assert.deepEqual(session.speechCalls, ["reset", "reset", "queue", "stop", "dispose"]);
    assert.equal(session.speechSettings().enabled, true);
});
