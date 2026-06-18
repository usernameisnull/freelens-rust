# Resource Status Display

This document records where resource status values come from and how the UI
classifies them for display. The goal is to keep the Rust/Tauri app aligned
with the original Freelens renderer where the old app has explicit behavior.

## Pods

The Pods list status column must match the original Freelens
`Pod.getStatusMessage()` behavior. This is intentionally not the same as simply
showing `status.phase`.

### Display Priority

| Priority | Displayed status | Source fields | Rule |
| --- | --- | --- | --- |
| 1 | `Evicted` | `status.reason` | Display `Evicted` when `status.reason == "Evicted"`, even though `status.phase` is usually `Failed`. |
| 2 | `Terminating` | `metadata.deletionTimestamp`, `status.containerStatuses[].state.running`, `status.containerStatuses[].state.waiting` | Display `Terminating` when the pod is being deleted and at least one container is still running or waiting. |
| 3 | `Finalizing` | `metadata.deletionTimestamp`, `metadata.finalizers` | Display `Finalizing` when the pod is being deleted, no container is running or waiting, and finalizers remain. |
| 4 | `Running` | `status.phase` | Display the phase value when present. |
| 4 | `Pending` | `status.phase` | Display the phase value when present. |
| 4 | `Succeeded` | `status.phase` | Display the phase value when present. |
| 4 | `Failed` | `status.phase` | Display the phase value when present and no higher-priority rule applies. |
| 4 | `Unknown` | `status.phase` | Display the phase value when present. |
| 5 | `Waiting` | fallback | Display `Waiting` when no phase is available. |

### Why Evicted Is Special

Kubernetes commonly reports an evicted pod like this:

```yaml
status:
  phase: Failed
  reason: Evicted
```

The original Freelens app checks `status.reason` before `status.phase`, so the
Pods page displays `Evicted` instead of the less specific `Failed`.

### Color-Supported Pod Labels

The original Freelens workload styles include colors for these pod-related
labels:

| Label | Intended tone |
| --- | --- |
| `Running` | healthy |
| `Pending` | warning |
| `Restarted` | healthy |
| `Evicted` | error |
| `Waiting` | warning |
| `Succeeded` | success |
| `Failed` | error |
| `Terminating` | muted/terminated |
| `Finalizing` | muted/terminated |
| `Terminated` | muted/terminated |
| `Completed` | success |
| `CrashLoopBackOff` | error |
| `Error` | error |
| `ContainerCreating` | info |
| `ContainerEphemeral` | info |

Not every label above is produced by the Pods list status column. Some are
container-state or detail/status labels that the original app still styles.

## Nodes

| Displayed status | Source fields | Rule |
| --- | --- | --- |
| `Ready` | `status.conditions[?type == "Ready"].status` | Display `Ready` when the Ready condition is `True`. |
| `NotReady` | `status.conditions[?type == "Ready"].status` | Display `NotReady` when the Ready condition is not `True` or is missing. |
| `Ready,SchedulingDisabled` | `status.conditions`, `spec.unschedulable` | Append `SchedulingDisabled` when `spec.unschedulable == true`. |
| `NotReady,SchedulingDisabled` | `status.conditions`, `spec.unschedulable` | Same suffix rule for a not-ready node. |

## Workloads

The original Freelens app uses conditions and child pod state for several
workload views. This project currently exposes compact list columns from the
backend and colors those columns using the same healthy/warning/error idea.

### Deployments

| Column | Source fields | Display / color rule |
| --- | --- | --- |
| `ready` | `status.readyReplicas`, `spec.replicas` | Display `readyReplicas/spec.replicas`; healthy when ready >= desired, error when ready is 0, warning otherwise. |
| `upToDate` | `status.updatedReplicas`, `spec.replicas` | Healthy when updated >= desired, error when 0, warning otherwise. |
| `available` | `status.availableReplicas`, `spec.replicas` | Healthy when available >= desired, error when 0, warning otherwise. |

Original Freelens also styles Deployment conditions:

| Condition | Intended tone |
| --- | --- |
| `Available` | healthy |
| `Progressing` | info |
| `ReplicaFailure` | error |

### StatefulSets

