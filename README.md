# Bitmovin Player CMCD Integration

This project adds support for the Common Media Client Data (CMCD) plugin. Please find more information about the Consumer Technology Association (CTA) Specification in https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf

## Install
Install with npm:
```
npm install --save @bitmovin/player-web-integration-cmcd
```

## Usage

Create an instance of the `CmcdIntegration` with a `CmcdConfig` and set the different callbacks in the `PlayerConfig` as follows:

```ts
const playerConfig: PlayerConfig = {
  // all configurations you would typically set
};

const cmcdConfig: CmcdConfig = {
  useQueryArgs: true,
  sessionId: '6e2fb550-c457-11e9-bb97-0800200c9a66',
  contentId: '1111-111111-111111-11111',
};

const cmcdIntegration = new CmcdIntegration(cmcdConfig);

playerConfig.network = {
  preprocessHttpRequest: cmcdIntegration.preprocessHttpRequest,
  preprocessHttpResponse: cmcdIntegration.preprocessHttpResponse,
};
playerConfig.adaptation = {
  desktop: {
    onVideoAdaptation: cmcdIntegration.onVideoAdaptation,
    onAudioAdaptation: cmcdIntegration.onAudioAdaptation,
  },
  mobile: {
    onVideoAdaptation: cmcdIntegration.onVideoAdaptation,
    onAudioAdaptation: cmcdIntegration.onAudioAdaptation,
  },
};
```
After that, you create a Bitmovin Player instance as usual, then pass the player instance to the CMCD integration:
```js
cmcdIntegration.setPlayer(player);
```

It is recommended to set the CMCD Session ID to the Analytics Impression ID as this enables you to connect CDN logs with CMCD data to Analytics sessions:
```js
cmcdIntegration.setSessionId(player.analytics.getCurrentImpressionId());
```

Load the source into the player after these steps:
```js
player.load(source);
```

## CMCD v2

CMCD v1 is the default. To send CMCD v2 (CTA-5004-A) Request Mode data, set `version: 2`:

```ts
const cmcdConfig: CmcdConfig = {
  version: 2,
  useQueryArgs: true,
  sessionId: '6e2fb550-c457-11e9-bb97-0800200c9a66',
  contentId: '1111-111111-111111-11111',
};
```

Differences to v1:
- `v=2` is sent with each request.
- Keys of type Inner List always use list syntax, e.g. `bl=(2000)`, `nor=("seg2.m4s")`. `br`, `lb`, `pb` and `tb` carry the object type of audio and video requests as parameter, e.g. `br=(3000;v)`. Audio requests carry `;a`, as video requests carry `;v` in spec example 8.1.1 (example 8.1.2 omits it for audio).
- `pr` is sent in `CMCD-Status` as Decimal, e.g. `pr=2.0`.
- `cid` can have up to 128 characters (`sid` up to 64).
- `nor` is sent as plain relative path. It is URL encoded only with the whole payload in query mode.
- `nrr` is not sent.
- All values follow RFC 8941 (Structured Field Values). Values that do not comply, e.g. strings with characters outside printable ASCII, are omitted with a console warning, also in query mode.
- Custom key names must be valid RFC 8941 keys (lowercase). Custom values are sent as String (numbers are converted) of up to 64 characters; longer values are omitted with a console warning.

Additional keys in v2:

| Key | Description | Source |
| --- | --- | --- |
| `sta` | Play state: `d` before play, `s` starting, `p` playing, `k` seeking, `r` rebuffering, `a` paused, `e` ended, `f` fatal error | Player events and state at request time |
| `sn` | Sequence number per origin (report destination), starting at 0 | Counted per request |
| `msd` | Startup delay from `Play` to `Playing`, sent once per session id with the next request | Player events |
| `pt` | Playhead time in ms. VOD: offset from the start. Live: epoch ms if the player knows the wallclock time, else the player's current time | `getCurrentTime()` |
| `bsa`, `bsda` | Rebuffering count and duration since session start, also when 0 | `StallStarted`/`StallEnded` |
| `bsd` | Durations of the completed rebufferings, reported once to each origin | `StallStarted`/`StallEnded` |
| `ec` | Player error codes, reported once to each origin. Warnings are not reported, as their codes overlap with error codes | `Error` events |
| `lb` | Lowest bitrate of the requested media type | `getAvailableVideoQualities()`/`getAvailableAudioQualities()` |
| `tbl` | Target buffer length of the requested media type | `buffer.getLevel()` |
| `pb` | Bitrate being played of the requested media type | `getPlaybackVideoData()`/`getPlaybackAudioData()` |
| `dfa` | Dropped frames since session start, video requests only, also when 0 | `getDroppedVideoFrames()` |
| `ltc` | Live latency | `lowlatency.getLatency()` |

