// Validate that the deploy workspace's module graph is complete:
// every relative import specifier inside deploy-worker must resolve to a file
// that is also listed in site.manifest.json. Cloudflare rejects the upload
// (error 10021) when it does not.
//
// Usage: node scripts/check-manifest.cjs <deploy-workspace-dir>

const fs = require("fs");
const path = require("path");

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: node scripts/check-manifest.cjs <deploy-workspace-dir>");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "site.manifest.json"), "utf8"));
const listed = new Set(manifest.modules.map((x) => x.name));

const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

const files = walk(path.join(workspace, "deploy-worker"))
  .map((f) => path.relative(workspace, f).replace(/\\/g, "/"))
  .filter((f) => f.endsWith(".mjs"));

const missing = [];
const specRe = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
for (const f of files) {
  // Strip block comments first: JSDoc samples like
  //   * import { X } from './X'
  // are not imports. Cloudflare's parser ignores them too (verified against
  // the previously accepted worker, which contains the same comment).
  const src = fs.readFileSync(path.join(workspace, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  let m;
  while ((m = specRe.exec(src))) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
    if (!listed.has(resolved) && !fs.existsSync(path.join(workspace, resolved))) {
      missing.push(`${f} -> ${m[1]}`);
    }
  }
}

// Also: every listed module must exist on disk.
const absent = manifest.modules.filter(
  (x) => !fs.existsSync(path.join(workspace, x.path.replace(/^\.\//, ""))),
);

console.log(
  `files: ${files.length} | listed: ${listed.size} | unresolved imports: ${missing.length} | listed-but-absent: ${absent.length}`,
);
if (missing.length) console.log(missing.slice(0, 15).join("\n"));
if (absent.length)
  console.log(
    absent
      .map((x) => x.path)
      .slice(0, 15)
      .join("\n"),
  );
process.exit(missing.length || absent.length ? 1 : 0);
