// A list that is redrawn from scratch throws away the button that was just pressed, and keyboard focus with it.
// This runs the redraw and then puts focus back: on the same control in the same row, else on that row's first
// control, else on `fallback` (usually the panel's heading).
export function keepFocus(root: HTMLElement, rowSelector: string, actionAttr: string, draw: () => void, fallback?: HTMLElement | null): void {
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const keyOf = (row: HTMLElement | null | undefined): string | undefined => row?.dataset.id || row?.dataset.job;
  const rowKey = keyOf(active?.closest<HTMLElement>(rowSelector));
  const action = active?.closest<HTMLElement>(`[${actionAttr}]`)?.getAttribute(actionAttr);
  draw();
  if (!active || active.isConnected) return;
  const row = rowKey ? Array.from(root.querySelectorAll<HTMLElement>(rowSelector)).find((r) => keyOf(r) === rowKey) : undefined;
  const same = action ? Array.from(row?.querySelectorAll<HTMLElement>(`[${actionAttr}]`) ?? []).find((el) => el.getAttribute(actionAttr) === action) : undefined;
  const target = same ?? row?.querySelector<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])") ?? fallback;
  if (!target) return;
  if (target === fallback && !target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus();
}

/**
 * Marks a control as busy without the `disabled` attribute, which makes the browser drop keyboard focus at once.
 * A busy control keeps focus and ignores further presses (the click handlers check `isBusy`).
 */
export function setBusy(el: HTMLElement, busy: boolean): void {
  if (busy) el.setAttribute("aria-disabled", "true"); else el.removeAttribute("aria-disabled");
}
export const isBusy = (el: HTMLElement): boolean => el.getAttribute("aria-disabled") === "true";
