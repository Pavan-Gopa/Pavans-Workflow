# Kick: Designer

Main sends one compact self-contained packet.

## Advisory template

```text
mode: advisory
step: <step id>
work_item_ids: [<stable IDs>]
Human feedback: <verbatim complaint/request>
Target surface: <screen/component/route/panel>
Source paths: [<read paths>]
Preserve: [<behavior/contracts>]
Constraints: [<platform/design-system/cost constraints>]
Visual evidence: <screenshot/capture/reproduction path or unavailable>
Deliverable: concrete implementation-ready design brief
```

## Implementation template

```text
mode: implementation
step: <step id>
work_item_ids: [<stable IDs>]
Human feedback: <verbatim complaint/request>
Target surface: <screen/component/route/panel>
target_files: [<explicit presentation/UI/test paths>]
exclusions: [<backend/API/schema/security/unrelated paths>]
Preserve: [<behavior, shortcuts, localization, accessibility>]
Visual acceptance: [<observable criteria>]
Objective Gates: [<exact commands/artifacts>]
Existing evidence: <screenshots/captures/brief>
```

## Result handling

- Advisor `design_ready`: Main verifies specificity, then routes the brief to
  Coder unless the Human asks Designer to implement directly.
- Designer `waiting_review`: Main inspects actual diff and visual artifacts,
  then Reviewer and enabled Tester run normally.
- Human visual acceptance closes the design request; Reviewer/Tester green alone
  does not prove the Human likes the result.
- `blocked`: Main records the exact missing capability or out-of-scope change and
  selects Coder, Architect, Human input, or a narrower design task.
