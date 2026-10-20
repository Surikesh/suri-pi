export function isEditingTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "input, textarea, select, [contenteditable='true'], [role='textbox'], .xterm",
      ),
    )
  );
}
