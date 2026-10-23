// Regenerate site.manifest.full.json from whatever is in deploy-worker/.
// Hashed chunk filenames change on every build, so this must run after each sync.
const fs = require("fs");
const path = require("path");

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const files = walk("deploy-worker")
  .map((f) => f.replace(/\\/g, "/"))
  .filter((f) => f.endsWith(".mjs"))
  .sort();

const manifest = {
  entrypoint: "index.mjs",
  compatibilityDate: "2025-09-01",
  modules: files.map((f) => ({
    name: f.replace(/^deploy-worker\//, ""),
    type: "esm",
    path: "./" + f,
  })),
  assetsDirectory: "./deploy-assets",
};

fs.writeFileSync("site.manifest.full.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("modules:", manifest.modules.length);
