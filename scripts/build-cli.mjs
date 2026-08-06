import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  legalComments: "none",
  metafile: true,
  packages: "external",
  platform: "node",
  sourcemap: false,
  target: "node22",
};
const cli = await build({
  ...common,
  banner: { js: "#!/usr/bin/env node" },
  entryPoints: ["src/bin.ts"],
  outfile: "dist/agentbox.js",
});
const api = await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });
const declarations = spawnSync("tsc", ["--emitDeclarationOnly"], { encoding: "utf8" });
if (declarations.status !== 0) throw new Error(declarations.stderr || declarations.stdout);
rmSync("dist/bin.d.ts", { force: true });
const declarationOutputs = Object.fromEntries(readdirSync("dist")
  .filter((file) => file.endsWith(".d.ts"))
  .map((file) => [`dist/${file}`, { bytes: statSync(`dist/${file}`).size }]));
writeFileSync("release/bundle-metafile.json", `${JSON.stringify({
  inputs: { ...cli.metafile.inputs, ...api.metafile.inputs },
  outputs: { ...cli.metafile.outputs, ...api.metafile.outputs, ...declarationOutputs },
})}\n`);
chmodSync("dist/agentbox.js", 0o755);
