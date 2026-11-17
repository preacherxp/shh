// Bundles the browser code and copies static files into dist.
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const out = join(root, "dist");
const modules = join(root, "node_modules");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "web/app.ts"), join(root, "web/scene.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const copies: Array<[from: string, to: string]> = [
  [join(root, "web/index.html"), "index.html"],
  [join(root, "web/style.css"), "style.css"],
  [join(root, "web/favicon.svg"), "favicon.svg"],
  [join(root, "web/stars.svg"), "stars.svg"],
  [join(modules, "@fontsource/jersey-15/files/jersey-15-latin-400-normal.woff2"), "jersey-15.woff2"],
  [join(modules, "@fontsource/vt323/files/vt323-latin-400-normal.woff2"), "vt323.woff2"],
  [join(modules, "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"), "jetbrains-mono.woff2"],
];
for (const [from, to] of copies) await cp(from, join(out, to));

for (const output of result.outputs) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(1)} kB`);