Rebuffering excludes stalls during startup and seeking. With `PlaybackConfig.autoplay`, `msd` is measured from the `Play` event of the autoplay.

`sn`, `bsa`, `bsda`, `dfa` and `msd` continue across sources until the application sets a new session id with `setSessionId`. A new session id resets them. `bsd` and `ec` are buffered per origin for up to 16 origins; the least recently used origin is dropped.

Known limitation: if the browser blocks autoplay, `sta` stays `s` until playback starts.

Not implemented:
- `bg`, `nr`, `cs`: no reliable source
- `tpb`: increases the fingerprinting surface and SHOULD NOT be sent by default
- `ab`, `lab`, `tab`: only for unknown individual bitrates, which the player always knows
- `st=ll`: the player does not expose whether a stream is low latency
- `sta=q` (quit) and `sta=w`
- Multiple values per key, e.g. `nor` with more than one object or `bl` for audio and video in one request

## CMCD v2 Event Mode

Event Mode sends reports at player events to one or more endpoints of your choice, as `text/cmcd` HTTP POST body. It is opt-in and independent of Request Mode. It always uses v2 syntax, also if Request Mode uses v1 (`version` unset or 1).

```ts
const cmcdConfig: CmcdConfig = {
  sessionId: '6e2fb550-c457-11e9-bb97-0800200c9a66',
  contentId: '1111-111111-111111-11111',
  eventTargets: [
    {
      url: 'https://collector.example.com/cmcd',
      events: ['ps', 'e', 't', 'rr'],
      batchSize: 10,
      authorization: 'Bearer <token>',
    },
  ],
};
```

`sessionId` and `contentId` (and `setSessionId`/`setContentId`) apply to both modes. `cmcdIntegration.destroy()` sends the pending reports and removes all listeners and timers. With Event Mode, this is also done on the player `Destroy` event. The instance cannot be used afterwards.

Settings per target:

| Setting | Default | Description |
| --- | --- | --- |
| `url` | required | Endpoint. The reports are sent with `fetch`, `Content-Type: text/cmcd`. |
| `events` | `ps`, `e`, `t`, `rr` | Events to report |
| `keys` | all | Keys to send. `e`, `ts`, `v`, `sid`, `cid` and the key that the event requires (`sta` for `ps`, `ec` for `e`, `cen` for `ce`, `url` for `rr`, `h` for `h`) are always sent. |
| `intervalMs` | `30000` | Interval of `t` reports and of sending batched reports, while a source is loaded. Values from 1 to 999 are raised to 1000. `0` disables both. |
| `batchSize` | `1` | Number of reports per request |
| `authorization` | none | Value of the `Authorization` header |
| `customKeys` | none | Custom keys for all reports of this target |
| `urlFilter` | `noQuery` | Part of the request URL sent in `url`: `full` (without fragment), `noQuery`, `origin`, or a function that returns the value or `null` |

Events:

| Event | Trigger |
| --- | --- |
| `ps` | Play state change, with `sta`: `SourceLoaded`, `Play`, `Playing`, `Paused`, `Seek`/`Seeked`, `TimeShift`/`TimeShifted`, `StallStarted`/`StallEnded`, `PlaybackFinished`, `Error` |
| `e` | `Error`, with the error code in `ec` |
| `t` | Interval while a source is loaded |
| `rr` | Each response (`preprocessHttpResponse`), with `url` (before redirects and without CMCD), `rc`, `ttlb`, `ttfb` (if the player measures it), `ot`, and `cmsdd`/`cmsds` (Base64 of the `CMSD-Dynamic`/`CMSD-Static` response headers, if readable). `ts` is the request start. |
| `c` | `setContentId` with a different id |
| `h` | Hostname of manifest or media requests changed (not for the first one) |
| `m`, `um` | `Muted`, `Unmuted`. Also sent when the player or the application mutes, not only for user actions. |
| `bc` | `VideoDownloadQualityChanged`/`AudioDownloadQualityChanged` (not for the first quality of a source) |
| `abs`, `abe`, `as`, `ae`, `sk` | `AdBreakStarted`, `AdBreakFinished`, `AdStarted`, `AdFinished`/`AdError`/`AdSkipped`, `AdSkipped`. `ae` and `abe` are only sent after `as` and `abs`. The application sets `cid` during ads with `setContentId`; `nr` is not sent. |
| `ce` | `cmcdIntegration.sendCustomEvent(name, customKeys?)`, with `cen` of up to 64 characters |

