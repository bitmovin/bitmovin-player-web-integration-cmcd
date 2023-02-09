# Bitmovin Player Integration Template Repo - Remove this section!
1. Create repo out of this template repo
2. Update in `package.json`:
  1. `name` (should still start with `bitmovin-player-integration-`)
  2. `browser` (filename should still start with `bitmovin-player-`)
  3. `repository.url`
  4. Potentially upgrade dependency versions as needed
3. Run `npm i` to create a `package-lock.json` with the up to date details. Add the new file to the git repo and commit it.
4. Update `integrationName` variable in `tooling/webpack.common.js` (recommended to start with an uppercase character)
5. Update `bitmovin-player-integration.js` filename in `dist/index.html` to match the output file name of `tooling/webpack.common.js` (see `module.exports.output.filename` field there)
6. `src/ts/main.ts` is the file where all public exports should be added, the main entry file for uses of the integration library
7. The `.github/workflow` folder contains a CI workflow for Github Actions. In this Github org, we can only use it for open source repos. Remove it if this is not open source.
8. Update this `README.md` file:
    1. `<INTEGRATION_NAME>` and `<DESCRIPTION>` below
    2. Update the npm package name in the `Install` section
    3. Add how to use this library in the `Usage` section
9. Remove this line and everything above it from this `README.md` file


# Bitmovin Player <INTEGRATION_NAME>

<DESCRIPTION>

## Install
Install with npm:
```
npm install --save @bitmovin/player-integration-<template>
```
Install with yarn:
```
yarn add @bitmovin/player-integration-<template>
```

## Usage

<Describe how a user can leverage this library>

## Setup for Development
1. Run `npm install` to install dependencies
2. Use the npm script defined in the package.json like
   - Run `npm start` to start the dev server with a watch task and auto-reloading 
   - Run `npm run debug` to create a dev build bundle (non-minified, with source maps)
   - Run `npm run build` to create a production bundle (minified)

## Principles
- The Bitmovin Player shall not be packaged into the JS file created by the build of this integration. To achieve this, types can be imported and used, but no code must be imported/used (including string enums!)
