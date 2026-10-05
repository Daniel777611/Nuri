const fs = require('fs');
const path = require('path');
const {
  withAppDelegate,
  withDangerousMod,
  withXcodeProject,
} = require('@expo/config-plugins');

// This plugin only generates the isolated native-ios project. It never touches
// the existing mobile-shell project or the hosted frontend/backend.
module.exports = function withNuriNative(config) {
  config = withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== 'swift') {
      throw new Error('NURI Native Lab requires a Swift AppDelegate');
    }
    mod.modResults.contents = fs.readFileSync(
      path.join(mod.modRequest.projectRoot, 'native/NuriAppDelegate.swift'),
      'utf8',
    );
    return mod;
  });
  config = withDangerousMod(config, ['ios', async (mod) => {
    const target = path.join(mod.modRequest.platformProjectRoot, 'NURINativeLab');
    fs.mkdirSync(target, { recursive: true });
    for (const name of ['NuriPushBridge.swift', 'NuriPushBridge.m', 'NuriGoogleAuthBridge.swift', 'NuriGoogleAuthBridge.m', 'PrivacyInfo.xcprivacy']) {
      fs.copyFileSync(path.join(mod.modRequest.projectRoot, 'native', name), path.join(target, name));
    }
    return mod;
  }]);
  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const target = project.getFirstTarget().uuid;
    const group = project.findPBXGroupKey({ name: 'NURINativeLab' })
      || project.findPBXGroupKey({ path: 'NURINativeLab' });
    for (const name of ['NuriPushBridge.swift', 'NuriPushBridge.m', 'NuriGoogleAuthBridge.swift', 'NuriGoogleAuthBridge.m']) {
      const file = `NURINativeLab/${name}`;
      if (!project.hasFile(file)) project.addSourceFile(file, { target }, group);
    }
    // Expo generates a privacy manifest already. The native bridge uses the
    // same approved APIs and its source manifest is kept for auditability.
    return mod;
  });
};
