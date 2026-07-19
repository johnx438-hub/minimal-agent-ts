/**
 * Shared delay for post-run catalog/history refresh.
 * Thread sticky hold should cover this window so loadHistory remount
 * does not leave the viewport stranded mid-thread (esp. on slower laptops).
 */
export const POST_RUN_SYNC_MS = 4000;

/** Extra cushion after sync network round-trip + paint. */
export const POST_RUN_STICKY_HOLD_MS = POST_RUN_SYNC_MS + 900;
