// Read-only admin bypass: when the panel URL carries ?force, OwnerGate renders
// without a wallet/signature and API requests append ?force so the backend skips
// owner-signature auth. This is a convenience bypass, not a security boundary —
// admin data is read-only and derivable from public chain events.
const STORAGE_KEY = "uscamex-admin-bypass-v1";

/** Read ?force from the current URL once and persist it for the session. Call at startup. */
export function initBypassFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("force")) sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // ignore
  }
}

export function isBypassActive(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearBypass(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
