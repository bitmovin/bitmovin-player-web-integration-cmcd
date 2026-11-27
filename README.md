# Bitmovin Player CMCD Integration

This project adds support for Common Media Client Data (CMCD) to the Bitmovin Player.
It implements CMCD v1 as defined in the Consumer Technology Association (CTA) specification CTA-5004. The latest edition of the specification is published at https://cta-wave.github.io/Resources/common-media-client-data--cta-5004-b.html

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

CMCD v1 is the default. To send CMCD v2 (CTA-5004-B) Request Mode data, set `version: 2`:

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
- Event Mode and all Event-only keys
- `bg`, `nr`, `cs`: no reliable source
- `tpb`: increases the fingerprinting surface and SHOULD NOT be sent by default
- `ab`, `lab`, `tab`: only for unknown individual bitrates, which the player always knows
- `st=ll`: the player does not expose whether a stream is low latency
- `sta=q` (quit) and `sta=w`
- Multiple values per key, e.g. `nor` with more than one object or `bl` for audio and video in one request

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
