const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const resources = path.join(context.appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  for (const file of ['src/main.js', 'src/preload.js', 'src/startup-diagnostics.js', 'renderer/index.html', 'renderer/bundle.js', 'renderer/bundle.css', 'renderer/styles.css', 'assets/teamyra-icon.ico']) {
    if (!asar.statFile(archive, file).size) throw new Error(`Missing packaged resource: ${file}`);
  }
  const packagedIcon = path.join(resources, 'teamyra-icon.ico');
  if (!fs.existsSync(packagedIcon)) throw new Error('Packaged TEAMYRA window icon is required');
  const core = path.join(resources, 'teamyra-core', 'teamyra-core.exe');
  if (!fs.existsSync(core) || !fs.existsSync(path.join(path.dirname(core), '_internal'))) {
    throw new Error('The complete one-directory TEAMYRA core is required');
  }
  // electron-builder signs extra-resource executables during copying. The
  // release workflow independently checks Authenticode on this exact output.
};
