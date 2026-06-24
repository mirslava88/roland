// Convert an absolute local file path into a URL served by the privileged
// `pdm-media://` protocol (registered + handled in the main process).
//
// Needed because the control/presentation renderers run with webSecurity:true,
// so a file:// (or http://localhost in dev) document cannot load cross-origin
// file:// resources directly — SOP blocks it. The custom privileged scheme is
// treated as secure/standard, so the browser loads it, and main streams the
// validated local file back.
//
// encodeURIComponent safely encodes backslashes, colons, spaces and non-ASCII
// (Cyrillic) characters, so the path round-trips through the URL untouched.
export function mediaUrl(absPath: string): string {
  return `pdm-media://file/${encodeURIComponent(absPath)}`
}
