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
        "./speech.mjs": { createSpokenSummary: () => ({}) },
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
    return {
        invoke: (args = "") => options.interaction.commands
            .find((command) => command.name === "voice-name").handler({ args }),
        updates,
        logs,
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
