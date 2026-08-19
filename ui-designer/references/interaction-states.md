# Interaction states

For every interactive element, verify the relevant states:

- default and selected;
- hover where pointer input exists;
- visible keyboard focus;
- pressed/active;
- disabled with an understandable reason where needed;
- loading without duplicate submission;
- success and error feedback;
- empty and partial-data states;
- long labels, localization growth, and overflow.

Selection and execution are separate concepts. A user may inspect one item while
another remains live. Provide an explicit return-to-live action rather than
silently stealing selection.
