import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const artifactsDir = join(root, "artifacts");
const stagingDir = join(root, ".release");
const executableSuffix = process.platform === "win32" ? ".cmd" : "";
const ncc = join(root, "packages", "action", "node_modules", ".bin", `ncc${executableSuffix}`);
const npm = `npm${executableSuffix}`;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function buildArtifact({ name, bin, description, entry }) {
  const outputDir = join(stagingDir, name);
  run(ncc, ["build", entry, "-o", outputDir, "--license", "licenses.txt"]);

  writeFileSync(
    join(outputDir, "package.json"),
    `${JSON.stringify({
      name,
      version,
      description,
      license: "Apache-2.0",
      type: "module",
      bin: { [bin]: "index.js" },
      engines: { node: ">=20" },
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(outputDir, "README.md"),
    `# ${name}\n\nStandalone GitHub release artifact for [prune-review](https://github.com/shubhangi013/prune-review).\n`,
  );
  copyFileSync(join(root, "LICENSE"), join(outputDir, "LICENSE"));
  chmodSync(join(outputDir, "index.js"), 0o755);
  run(npm, ["pack", outputDir, "--pack-destination", artifactsDir]);
}

rmSync(artifactsDir, { recursive: true, force: true });
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(artifactsDir, { recursive: true });
mkdirSync(stagingDir, { recursive: true });

try {
  buildArtifact({
    name: "prune-review",
    bin: "prune",
    description: "Cost-aware PR review CLI using TypeSafe Jev decisions.",
    entry: join(root, "packages", "core", "src", "cli.ts"),
  });
  buildArtifact({
    name: "prune-review-mcp",
    bin: "prune-mcp",
    description: "MCP server for cost-aware PR review using TypeSafe Jev decisions.",
    entry: join(root, "packages", "mcp", "src", "server.ts"),
  });
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}