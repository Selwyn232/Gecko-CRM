// Kopieert de MediaPipe-rekenmodule (WebAssembly) naar public/, zodat alles van onze eigen server komt (geen externe dienst).
// De modellen zelf (gezicht, achtergrond) staan in public/models.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("node_modules", "@mediapipe", "tasks-vision", "wasm");
const out = join("public", "mediapipe", "wasm");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(dir)) cpSync(join(dir, f), join(out, f));
console.log("mediapipe gekopieerd");
