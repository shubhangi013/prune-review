import type { ParsedFile } from "./types.js";

/**
 * Parse a unified diff (single-file or multi-file) into per-file hunks.
 * Handles both `--- a/path` / `+++ b/path` layouts and `--- /dev/null` deletions.
 */
export function parsePatch(patchText: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const fileBlobs = patchText
    .split(/^(?=--- )/m)
    .filter((b) => b.startsWith("--- "));

  for (const blob of fileBlobs) {
    const lines = blob.split("\n");
    let filePath = "unknown";

    for (const line of lines.slice(0, 5)) {
      const m1 = line.match(/^\+\+\+ b\/(.+?)\s*$/);
      if (m1) {
        filePath = m1[1];
        break;
      }
      const m2 = line.match(/^\+\+\+ (.+?)\s*$/);
      if (m2 && m2[1] !== "/dev/null") {
        filePath = m2[1].replace(/^b\//, "");
        break;
      }
    }

    if (filePath === "unknown") {
      for (const line of lines.slice(0, 5)) {
        const m = line.match(/^--- a\/(.+?)\s*$/);
        if (m) {
          filePath = m[1];
          break;
        }
      }
    }

    const header = lines.slice(0, 2).join("\n");
    const hunkRe = /^@@ .*?@@[^\n]*\n(?:[ +\-\\][^\n]*\n?)+/gm;
    const hunks: string[] = [];
    let hm: RegExpExecArray | null;
    while ((hm = hunkRe.exec(blob)) !== null) hunks.push(hm[0]);

    if (hunks.length === 0) {
      const firstNl = blob.indexOf("\n");
      hunks.push(firstNl >= 0 ? blob.substring(firstNl + 1) : blob);
    }

    files.push({ path: filePath, header, hunks });
  }

  return files;
}

export function countHunks(files: ParsedFile[]): number {
  return files.reduce((n, f) => n + f.hunks.length, 0);
}
