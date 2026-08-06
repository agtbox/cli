import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.argv[2] ?? process.cwd());
const revision = process.argv[3] ?? "--all";
const result = spawnSync("git", ["-C", root, "log", revision, "--format=%H%x09%an%x09%ae%x09%cn%x09%ce"], { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const commits = result.stdout.trim().split("\n").filter(Boolean);
if (commits.length === 0) {
  console.error("commit-author verification requires at least one reachable commit");
  process.exit(1);
}

const invalid = commits.filter((line) => {
  const [, authorName, authorEmail, committerName, committerEmail] = line.split("\t");
  return authorName !== "agtbox" || authorEmail !== "dev@agtbox.dev"
    || committerName !== "agtbox" || committerEmail !== "dev@agtbox.dev";
});
if (invalid.length > 0) {
  for (const line of invalid) console.error(`invalid commit author or committer: ${line}`);
  process.exit(1);
}

console.log(`verified ${commits.length} commits use author and committer agtbox <dev@agtbox.dev>`);
