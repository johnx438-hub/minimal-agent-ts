/**
 * After run ends, only refresh session *list* (sidebar Recap / task_count).
 * Chat body stays live-authoritative — no automatic loadHistory (avoids flicker).
 */
export const POST_RUN_CATALOG_MS = 800;

/** @deprecated use POST_RUN_CATALOG_MS — history no longer auto-synced on run end */
export const POST_RUN_SYNC_MS = POST_RUN_CATALOG_MS;

/** Sticky hold after run: pending strip + shell collapse height only (no history remount). */
export const POST_RUN_STICKY_HOLD_MS = 1200;
