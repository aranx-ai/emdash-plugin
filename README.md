# Aranx plugin for EmDash

This plugin imports Aranx articles into an [EmDash](https://emdashcms.com)
site. It receives the signed Aranx webhook, fetches each article from the
Aranx API, saves it as an EmDash entry, and reports the status and live URL
back to Aranx.

It is a sandboxed plugin (`emdash-plugin.jsonc` and `src/plugin.ts`). It
needs EmDash 0.12 or later.

## Requirements

- A sandbox runner on the site. On Cloudflare Workers, this is the Workers
  Paid plan, a `LOADER` Worker Loader binding, and `PluginBridge` exported
  from the Worker entry point. See
  [Plugin sandbox](https://docs.emdashcms.com/deployment/plugin-sandbox/).
- A cron trigger that runs every minute (`* * * * *`). The EmDash Cloudflare
  templates include it. The plugin does its work in cron tasks.
- A collection with a title field and a Portable Text field. The default is
  `posts`.

## Install

The plugin is `@aranx.com/aranx` in the
[EmDash plugin registry](https://plugins.emdashcms.com/plugins/@aranx.com/aranx).
The registry is on when the site has a sandbox runner:

```ts title="astro.config.mjs"
import { sandbox } from '@emdash-cms/cloudflare';

emdash({
    sandboxRunner: sandbox()
});
```

In the EmDash admin, open **Plugins > Registry**, search for `aranx`, and
click **Install**. Accept the capabilities.

To run a local build instead, add it to `sandboxed`:

```sh
git clone https://github.com/aranx-ai/emdash-plugin.git
cd emdash-plugin && pnpm install && pnpm build
# In the EmDash site:
pnpm add file:../path/to/emdash-plugin
```

```ts title="astro.config.mjs"
import aranx from 'aranx';

emdash({
    sandboxed: [aranx],
    sandboxRunner: sandbox()
});
```

## Configure

1. In Aranx, create an API connection for the website. Copy the API key and
   the webhook signing secret.
2. In EmDash, open **Plugins > Aranx > Settings**. Paste the API key and the
   webhook secret. Change the collection or category taxonomy if the site
   does not use `posts` and `category`.
3. Open the **Aranx** admin page and copy the webhook URL. It is
   `https://<your-site>/_emdash/api/plugins/<plugin id>/webhook`. A registry
   install has the ID `r_otneixpnd6iliahd`. A local install has the ID
   `aranx`.
4. In Aranx, set that URL as the webhook URL of the API connection. Send a
   test event.

## How it works

The webhook route checks the signature, then queues a cron task and answers
`202`. A sandboxed call allows about 10 subrequests, so one import runs as a
chain of one-shot tasks:

| Task      | Work                                                                   |
| --------- | ---------------------------------------------------------------------- |
| `article` | Fetch the article, upload the featured image, create or update the entry. |
| `terms`   | Create missing category terms and assign them. Runs only when categories change. |
| `publish` | Publish when Aranx asks or the entry is live. Then report to Aranx.    |
| `report`  | Report the entry state after an editor publishes, unpublishes, schedules, or deletes it. |
| `feed`    | Read the Aranx change feed every 15 minutes and queue changed articles. |

The plugin follows the Aranx integration contract:

- The API is the source of truth. Entries are matched by the Aranx article ID.
- `requested_status: "draft"` saves a draft. It never takes a live entry
  down.
- An article found by the feed is saved as a draft. Only a webhook with
  `requested_status: "published"` or an editor publishes it.
- A deleted article moves its entry to the trash. An entry that an editor
  trashed stays in the trash.
- The plugin pins the first `website_id` it receives and rejects others.

The sandbox cannot set the `X-Aranx-Webhook-Features` header. The route
answers the signed `GET` feature check with
`{"features": ["requested_status"]}` instead.

## Limitations

- EmDash makes the slug from the title. The plugin cannot set it.
- SEO title and description are set when the entry is created. The EmDash
  1.4 sandbox rejects `seo` on update, so later changes do not update them.
- The sandbox cannot rename or delete taxonomy terms. Renamed or deleted
  Aranx categories keep their old terms.
- EmDash headings have no IDs, so the plugin drops the Aranx table of
  contents. Link `rel` values are not kept.
- An event that arrives while a task of the same name runs is lost. The
  feed finds the change within 15 minutes.
- Articles deleted for good in Aranx without a webhook are not found. There
  is no full scan.

## Develop

```sh
pnpm install
pnpm test        # validate the manifest, then run Vitest
pnpm typecheck
pnpm build
```

`tests/sync.test.ts` runs the plugin in the EmDash test runtime with a mock
Aranx API.

## Release

The publisher is `did:web:pds.aranx.com` (handle `aranx.com`). GitHub
Actions publishes releases through the
[EmDash release service](https://docs.emdashcms.com/plugins/creating-plugins/delegated-releases/).
No one logs in for a release.

Changes go to `dev` through pull requests. `main` holds released code.

1. Raise `version` in `package.json` in a pull request to `dev`. Published
   versions cannot change.
2. Open a pull request from `dev` to `main` and merge it.
3. `.github/workflows/tag-release.yml` runs on the merge. If no tag
   `aranx@<version>` exists, it creates the tag and starts
   `.github/workflows/emdash-release.yml` on it. A merge that does not
   change `version` releases nothing.
4. `emdash-release.yml` builds the bundle, attests it, and submits it. A
   release that adds capabilities waits for approval by the publisher.
   Other releases publish at once.
5. Run `pnpm exec emdash-plugin info aranx.com aranx --watch` until the
   registry checks pass.

The run can end with `RELEASE_CONFLICT` although the release is published
(EmDash issue [#4472](https://github.com/emdash-cms/emdash/issues/4472)).
Check the release with `info`, not with the run status.

If `tag-release.yml` fails, push the tag by hand. The tag push starts
`emdash-release.yml`:

```sh
git switch main && git pull
git tag aranx@<version>
git push origin aranx@<version>
```

A release ignores changes to the name, description, keywords, license,
authors, and security contacts in `emdash-plugin.jsonc`. To publish them,
run `pnpm exec emdash-plugin update-package`, check the diff, then run it
again with `--yes`. No release is needed.

### Listing images

The icon and banner on
[plugins.emdashcms.com](https://plugins.emdashcms.com/plugins/@aranx.com/aranx)
come from the latest release, not from the package profile. They are set in
`release.artifacts` in `emdash-plugin.jsonc`. To change an image, replace the
file and cut a new release.

| Slot          | File                | Size                                  |
| ------------- | ------------------- | ------------------------------------- |
| `icon`        | `assets/icon.png`   | 256 x 256                             |
| `banner`      | `assets/banner.png` | 1500 x 500. The site crops it to 3:1. |
| `screenshots` | none yet            | Up to 8, at most 1920 x 1080          |

Each image is a PNG, JPEG, or WebP file of at most 1 MB.

The release action needs the `plugin-directory` input to upload the images.
Before EmDash PR [#4467](https://github.com/emdash-cms/emdash/pull/4467), it
dropped them, so 0.1.4 shipped without images. 0.1.5 is the first release
with them.

### Registry status

`info` shows "waiting for checks" when the registry labeler has no
assessment for a record. It does not mean the record is in a review queue.
The labeler finds records through Jetstream, which reads the Bluesky relay
`bsky.network`. If the relay does not know the PDS, the registry never sees
a release. To check the relay:

```sh
curl "https://bsky.network/xrpc/com.atproto.sync.getHostStatus?hostname=pds.aranx.com"
```

If it returns `HostNotFound`, ask the relay to crawl the PDS, then cut a new
release. Jetstream does not replay old records.

```sh
curl -X POST https://bsky.network/xrpc/com.atproto.sync.requestCrawl \
  -H 'content-type: application/json' --data '{"hostname":"pds.aranx.com"}'
```

"Needs review" means that a person at EmDash must look at the listing. The
JSON output (`info ... --json`) gives the reason codes.
