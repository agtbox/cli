import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const manifestPath = resolve(argument("--manifest", "release/third-party-components.json"));
const noticesPath = resolve(argument("--notices", "THIRD_PARTY_NOTICES.md"));
const lockfilePath = resolve(argument("--lockfile", "package-lock.json"));
const bundleMetafilePath = resolve(argument("--bundle-metafile", "release/bundle-metafile.json"));
const components = JSON.parse(readFileSync(manifestPath, "utf8"));
const notices = readFileSync(noticesPath, "utf8");
const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
const bundleMetafile = JSON.parse(readFileSync(bundleMetafilePath, "utf8"));
const declared = new Set();
const findings = [];
const projectRoot = resolve(lockfilePath, "..");

if (!Array.isArray(components) || typeof lockfile.packages !== "object" || typeof bundleMetafile.inputs !== "object") {
  console.error("third-party component manifest must be a JSON array");
  process.exit(1);
}

function packageName(path) {
  return /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path)?.[1];
}

const locked = Object.entries(lockfile.packages)
  .filter(([path, value]) => path.includes("node_modules/") && value && typeof value.version === "string")
  .map(([path, value]) => ({ path, name: packageName(path), version: value.version, dev: value.dev === true }))
  .filter(({ name }) => name);
const required = new Set(locked.filter(({ dev }) => !dev).map(({ name, version }) => `${name}@${version}`));
for (const input of Object.keys(bundleMetafile.inputs)) {
  const match = locked
    .filter(({ path }) => input === path || input.startsWith(`${path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (input.includes("node_modules/") && !match) findings.push(`bundled module is absent from the lockfile: ${input}`);
  if (match) required.add(`${match.name}@${match.version}`);
}

function filesBelow(current) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(current, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

const outputs = new Map(Object.entries(bundleMetafile.outputs ?? {}).map(([path, metadata]) => [path.replace(/^\.\//, ""), metadata]));
const dist = resolve(projectRoot, "dist");
if (existsSync(dist)) {
  for (const absolute of filesBelow(dist)) {
    const path = relative(projectRoot, absolute).replaceAll("\\", "/");
    const metadata = outputs.get(path);
    if (!metadata) {
      findings.push(`shipped dist file is absent from the generated bundler metafile: ${path}`);
    } else if (metadata.bytes !== statSync(absolute).size) {
      findings.push(`bundler metafile byte count does not match shipped output: ${path}`);
    }
  }
}

for (const component of components) {
  if (!component || typeof component.name !== "string" || typeof component.version !== "string" || typeof component.license !== "string"
    || !/^[a-f0-9]{64}$/.test(component.noticeSha256) || !/^[a-f0-9]{64}$/.test(component.licenseTextSha256)
    || !/^third-party-licenses\/[a-f0-9]{64}\.txt$/.test(component.licenseFile)) {
    findings.push("every third-party component requires identity, notice hash, and exact license-file hash fields");
    continue;
  }
  const identity = `${component.name}@${component.version} (${component.license})`;
  const packageIdentity = `${component.name}@${component.version}`;
  if (declared.has(packageIdentity)) findings.push(`duplicate third-party component: ${packageIdentity}`);
  declared.add(packageIdentity);
  const heading = `## ${identity}`;
  const headingIndex = notices.indexOf(heading);
  if (headingIndex === -1) {
    findings.push(`missing notice heading for ${identity}`);
    continue;
  }
  const bodyStart = notices.indexOf("\n", headingIndex + heading.length);
  const nextHeading = bodyStart === -1 ? -1 : notices.indexOf("\n## ", bodyStart + 1);
  const body = (bodyStart === -1 ? "" : notices.slice(bodyStart + 1, nextHeading === -1 ? undefined : nextHeading + 1)).trim();
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== component.noticeSha256) findings.push(`notice text hash does not match for ${identity}`);
  const licenseFile = resolve(projectRoot, component.licenseFile);
  if (!existsSync(licenseFile)) {
    findings.push(`license text file is missing for ${identity}`);
  } else {
    const licenseText = readFileSync(licenseFile, "utf8").trim();
    const licenseDigest = createHash("sha256").update(licenseText).digest("hex");
    if (licenseDigest !== component.licenseTextSha256) findings.push(`license text hash does not match for ${identity}`);
  }
}

for (const identity of required) {
  if (!declared.has(identity)) findings.push(`missing third-party declaration for shipped component: ${identity}`);
}
for (const identity of declared) {
  if (!required.has(identity)) findings.push(`third-party declaration is not present in the shipped dependency graph: ${identity}`);
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log(`verified notices for ${components.length} declared third-party components`);