Each report carries `e`, `ts` (event time, epoch ms), `v=2`, `sn` (per target, starting at 0, reset by a new session id) and the known state keys: `sid`, `cid`, `sta`, `sf`, `st`, `pr`, `pt`, `ltc`, `bsa`, `bsda`, `dfa`, `h`, and per media type `bl`, `tbl`, `br`, `mtp`, `pb`, `tb`, `lb`, e.g. `br=(4200;v 256;a)`. `bsd`, `ec` and `msd` are buffered per target and sent once with its next report. `bs` is sent with the first report after a rebuffering started, and while it lasts.

Transport per target:
- 2xx: success.
- 410: no more reports to this target until the application sets a new session id.
- 429, 5xx, network errors and requests without response after 10 s: the reports are kept and sent again after 2, 4, 8, ... seconds, or after the `Retry-After` time if it is longer (max. 120 s), together with the reports created meanwhile.
- Redirects are followed, but only 307 and 308 keep the POST body: 301, 302 and 303 turn it into a GET without reports. A followed redirect logs a console warning once. A redirect that is not followed counts as failure; its reports are dropped with a warning.
- Other status codes: the reports are dropped with a warning.
- Offline: the reports are kept and sent when the browser is online again.
- Up to 200 reports are queued per target; the oldest are dropped first.
- Pending reports are sent on `SourceUnloaded`, `pagehide`, when the page is hidden, on player `Destroy` and on `destroy()`. These requests use `keepalive`, so they can outlive the page. Browsers limit all pending `keepalive` bodies to 64 KiB in total, so large batches are split, and requests beyond that limit are sent without `keepalive`.
- Without `fetch`, Event Mode is disabled with a console warning. Errors are never thrown to the player or the application.

Notes:
- Privacy: `url` can contain personal data or access tokens. By default, query and fragment are removed. Use `urlFilter` to send less (`origin`) or more (`full`).
- Request volume: with `rr` and the default `batchSize` of 1, each media request causes one report request. Use a larger `batchSize`, or remove `rr` from `events`.
- The endpoint must allow CORS for `POST` with the headers `Content-Type` and (if used) `Authorization`, as `text/cmcd` causes a preflight request.
- `cmsdd`/`cmsds` need `Access-Control-Expose-Headers` for the CMSD headers on cross-origin media responses, and `Retry-After` needs it on cross-origin endpoint responses.

Not implemented in Event Mode:
- `b` (backgrounded), `pc`/`pe` (player collapse/expand): no reliable source for a user action
- `pr` as event (playback rate change)
- `ttfbb` (the player does not measure the first body byte), `smrt`, `nor`, `su`, `nr`, `tpb`

## Setup for Development
1. Run `npm install` to install dependencies
2. Use the npm script defined in the package.json like
   - Run `npm start` to start the dev server with a watch task and auto-reloading 
   - Run `npm run debug` to create a dev build bundle (non-minified, with source maps)
   - Run `npm run build` to create a production bundle (minified)
   - Run `npm run format` to format all files in the `src/` and `test/` folders

### Preparing a release
1. Make sure all relevant changes were merged into the `main` branch, and there is an entry for each change in `CHANGELOG.md`
2. Use the [Release New Version](https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/actions/workflows/release.yml) Github Action Workflow and run it on the `main` branch

That's it! The workflow will take care of bumping the version (based on Changelog entries), updating the `CHANGELOG.md` file with release date and version, committing and tagging in this repository, and publishing the package to [NPM](https://www.npmjs.com/package/@bitmovin/player-web-integration-cmcd).

## Principles
- The Bitmovin Player shall not be packaged into the JS file created by the build of this integration. To achieve this, types can be imported and used, but no code must be imported/used (including string enums!)
