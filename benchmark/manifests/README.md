# Frozen task manifests

One YAML file per task, content-addressed and immutable once frozen. See
[PLAN-v0.1.md](../../PLAN-v0.1.md) §5.7 for the field contract:

```yaml
task_id: <repo>-<issue#>
source: { issue, snapshot_at, prompt_sha256 }
repository: { repo, base_sha, fix_sha, verifier_sha }
verification: { baseline_command, reproducer, acceptance }
environment: { node, install_command, network }
calibration: { install_seconds, test_seconds }
gates: { baseline: {existing_suite: PASS}, reproducer: {base: FAIL}, official_fix: {existing_suite: PASS, reproducer: PASS} }
```

Pollution lockdown is part of the manifest's `environment.network`:
github/search/arbitrary-web DENY, registry allowlist only; the benchmark clone
has no `origin` remote and no fix commit in local history.
