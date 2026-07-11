/** Role / workflow tool allowlist (config.toolAllowlist). */
export function isRoleToolAllowlisted(
  apiName: string,
  allowlist: string[] | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (allowlist.includes(apiName)) return true;
  if (allowlist.includes('mcp_*') && apiName.startsWith('mcp_')) return true;
  for (const pattern of allowlist) {
    if (pattern.endsWith('*') && apiName.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}