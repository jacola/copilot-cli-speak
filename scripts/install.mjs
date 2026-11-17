import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const configHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const destination = join(configHome, "extensions", "spoken-summary");

await mkdir(destination, { recursive: true });
for (const name of ["extension.mjs", "speech.mjs", "settings.mjs"]) {
    await copyFile(new URL(`../${name}`, import.meta.url), join(destination, name));
}
console.log(`Installed spoken-summary in ${destination}`);
console.log("Existing voice settings were preserved. Restart Copilot CLI to load the extension.");
