import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const evalDir = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(evalDir, "samples");
const outputDir = join(samplesDir, "downloaded");
const manifest = JSON.parse(
  await readFile(join(samplesDir, "public-prs.json"), "utf8"),
);

await mkdir(outputDir, { recursive: true });
const index = [];

for (const sample of manifest) {
  const url = `https://github.com/${sample.repo}/pull/${sample.pr}.diff`;
  const response = await fetch(url, {
    headers: { "user-agent": "prune-review-eval" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${sample.repo}#${sample.pr}: HTTP ${response.status}`);
  }

  const diff = await response.text();
  const slug = `${sample.repo.replace("/", "-")}-pr-${sample.pr}`;
  const file = `${slug}.diff`;
  const hunks = (diff.match(/^@@ /gm) ?? []).length;
  const sha256 = createHash("sha256").update(diff).digest("hex");
  await writeFile(join(outputDir, file), diff);
  index.push({ ...sample, url, file, bytes: Buffer.byteLength(diff), hunks, sha256 });
  console.log(`${slug}: ${hunks} hunks, ${Buffer.byteLength(diff)} bytes`);
}

await writeFile(join(outputDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`Fetched ${index.length} public PR diffs into ${outputDir}`);