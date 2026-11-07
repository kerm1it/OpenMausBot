# Releasing

For a normal release, run **Actions → Prepare next release → Run workflow** and
choose a patch, minor, or custom version. It opens a tiny version-bump PR;
merging that PR automatically starts **Release** and assembles a draft from the
exact merge commit. Review and publish the draft when it is ready.

The existing **Actions → Release → Run workflow** button remains available for
reruns and recovery. It
builds unsigned macOS DMGs (arm64 + x64), Windows, and Ubuntu
from a single pinned commit, verifies every artifact the way a user would
receive it, and assembles a draft in this repository's GitHub Releases.
The unsigned macOS packages are manual downloads: Gatekeeper requires the user
to approve the app, and no macOS auto-update feed is published. Windows and
Linux keep their updater feeds.

Tick **publish** to publish immediately. Leave it unticked to review the draft;
when the draft is published in GitHub's UI, the **Verify published release**
workflow checks the published asset inventory and digests.

The release commit must have passed CI on every platform: the **CI passed on
the release commit** job waits (while the platforms build) for a ci.yml run
whose `CI` check passed with every Linux, Windows and macOS shard, on the
pinned commit or a commit with the same tree, and stops the release before any
draft if the commit's CI failed. A push to main runs the Linux shards only, so
unless the release branch's own CI (started by **Prepare next release**) or a
nightly run covered the same tree, the job runs the full CI on the commit
itself on a temporary `release-ci/v<version>` branch, which takes about as
long as the platform builds. After a flaky failure, re-run the failed CI jobs;
a release still waiting picks up the new attempt, and a release that already
stopped needs only `gh run rerun <id> --failed`. `ship_without_ci` skips the
wait, for emergencies only. See [CI job selection](ci.md#main-and-releases).

The workflow refuses to overwrite an already-published version. Manual Release
runs still require `package.json`'s version to be bumped on the selected ref.
A release is rejected if any installer, stable download
name, Windows/Linux updater feed, blockmap, size, or digest is absent or inconsistent.

GitHub generates the release body from pull requests since the previous tag.
The docs changelog caches published releases for five minutes.
Configure the optional Vercel hook below to rebuild the docs immediately after
publication; otherwise the live cache or the next normal docs deployment
refreshes it.

The npm package is published separately and its versioned `.tgz` may be attached
after the desktop assets have been verified.

## Why the gates exist

The workflow rejects stale output, packaged-server failures, helper paths that
resolve outside the app, incomplete artifacts, mismatched updater metadata,
and a draft that does not target the pinned commit.

## Bundled browser gates

Desktop builds also stage a pinned engine and Chromium Headless Shell before
packaging. Native browser smoke tests run on the packaged output. See
[browser packaging](browser-packaging.md) for update ownership, license
provenance and Linux sandbox constraints. Missing browser resources must fail
the build, not ship an installer that downloads them on first use.

## One-time setup

The **Prepare next release** workflow also needs
**Settings → Actions → General → Workflow permissions → Allow GitHub Actions
to create and approve pull requests** enabled. The workflow only creates the
version PR; it never approves or merges it.

### Optional `DOCS_DEPLOY_HOOK_URL`

In Vercel, open the docs project and create a **Deploy Hook** for its production
branch. Store that private URL as the `DOCS_DEPLOY_HOOK_URL` repository secret.
Publishing a release then requests a fresh docs deployment so the generated
changelog appears immediately. Do not put the hook URL in source control.

### Local fallback

For an unsigned local macOS build, set `CSC_IDENTITY_AUTO_DISCOVERY=false`, run
the preparation commands from the macOS job in `release.yml`, and invoke
`electron-builder --mac dmg --arm64 --x64 --publish never`. Upload both
versioned DMGs and their stable-named copies to the matching release.
