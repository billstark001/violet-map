/** Native tab keyboard navigation. Activation uses the button's normal click
 * handler, keeping focus and controlled selection on the same tab. */
export function handleTabKey(event: KeyboardEvent & { currentTarget: HTMLDivElement }): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]')];
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || tabs.length === 0) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}
