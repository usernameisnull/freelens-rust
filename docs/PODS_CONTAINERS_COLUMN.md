# Pods Containers Column

This document defines the behavior contract for adding a `Containers` column to
the Pods page. The goal is full behavior parity with the original Freelens
renderer, while adapting colors to this project's existing palette.

## Freelens Reference Points

The original Freelens implementation is split across these renderer pieces:

- Column rendering: `packages/core/src/renderer/components/workloads-pods/columns/pods-containers-column.injectable.tsx`
- Container status class selection: `packages/core/src/renderer/components/workloads-pods/container-status-class-name.tsx`
- Status brick DOM and visual style: `packages/core/src/renderer/components/status-brick/status-brick.tsx` and `status-brick.scss`
- Tooltip layout: `packages/ui-components/tooltip/src/tooltip.tsx` and `tooltip.scss`, using the `tableView` and `nowrap` formatters

The Rust/Tauri implementation should match the behavior of those components,
not only the visible text.

## Column Behavior

The Pods table should include a `Containers` column.

Each pod row renders one status brick per declared container. The brick order
must match Freelens:

1. Regular containers from `spec.containers`
2. Init containers from `spec.initContainers`
3. Ephemeral containers from `spec.ephemeralContainers`

Each brick represents exactly one container. Hovering a brick shows that
container's tooltip only. The tooltip is not a row-level or column-level
summary.

The column sort value should be the total count of container status objects:

```text
status.containerStatuses.length
+ status.initContainerStatuses.length
+ status.ephemeralContainerStatuses.length
```

Keep existing Pods list columns unchanged unless the implementation explicitly
adds the new `Containers` column:

- `columns.ready` keeps its current ready/total behavior.
- `columns.restarts` keeps its current restart-count behavior.
- Existing status, metrics, actions, logs, and terminal workflows should not
change.

## Container Data Sources

Rendering requires matching declared containers with runtime statuses by name.

Declared containers come from:

- `spec.containers`
- `spec.initContainers`
- `spec.ephemeralContainers`

Runtime statuses come from:

- `status.containerStatuses`
- `status.initContainerStatuses`
- `status.ephemeralContainerStatuses`

For each declared container, find the status object with the same `name`. A
missing status is allowed and should render as the default/vague brick with an
empty tooltip body.

## Status Class Selection

The status class must follow Freelens priority exactly:

| Priority | Condition | Class |
| --- | --- | --- |
| 1 | `status.state.terminated` exists | `terminated` |
| 2 | container type is `ephemeralContainers` and `status.lastState.terminated` exists | `terminated` |
| 3 | container type is `ephemeralContainers` | `container-ephemeral` |
| 4 | `status.ready == true` and `status.restartCount > 0` | `restarted` |
| 5 | `status.ready == true` | `running` |
| 6 | `status.state.running` exists but the container is not ready | `waiting` |
| 7 | otherwise | active state key, such as `waiting`, `terminated`, or empty/default |

The "active state key" is the first key present in `status.state`, matching the
Freelens `Object.keys(status?.state ?? {})[0]` behavior.

## Brick Visuals

Each status brick should visually match Freelens in shape and state semantics:

- Size: 8px by 8px
- Shape: square with 2px radius
- Layout: inline, with a small right margin except on the last brick

Use this project's existing palette equivalents instead of copying raw
Freelens CSS variables:

| Class | Visual behavior |
| --- | --- |
| default / empty | muted/vague background |
| `running` | healthy background |
| `restarted` | healthy background plus warning outline |
| `terminated` | transparent background with terminated/muted border |
| `failed` | failed/error icon treatment or closest error equivalent |
| `waiting` | translucent warning background plus warning border |
| `container-ephemeral` | info background |

The `restarted` outline is part of the parity requirement; it should not be
collapsed into the same appearance as `running`.

## Tooltip Content

Every brick should have a hover tooltip using a table-like layout equivalent to
Freelens `tableView + nowrap`.

The first row is a title:

