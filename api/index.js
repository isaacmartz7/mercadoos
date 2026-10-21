const { createApp } = require("../src/server");

let appPromise = null;

module.exports = async (req, res) => {
  if (!appPromise) {
    appPromise = createApp();
  }
  const app = await appPromise;
  return app(req, res);
};
