// Validates manifest.yml against the Forge schema without needing a registered app
// (`forge lint` requires the app id from `forge register`).
const { validate } = require('@forge/manifest');
const path = require('node:path');

validate(false, path.join(__dirname, '..', 'manifest.yml')).then((r) => {
  if (r.success) {
    console.log('manifest.yml is valid');
    return;
  }
  for (const e of r.errors ?? []) console.error(`- ${e.message}`);
  process.exit(1);
});
