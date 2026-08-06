import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const components = [];
const identities = new Set();
const licenseDirectory = "third-party-licenses";
rmSync(licenseDirectory, { recursive: true, force: true });
mkdirSync(licenseDirectory);
const sections = [
  "# Third-Party Notices",
  "",
  "The compiled package contains the following third-party components. Exact, deduplicated license texts are shipped under `third-party-licenses/` and are bound here by SHA-256.",
];
const apache = readFileSync("node_modules/typescript/LICENSE.txt", "utf8").trim();

for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules/") || metadata.dev === true || typeof metadata.version !== "string") continue;
  const name = /node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(path)?.[1];
  if (!name) throw new Error(`cannot determine package name for ${path}`);
  const identity = `${name}@${metadata.version}`;
  if (identities.has(identity)) continue;
  identities.add(identity);
  const packageJson = JSON.parse(readFileSync(resolve(path, "package.json"), "utf8"));
  const license = metadata.license ?? packageJson.license;
  if (typeof license !== "string") throw new Error(`missing declared license for ${name}@${metadata.version}`);
  const licensePath = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]
    .map((file) => resolve(path, file))
    .find(existsSync);
  const rawText = licensePath ? readFileSync(licensePath, "utf8").trim() : license === "Apache-2.0" ? apache : undefined;
  const text = rawText?.replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "");
  if (!text) throw new Error(`missing license text for ${name}@${metadata.version}`);
  const licenseTextSha256 = createHash("sha256").update(text).digest("hex");
  const licenseFile = `${licenseDirectory}/${licenseTextSha256}.txt`;
  if (!existsSync(licenseFile)) writeFileSync(licenseFile, `${text}\n`);
  const body = `Upstream package: ${name}@${metadata.version}\nDeclared license: ${license}\nLicense text: ${licenseFile}\nLicense text SHA-256: ${licenseTextSha256}`;
  components.push({
    name,
    version: metadata.version,
    license,
    licenseFile,
    licenseTextSha256,
    noticeSha256: createHash("sha256").update(body).digest("hex"),
  });
  sections.push("", `## ${name}@${metadata.version} (${license})`, "", body);
}

components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const ordered = [sections[0], sections[1], sections[2]];
for (const component of components) {
  const heading = `## ${component.name}@${component.version} (${component.license})`;
  const start = sections.indexOf(heading);
  ordered.push("", heading, "", sections[start + 2]);
}
writeFileSync("release/third-party-components.json", `${JSON.stringify(components, null, 2)}\n`);
writeFileSync("THIRD_PARTY_NOTICES.md", `${ordered.join("\n")}\n`);
