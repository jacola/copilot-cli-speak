import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const installer = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));

test("installer copies portable extension modules and preserves existing preferences", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "copilot-extension-install-test-"));
    const destination = join(configHome, "extensions", "spoken-summary");
    const options = { env: { ...process.env, COPILOT_HOME: configHome } };
    try {
        await run(process.execPath, [installer], options);
        assert.deepEqual((await readdir(destination)).sort(), [
            "extension.mjs", "settings.mjs", "speech.mjs",
        ]);
        for (const name of ["extension.mjs", "settings.mjs", "speech.mjs"]) {
            assert.equal(
                await readFile(join(destination, name), "utf8"),
                await readFile(new URL(`../${name}`, import.meta.url), "utf8"),
            );
        }
        const preferences = '{"enabled":false,"voice":"Zoey","speed":1.2}\n';
        await writeFile(join(destination, "settings.json"), preferences);
        await run(process.execPath, [installer], options);
        assert.equal(await readFile(join(destination, "settings.json"), "utf8"), preferences);
    } finally {
        await rm(configHome, { recursive: true, force: true });
    }
});
