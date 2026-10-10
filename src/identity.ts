/** Last path component of a URL or path, without a trailing `.git` or slash. */
export function nameFromUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "").replace(/\.git$/, "");
  const last = trimmed.split(/[/:]/).pop();
  return last || url;
}

/** SwiftPM's package identity for a source-control URL. */
export function identityFromUrl(url: string): string {
  return nameFromUrl(url).toLowerCase();
}

/** Normalized URL for comparisons (scheme-less, no `.git`, lowercase). */
export function canonicalUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}
