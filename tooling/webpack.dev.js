const path = require('path');
const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');

module.exports = merge(common, {
  mode: 'development',
  devtool: 'inline-source-map',
  devServer: {
    hot: false,
    static: {
      directory: path.join(__dirname, '../dist'),
      serveIndex: true,
      watch: true,
    },
    watchFiles: {
      paths: ['../src/**/*.ts', '../dist/*.html'],
    },
    client: {
      overlay: true
    },
    devMiddleware: {
      index: true,
      publicPath: '../dist',
      serverSideRender: false,
      writeToDisk: true,
    },
  },
});