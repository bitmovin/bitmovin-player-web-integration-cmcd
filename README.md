# Bitmovin Player CMCD Integration

This project adds support for the Common Media Client Data (CMCD) plugin. Please find more information about the Consumer Technology Association (CTA) Specification in https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf

## Install
Install with npm from this repository:
```
npm install --save git+https://github.com/bitmovin/bitmovin-player-web-integration-cmcd.git
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

It is recommend to set the CMCD Session ID to the Analytics Impression ID as this enabled you to connect CDN logs with CMCD data to Analytics sessions:
```js
cmcdIntegration.setSessionId(player.analytics.getCurrentImpressionId());
```

Load the source into the player after these steps:
```js
player.load(source);
```

## Setup for Development
1. Run `npm install` to install dependencies
2. Use the npm script defined in the package.json like
   - Run `npm start` to start the dev server with a watch task and auto-reloading 
   - Run `npm run debug` to create a dev build bundle (non-minified, with source maps)
   - Run `npm run build` to create a production bundle (minified)
   - Run `npm run format` to format all files in the `src/` and `test/` folders

### Preparing a release
1. Bump version in `package.json` and `package-lock.json`
2. Use `npx kacl release` to automatically create the release in the `CHANGELOG.md` file out of the `Unreleased` section
3. Run `npm run build`
4. Commit all the above changes, including the `dist/` folder
5. Tag the commit of the release (which contains the changes of the `dist/` folder), e.g. with `1.0.0`


## Principles
- The Bitmovin Player shall not be packaged into the JS file created by the build of this integration. To achieve this, types can be imported and used, but no code must be imported/used (including string enums!)
