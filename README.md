# Bitmovin Player CMCD Integration

This project adds support for the Common Media Client Data (CMCD) plugin. Please find more information about the Consumer Technology Association (CTA) Specification in https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf

## Install
Install with npm:
```
npm install --save @bitmovin/player-integration-cmcd
```
Install with yarn:
```
yarn add @bitmovin/player-integration-cmcd
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

const cmcdPlugin = new CmcdIntegration(cmcdConfig);
playerConfig.network = {
  preprocessHttpRequest: cmcdPlugin.preprocessHttpRequest,
  preprocessHttpResponse: cmcdPlugin.preprocessHttpResponse,
};
playerConfig.adaptation = {
  desktop: {
    onVideoAdaptation: cmcdPlugin.onVideoAdaptation,
    onAudioAdaptation: cmcdPlugin.onAudioAdaptation,
  },
  mobile: {
    onVideoAdaptation: cmcdPlugin.onVideoAdaptation,
    onAudioAdaptation: cmcdPlugin.onAudioAdaptation,
  },
};
```
After that, you create a Bitmovin Player instance as usual:


## Setup for Development
1. Run `npm install` to install dependencies
2. Use the npm script defined in the package.json like
   - Run `npm start` to start the dev server with a watch task and auto-reloading 
   - Run `npm run debug` to create a dev build bundle (non-minified, with source maps)
   - Run `npm run build` to create a production bundle (minified)

## Principles
- The Bitmovin Player shall not be packaged into the JS file created by the build of this integration. To achieve this, types can be imported and used, but no code must be imported/used (including string enums!)
