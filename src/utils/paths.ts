/** Compare native dialog and canonical Windows paths using the same identity. */
export function normalizeVideoPath(path: string): string {
  return path.replaceAll("/", "\\")
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\+$/, "")
    .toLowerCase();
}
