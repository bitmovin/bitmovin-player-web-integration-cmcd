const path = require('path');

const integrationName = 'Cmcd';

module.exports = {
  entry: ['./src/ts/Cmcd.ts', './src/ts/CmcdIntegration.ts'],
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    filename: `./bitmovin-player-integration-${integrationName.toLowerCase()}.js`,
    path: path.join(__dirname, '../dist/js'),
    libraryTarget: 'umd',
    library: {
      amd: `BitmovinPlayerIntegration${integrationName}`,
      commonjs: `BitmovinPlayerIntegration${integrationName}`,
      root: ['bitmovin', 'player', 'integration', integrationName],
    },
  },
  target: ['web', 'es5'],
  optimization: {
    runtimeChunk: false,
  },
};
