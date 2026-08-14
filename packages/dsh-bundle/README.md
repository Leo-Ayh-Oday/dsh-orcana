# @orcana/dsh-bundle

Profile bundle for `dsh --profile orcana`: installs `@orcana/dsh-governor`
and coordinates it with `repeat-tool-reminder`.

Contract: the package manifest declares `"dsh": { "bundle": { "patch":
"./cordis.patch.yml" } }`, making it an installable patch layer
([bundle contract](../../deepseek-harness/packages/bundle/README.md)).

## Known Limitations

- The `exclude` override of `repeat-tool-reminder` targets the row id from
  `dsh-base`; a profile that does not load `dsh-base` leaves the patch as a
  per-entry Loader warning (harmless, matches DSH patch semantics).