| Column | Source fields | Display / color rule |
| --- | --- | --- |
| `ready` | `status.readyReplicas`, `spec.replicas` | Display `readyReplicas/spec.replicas`; healthy when ready >= desired, error when ready is 0, warning otherwise. |
| `upToDate` | `status.updatedReplicas`, `spec.replicas` | Healthy when updated >= desired, error when 0, warning otherwise. |
| `available` | `status.availableReplicas`, `spec.replicas` | Healthy when available >= desired, error when 0, warning otherwise. |

### DaemonSets

| Column | Source fields | Display / color rule |
| --- | --- | --- |
| `desired` | `status.desiredNumberScheduled` | Baseline for the other DaemonSet columns. |
| `current` | `status.currentNumberScheduled`, `status.desiredNumberScheduled` | Healthy when current >= desired, error when 0, warning otherwise. |
| `ready` | `status.numberReady`, `status.desiredNumberScheduled` | Healthy when ready >= desired, error when 0, warning otherwise. |
| `available` | `status.numberAvailable`, `status.desiredNumberScheduled` | Healthy when available >= desired, error when 0, warning otherwise. |

### Jobs

| Column | Source fields | Display / color rule |
| --- | --- | --- |
| `completions` | `status.succeeded`, `spec.completions` | Display `succeeded/completions`; healthy when succeeded >= desired, error when 0, warning otherwise. |
| `active` | `status.active` | Info when active > 0, muted when 0. |
| `failed` | `status.failed` | Error when failed > 0, muted when 0. |

Original Freelens computes a Job status from `status.conditions`:

| Displayed status | Source fields | Rule |
| --- | --- | --- |
| `Complete` | `status.conditions[].type/status` | A `Complete` condition with `status == "True"`. |
| `Failed` | `status.conditions[].type/status` | A `Failed` condition with `status == "True"`. |
| `Finalizing` | `metadata.deletionTimestamp`, `metadata.finalizers` | Deleting with finalizers. |
| `Terminating` | `metadata.deletionTimestamp` | Deleting without finalizers. |
| `Suspended` | `status.conditions[].type/status` | A `Suspended` condition with `status == "True"`. |
| `FailureTarget` | `status.conditions[].type/status` | A `FailureTarget` condition with `status == "True"`. |
| `Running` | fallback | Conditions exist, but none of the higher-priority conditions match. |
| `Unknown` | `status.conditions` | No conditions are present. |

### CronJobs

| Column | Source fields | Display / color rule |
| --- | --- | --- |
| `schedule` | `spec.schedule` | Plain text. |
| `suspend` | `spec.suspend` | Healthy when `false`, muted when `true`. |
| `active` | `status.active` | Plain count in this project. |
| `lastSchedule` | `status.lastScheduleTime` | Plain timestamp. |

Original Freelens summarizes CronJobs as:

| Displayed status | Source fields | Rule |
| --- | --- | --- |
| `Scheduled` | `spec.suspend` | CronJob is not suspended. |
| `Suspended` | `spec.suspend` | CronJob is suspended. |

## Storage

| Resource | Displayed status source | Notes |
| --- | --- | --- |
| `PersistentVolumeClaim` | `status.phase` | Examples include `Bound`, `Pending`, and `Lost`. |
| `PersistentVolume` | `status.phase` | Examples include `Available`, `Bound`, `Released`, `Failed`, and `Pending`. |

## Frontend Tone Mapping

The frontend maps values to tones before applying this project's colors:

| Tone | Examples | Current color role |
| --- | --- | --- |
| `success` | `Running`, `Ready`, `Bound`, `Available`, `Complete`, `Completed`, `Succeeded`, `Scheduled` | teal |
| `warning` | `Pending`, `Waiting`, `Restarted`, `Suspended`, `Unschedulable` | yellow |
| `error` | `Failed`, `Error`, `Evicted`, `CrashLoopBackOff`, `ReplicaFailure`, `FailureTarget` | red |
| `info` | `ContainerCreating`, `Progressing`, active Jobs | blue |
| `muted` | `Terminating`, `Terminated`, `Finalizing`, `Unknown`, `<none>` | gray |
| `neutral` | Any unrecognized value | inherit table text color |

