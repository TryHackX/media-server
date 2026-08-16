import type { LibraryKind, RolePermissions, SessionResponse } from "./types";

/**
 * Client-side mirror of the server's authorization rules — used only to shape
 * the interface (hide controls, pick defaults). The bridge re-checks everything.
 */

/** An admin or super admin that is not a guest account bypasses group rights. */
export function isAdministrator(session: Pick<SessionResponse, "user">): boolean {
  const user = session.user;
  return (user.role === "admin" || user.role === "super_admin") && !user.is_guest;
}

/** Whether the signed-in account holds a group right (administrators always do). */
export function can(session: SessionResponse, permission: keyof RolePermissions): boolean {
  return isAdministrator(session) || session.permissions[permission] === true;
}

export function canEditMetadata(session: SessionResponse): boolean {
  return can(session, "can_edit_metadata");
}

export function canAccessLibrary(session: SessionResponse, kind: LibraryKind): boolean {
  return can(session, kind === "music" ? "can_access_music" : "can_access_movies");
}

export function canStreamCompat(session: SessionResponse): boolean {
  return can(session, "can_stream_compat");
}
