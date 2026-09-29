#!/usr/bin/env node
/**
 * Link pi's own packages into ./node_modules so `npm run typecheck` and
 * `npm test` can resolve them.
 *
 * Why this exists: the plugin is loaded *by pi*, which aliases the bare
 * specifiers (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) to the
 * copies pi itself ships. They are therefore not real dependencies of this
 * package, and a plain `npm install` leaves the tree un-typecheckable. This
 * script finds your global pi install and links its copies in.
 *
 * Usage:
 *   node scripts/link-pi.mjs                     # probe the usual locations
 *   PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs
 *
 * Idempotent: re-running replaces the links. On Windows directories are linked
 * as junctions, which needs no administrator rights.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PKG = "@earendil-works/pi-coding-agent";

/** [link name under node_modules, path under PI_ROOT] */
const LINKS = [
  [PI_PKG, PI_PKG],
  ["@earendil-works/pi-ai", `${PI_PKG}/node_modules/@earendil-works/pi-ai`],
  ["@types/node", `${PI_PKG}/node_modules/@types/node`],
];

/** First `pi` on PATH, resolved through symlinks; undefined when absent. */
function piBinDir() {
  const exts = process.platform === "win32" ? [".cmd", ".ps1", ".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const bin = join(dir, `pi${ext}`);
      if (existsSync(bin)) {
        try {
          return dirname(realpathSync(bin));
        } catch {
          return dirname(bin);
        }
      }
    }
  }
  return undefined;
}

/** Where a global pi install's node_modules may live, in probe order. */
function candidates() {
  const out = [];
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (npmRoot) out.push(npmRoot);
  } catch {
    /* npm not on PATH — the remaining candidates still apply */
  }
  out.push(join(homedir(), ".local", "lib", "node_modules"));
  out.push("/usr/local/lib/node_modules");
  // Whatever directory the `pi` executable really lives in, walked up to its
  // node_modules. Covers nvm, pnpm, Volta and custom prefixes.
  const binDir = piBinDir();
  if (binDir) {
    out.push(resolve(binDir, "..", "lib", "node_modules"));
    out.push(resolve(binDir, "..", "..", "node_modules"));
  }
  return out.filter((dir) => dir && existsSync(join(dir, PI_PKG, "package.json")));
}

// An explicit PI_ROOT is a request, not a hint: fail loudly if it is wrong
// rather than silently linking a different install.
if (process.env.PI_ROOT && !existsSync(join(process.env.PI_ROOT, PI_PKG, "package.json"))) {
  console.error(
    `link-pi: PI_ROOT=${process.env.PI_ROOT} has no ${PI_PKG}/package.json.\n` +
      `PI_ROOT must be a node_modules directory that contains pi.`,
  );
  process.exit(1);
}

const roots = process.env.PI_ROOT ? [process.env.PI_ROOT] : candidates();
if (roots.length === 0) {
  console.error(
    `link-pi: cannot find ${PI_PKG} in any global node_modules.\n` +
      `Install pi (npm i -g ${PI_PKG}), or point at its node_modules:\n` +
      `  PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs`,
  );
  process.exit(1);
}
const PI_ROOT = roots[0];
if (roots.length > 1) {
  console.log(`link-pi: several pi installs found, using ${PI_ROOT}`);
  for (const other of roots.slice(1)) console.log(`         (ignored: ${other})`);
}

const nodeModules = join(dirname(dirname(fileURLToPath(import.meta.url))), "node_modules");
let linked = 0;
for (const [name, rel] of LINKS) {
  const target = join(PI_ROOT, rel);
  if (!existsSync(target)) {
    console.warn(`link-pi: skipping ${name} — not present in ${PI_ROOT}`);
    continue;
  }
  const dest = join(nodeModules, name);
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  symlinkSync(target, dest, "junction");
  console.log(`link-pi: ${name} -> ${target}`);
  linked++;
}

if (linked === 0) {
  console.error("link-pi: nothing to link.");
  process.exit(1);
}
console.log(`link-pi: ${linked} link(s) in ${nodeModules}. Now: npm run check`);
