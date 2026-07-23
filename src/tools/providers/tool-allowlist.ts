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

/** Explicit denylist (config.toolDeny / eval strategy tool_deny). Checked before allowlist. */
export function isToolDenied(
  apiName: string,
  denylist: string[] | undefined,
): boolean {
  if (!denylist || denylist.length === 0) return false;
  if (denylist.includes(apiName)) return true;
  if (denylist.includes('mcp_*') && apiName.startsWith('mcp_')) return true;
  for (const pattern of denylist) {
    if (pattern.endsWith('*') && apiName.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

/** True when the tool may be exposed / executed for this config. */
export function isToolPermitted(
  apiName: string,
  allowlist: string[] | undefined,
  denylist: string[] | undefined,
): boolean {
  if (isToolDenied(apiName, denylist)) return false;
  return isRoleToolAllowlisted(apiName, allowlist);
}