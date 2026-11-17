import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export const DEFAULT_SETTINGS = { voice: "Freya", speed: 1.4 };
const settingsPath = new URL("./settings.json", import.meta.url);

function validate(settings) {
    if (
        typeof settings.voice !== "string" ||
        !settings.voice.trim() ||
        !Number.isFinite(settings.speed) ||
        settings.speed <= 0
    ) {
        throw new Error("Voice settings require voice (nonempty text) and speed (positive number)");
    }
    return settings;
}

export async function readSettings(path = settingsPath) {
    try {
        const { voice, speed } = { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(path, "utf8")) };
        return validate({ voice, speed });
    } catch (error) {
        if (error.code === "ENOENT") return { ...DEFAULT_SETTINGS };
        throw error;
    }
}

export async function updateSettings(changes, path = settingsPath) {
    const { voice, speed } = { ...await readSettings(path), ...changes };
    const settings = validate({ voice, speed });
    const temporary = new URL(`./.settings-${randomUUID()}.tmp`, path);
    try {
        await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
    return settings;
}
