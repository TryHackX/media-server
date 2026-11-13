/**
 * Where a menu goes, given the control that opened it — apart from the page, so
 * it can be tested without one.
 */

export interface MenuBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MenuPlace {
  left: number;
  top: number;
  /** Placed over the control rather than under it. */
  above: boolean;
}

/** The room kept between the menu and the control, and between the menu and the edge of the screen. */
export const MENU_GAP = 6;
export const MENU_MARGIN = 8;

/**
 * Under the control and flush with its right edge — a "⋯" stands at the right
 * end of its row, and a menu that opened to the right of it would leave the
 * card. Over the control when there is no room under it and more over it; and
 * in either case pushed back inside the screen, a margin from its edges. A menu
 * larger than the screen starts at the margin: its top is what must be seen.
 */
export function placeMenu(anchor: MenuBox, menu: { width: number; height: number }, viewport: { width: number; height: number }): MenuPlace {
  const below = viewport.height - anchor.bottom - MENU_GAP - MENU_MARGIN;
  const over = anchor.top - MENU_GAP - MENU_MARGIN;
  const above = menu.height > below && over > below;
  const wantedTop = above ? anchor.top - MENU_GAP - menu.height : anchor.bottom + MENU_GAP;
  const maxTop = viewport.height - MENU_MARGIN - menu.height;
  const top = Math.max(MENU_MARGIN, Math.min(wantedTop, maxTop));
  const maxLeft = viewport.width - MENU_MARGIN - menu.width;
  const left = Math.max(MENU_MARGIN, Math.min(anchor.right - menu.width, maxLeft));
  return { left: Math.round(left), top: Math.round(top), above };
}
