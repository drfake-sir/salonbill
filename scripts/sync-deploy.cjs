// Sync the nitro build output into the Freebuff Sites deploy workspace.
//
// Why this exists (do not "simplify" it):
//  - Cloudflare rejects module names containing +, [, ] or @ (API error 10021),
//    so filenames are sanitised:  @ -> _at_,  + [ ] -> _
//  - import specifiers inside every copied module are rewritten to match.
//  - The manifest must list EVERY module: a missing one also fails with 10021
//    (Cloudflare validates the module graph at upload).
//
// Usage: node scripts/sync-deploy.cjs <deploy-workspace-dir>
//   (run from the project root; sources are .output/server + .output/public)

const fs = require("fs");
const path = require("path");

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: node scripts/sync-deploy.cjs <deploy-workspace-dir>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Pre-deploy export guard.
//
// Deploys that touch the Dexie schema or the sync code should only ship after
// the owner has taken a fresh JSON export from Settings → Backups (the file a
// restore would be built from). We cannot see the browser, so the script
// requires an explicit acknowledgement once it detects such changes:
//   node scripts/sync-deploy.cjs <dir> --ack-export    (or SB_PREDEPLOY_EXPORT=1)
const RISKY =
  /(^|\/)(src\/lib\/db\.ts|src\/lib\/lease\.ts|src\/lib\/syncClient\.ts|src\/syncFns\.ts|src\/server\/)/;
const ack = process.argv.includes("--ack-export") || process.env.SB_PREDEPLOY_EXPORT === "1";
try {
  const { execSync } = require("child_process");
  const changed = execSync("git diff --name-only HEAD && git diff --cached --name-only HEAD", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const risky = [...new Set(changed.split("\n").filter((f) => f && RISKY.test(f)))];
  if (risky.length) {
    console.log("\nSchema/sync-sensitive changes in this deploy:");
    for (const f of risky) console.log(`  ${f}`);
    if (!ack) {
      console.error(`
PRE-DEPLOY EXPORT REQUIRED
This deploy touches the Dexie schema or sync code. Before shipping it:
  1. Open Settings on the owner device → Backups & restore → JSON backup
     (keep a copy off the device — email / Drive).
  2. Re-run with --ack-export (or SB_PREDEPLOY_EXPORT=1).
`);
      process.exit(1);
    }
    console.log("pre-deploy export acknowledged\n");
  }
} catch (e) {
  // git unavailable (zip download, shallow copy) — the guard cannot run.
  console.warn(`git unavailable — pre-deploy export guard skipped (${e.message})`);
}

const SRC_SERVER = path.join(__dirname, "..", ".output", "server");
const SRC_PUBLIC = path.join(__dirname, "..", ".output", "public");
const DST_WORKER = path.join(workspace, "deploy-worker");
const DST_ASSETS = path.join(workspace, "deploy-assets");

/** Cloudflare-safe filename: @ -> _at_, + [ ] -> _ (matches the live worker). */
const sanitize = (p) => p.replace(/@/g, "_at_").replace(/[+\[\]]/g, "_");

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// rel path (posix) from server root -> sanitised rel path
const srcFiles = walk(SRC_SERVER)
  .map((f) => path.relative(SRC_SERVER, f).replace(/\\/g, "/"))
  .filter((rel) => rel.endsWith(".mjs"));
const renames = srcFiles.map((rel) => [rel, sanitize(rel)]);

const collisions = new Map();
for (const [, to] of renames) {
  collisions.set(to, (collisions.get(to) ?? 0) + 1);
}
for (const [to, n] of collisions) {
  if (n > 1) {
    console.error(`rename collision: ${to} (${n}x)`);
    process.exit(1);
  }
}

// Fresh worker dir (old hashed chunks must disappear).
fs.rmSync(DST_WORKER, { recursive: true, force: true });
fs.mkdirSync(DST_WORKER, { recursive: true });

// The platform's workerd does not expose node:module (probe uploads that
// reference it in the static graph are rejected with 10021, and the one
// build that shipped it behind a dynamic import 500'd at boot). The old
// accepted worker had ZERO node: imports in _runtime.mjs. Its __require is
// only ever called from the lazily-imported PDF libs — which run in the
// browser, never during SSR — so a clearly-failing stub is safe here and
// keeps the boot graph pure of node: builtins.
const patchRuntime = (content) => {
  if (!content.includes('from "node:module"')) return content;
  return content
    .replace('import { createRequire } from "node:module";\n', "")
    .replace(
      'var __require = /* #__PURE__ */ (() => createRequire(import.meta.url || "file:///"))();',
      'var __require = (id) => { throw new Error("require(\\"" + id + "\\") is not available in this runtime"); };',
    );
};

// Specifiers appear in three shapes and ALL must be rewritten:
//   "./dexie+unenv.mjs"        (sibling inside _libs/)
//   "./@tanstack/router+..."   (subdirectory)
//   "../_libs/x+1.mjs"         (cross-directory)
// Applying sanitize() to every quoted relative specifier is safe because the
// same function renames the files — target and reference stay in lockstep.
const relSpecifier = /(["'])(\.\.?\/[^"']+)(["'])/g;

for (const [rel, to] of renames) {
  const src = path.join(SRC_SERVER, rel);
  const dst = path.join(DST_WORKER, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let content = fs.readFileSync(src, "utf8");
  content = content.replace(relSpecifier, (m, q1, spec, q2) => q1 + sanitize(spec) + q2);
  if (to === "_runtime.mjs") content = patchRuntime(content);
  fs.writeFileSync(dst, content);
}

// Fresh assets dir (only dedicated public build output; already scanned: no maps/secrets).
fs.rmSync(DST_ASSETS, { recursive: true, force: true });
fs.cpSync(SRC_PUBLIC, DST_ASSETS, { recursive: true });

// Manifest must cover every module with its sanitised name.
const workerFiles = walk(DST_WORKER)
  .map((f) => path.relative(DST_WORKER, f).replace(/\\/g, "/"))
  .filter((rel) => rel.endsWith(".mjs"))
  .sort();

const manifest = {
  entrypoint: "index.mjs",
  compatibilityDate: "2025-09-01",
  modules: workerFiles.map((rel) => ({
    name: rel,
    type: "esm",
    path: "./deploy-worker/" + rel,
  })),
  assetsDirectory: "./deploy-assets",
};
fs.writeFileSync(
  path.join(workspace, "site.manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(`worker modules: ${workerFiles.length}`);
console.log(`assets: ${walk(DST_ASSETS).length} files`);
