# Responsive layout

Design from constraints, not arbitrary device names.

- Identify the minimum width at which the primary task remains understandable.
- Reflow before truncating essential state.
- Keep the current action/state visible in narrow layouts.
- Test at least one wide, medium, and narrow viewport or terminal size.
- Avoid horizontal scrolling for ordinary content; when unavoidable, make the
  scroll region explicit and preserve controls.
- Long labels must truncate or wrap without breaking borders, alignment, or
  interaction targets.
- Do not hide critical error, progress, or accessibility information merely to
  fit a compact layout.