```text
<container name> <secondary metadata>
```

The secondary metadata is derived in this order:

- Active state: `running`, `waiting`, or `terminated`
- `, init` when the declared container type is `initContainers`
- `, ephemeral` when the declared container type is `ephemeralContainers`
- `, restarted` when `restartCount > 0`
- `, ready` when `ready == true`
- ` - <terminated.reason> (exit code: <terminated.exitCode>)` when the active
  state is terminated

Examples:

```text
nginx running, ready
migrate terminated, init - Completed (exit code: 0)
debugger running, ephemeral
api running, restarted, ready
```

After the title, list all fields from the active state object as name/value
rows. Convert field names to title case, matching Freelens `startCase`.

Expected examples by state:

| State | Detail rows |
| --- | --- |
| `running` | `Started At` |
| `waiting` | `Reason`, `Message` |
| `terminated` | `Started At`, `Finished At`, `Exit Code`, `Reason`, `Signal`, `Message` |

If a field value is null or missing, render an empty value for that row when the
field is present in the state object. If there is no active state, render the
brick with no detail rows.

## Tooltip Layout

The tooltip should follow the Freelens table formatter behavior:

- Tooltip content is a grid with two columns: label and value.
- The `.title` row spans both columns, is centered, and is bold.
- `.name` cells are right-aligned.
- `.value` cells are left-aligned and use secondary text color.
- `nowrap` behavior is enabled so tooltip text stays on one line unless the
  viewport makes wrapping unavoidable.
- Tooltip appears for the hovered brick target, not for the whole table cell.

## Future Interface Shape

The current `ResourceItem.columns: Record<string, string>` shape is not enough
for full parity because the column needs structured per-container data and raw
state detail fields.

Add a Pods-only structured field in the resource list response, for example:

```ts
interface ResourceItem {
  // existing fields unchanged
  podContainers?: PodContainerSummary[];
}

interface PodContainerSummary {
  name: string;
  type: "containers" | "initContainers" | "ephemeralContainers";
  ready: boolean;
  restartCount: number;
  state: PodContainerState;
  lastState: PodContainerState;
}

interface PodContainerState {
  running?: Record<string, string | number | boolean | null>;
  waiting?: Record<string, string | number | boolean | null>;
  terminated?: Record<string, string | number | boolean | null>;
}
```

The exact Rust structs should preserve this wire shape with camelCase JSON.
Only Pods need this field; non-Pod resources should omit it.

## Implementation Acceptance Criteria

An implementation satisfies this document when:

- Pods table has a `Containers` column.
- One brick is rendered for every regular, init, and ephemeral container.
- Brick order matches declared container order across the three groups.
- Brick classes follow the priority table above.
- Brick visuals match the documented status semantics using this project's
  palette.
- Hovering a brick shows only that container's tooltip.
- Tooltip title and detail rows match Freelens wording and field order.
- Existing `ready`, `restarts`, Pod status, logs, terminal, and metrics behavior
  remains unchanged.

## Test Plan

Add unit coverage for status-class mapping:

- ready running -> `running`
- ready with `restartCount > 0` -> `restarted`
- running but not ready -> `waiting`
- waiting -> `waiting`
- terminated -> `terminated`
- active ephemeral container -> `container-ephemeral`
- ephemeral container with `lastState.terminated` -> `terminated`

Add backend/resource-list coverage:

- regular containers are included
- init containers are included after regular containers
- ephemeral containers are included after init containers
- status objects are matched by name
- missing status produces a default/vague brick-compatible summary

Add frontend rendering or smoke coverage:

- one brick appears per container
- brick classes and colors match the mapped state
- tooltip title includes state/type/restarted/ready/terminated metadata
- tooltip detail rows include raw active state fields
- Pods table sorting and virtualization still work with the new column

## Assumptions

- "Full parity" means matching the original Freelens behavior and DOM semantics
  at the feature level, while using this project's color palette.
- This document is the first step only. Code changes for the column should be
  implemented separately after this contract is accepted.

