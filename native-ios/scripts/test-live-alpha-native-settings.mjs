import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const require = createRequire(import.meta.url), pluginRequire = createRequire(require.resolve('@expo/config-plugins'));
const xcode = pluginRequire('xcode'), path = new URL('../ios/NURINativeLab.xcodeproj/project.pbxproj', import.meta.url);
const source = readFileSync(path, 'utf8'), project = xcode.project(fileURLToPath(path)); project.parseSync();
const configs = project.pbxXCBuildConfigurationSection();
const targets = Object.values(project.pbxNativeTargetSection()).filter(row => row?.isa === 'PBXNativeTarget' && row.name === 'NURINativeLab');
assert.equal(targets.length, 1); assert.equal(targets[0].productType, '"com.apple.product-type.application"');
const appIds = new Set(project.pbxXCConfigurationList()[targets[0].buildConfigurationList].buildConfigurations.map(row => row.value));
const fields = { INFOPLIST_FILE: ['NURI_APP_INFOPLIST_FILE', 'NURINativeLab/Info.plist'],
  PRODUCT_BUNDLE_IDENTIFIER: ['NURI_APP_BUNDLE_IDENTIFIER', 'com.ordashtech.nuri.nativelab'],
  CURRENT_PROJECT_VERSION: ['NURI_APP_BUILD_NUMBER', '1019'], MARKETING_VERSION: ['NURI_APP_MARKETING_VERSION', '0.3.0'] };
const unquote = value => String(value).replace(/^"(.*)"$/, '$1');
const root = fileURLToPath(new URL('../', import.meta.url));
const mainCommit = 'c75adc83f163b6701027067804ccbb9c3847c506';
const digest = value => createHash('sha256').update(value).digest('hex');
function baseline(path, hash) {
  const bytes = execFileSync('git', ['show', `${mainCommit}:native-ios/${path}`], { cwd: root, encoding: 'utf8' });
  assert.equal(digest(bytes), hash, `Exact fetched main baseline changed: ${path}`);
  return bytes;
}
// OpenStep scalars are strings: 1 and "1" have the same Xcode meaning.
// Object ordering/quoting are presentation only. Retain even parser reference
// comments conservatively: never omit a real build setting named *_comment.
// Array order and every signing/source/script/reference key remain strict.
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, semantic(value[key])]));
  return typeof value === 'string' || typeof value === 'number' ? unquote(value) : value;
}
const parser = pluginRequire('xcode/lib/parser/pbxproj');
const mainProject = semantic(parser.parse(baseline('ios/NURINativeLab.xcodeproj/project.pbxproj', '0d5bd2390ed9524ba37cbd71597c5b4208de3e4af5f3aad6e426db866f45edb6')));
const actualProject = semantic(project.hash), expectedProject = structuredClone(mainProject);
const expectedObjects = expectedProject.project.objects;
for (const id of appIds) {
  const settings = expectedObjects.XCBuildConfiguration[id].buildSettings;
  for (const [field, [key, value]] of Object.entries(fields)) {
    assert.equal(settings[field], value, `Unexpected main app default: ${field}`);
    settings[field] = `$(${key})`; settings[key] = value;
  }
}
const copyPhaseIds = Object.entries(expectedObjects.PBXShellScriptBuildPhase).filter(([, value]) => value?.name === '[CP] Copy Pods Resources').map(([id]) => id);
assert.equal(copyPhaseIds.length, 1);
const copyPhaseId = copyPhaseIds[0];
const applicationPrivacyInput = '${PODS_CONFIGURATION_BUILD_DIR}/EXApplication/ExpoApplication_privacy.bundle';
const applicationPrivacyOutput = '${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/ExpoApplication_privacy.bundle';
const resources = expectedObjects.PBXShellScriptBuildPhase[copyPhaseId];
for (const [key, anchor, added] of [
  ['inputPaths', '${PODS_CONFIGURATION_BUILD_DIR}/EXConstants/EXConstants.bundle', applicationPrivacyInput],
  ['outputPaths', '${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/EXConstants.bundle', applicationPrivacyOutput],
]) {
  assert.equal(resources[key].filter(value => value === anchor).length, 1);
  assert.equal(resources[key].includes(added), false);
  resources[key].splice(resources[key].indexOf(anchor), 0, added);
}
const projectConfigIds = Object.entries(expectedObjects.XCBuildConfiguration).filter(([, value]) => value?.buildSettings?.REACT_NATIVE_PATH).map(([id]) => id);
assert.equal(projectConfigIds.length, 2);
for (const id of projectConfigIds) {
  assert.equal(appIds.has(id), false);
  assert.match(expectedObjects.XCBuildConfiguration[id].buildSettings.REACT_NATIVE_PATH, /^\$\{PODS_ROOT\}\/\.\.\/\.\.\/node_modules\/\.pnpm\/react-native@0\.81\.5_[^/]+\/node_modules\/react-native$/);
  expectedObjects.XCBuildConfiguration[id].buildSettings.REACT_NATIVE_PATH = '${PODS_ROOT}/../../node_modules/react-native';
}
const verifyProject = value => assert.deepEqual(semantic(value), expectedProject);
function resolve(settings, values = {}) {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !key.startsWith('NURI_APP_')).map(([key, value]) => [key,
    typeof value !== 'string' ? value : value.replace(/\$\((NURI_APP_[A-Z_]+)\)/g, (_, name) => unquote(values[name] ?? settings[name]))]));
}

test('only app Debug/Release owns four custom settings; main defaults stay 1019/0.3.0/production/base plist', () => {
  assert.deepEqual([...appIds].map(id => configs[id].name).sort(), ['Debug', 'Release']);
  for (const [id, row] of Object.entries(configs)) {
    if (row?.isa !== 'XCBuildConfiguration') continue;
    if (!appIds.has(id)) { assert.doesNotMatch(JSON.stringify(row.buildSettings), /NURI_APP_/); continue; }
    assert.deepEqual(Object.keys(row.buildSettings).filter(key => key.startsWith('NURI_APP_')).sort(), Object.values(fields).map(([key]) => key).sort());
    for (const [field, [key, expected]] of Object.entries(fields)) {
      assert.equal(unquote(row.buildSettings[field]), `$(${key})`); assert.equal(unquote(row.buildSettings[key]), expected); assert.equal(unquote(resolve(row.buildSettings)[field]), expected);
    }
    assert.equal(row.buildSettings.DEVELOPMENT_TEAM, '6PL6HQYU7P'); assert.equal(row.buildSettings.CODE_SIGN_ENTITLEMENTS, 'NURINativeLab/NURINativeLab.entitlements');
  }
});

test('entire main PBX semantics permit only four app indirections, one EXApplication resource pair, and two RN path normalizations', () => {
  verifyProject(project.hash);
  const cosmetic = source.replace('PRODUCT_NAME = NURINativeLab;', 'PRODUCT_NAME = "NURINativeLab";').replace('TARGETED_DEVICE_FAMILY = 1;', 'TARGETED_DEVICE_FAMILY = "1";');
  verifyProject(parser.parse(cosmetic));
});

for (const [name, change] of [
  ['a removed privacy input', value => { value.project.objects.PBXShellScriptBuildPhase[copyPhaseId].inputPaths = resources.inputPaths.filter(path => path !== applicationPrivacyInput); }],
  ['a removed privacy output', value => { value.project.objects.PBXShellScriptBuildPhase[copyPhaseId].outputPaths = resources.outputPaths.filter(path => path !== applicationPrivacyOutput); }],
  ['a changed app signing team', value => { value.project.objects.XCBuildConfiguration[[...appIds][0]].buildSettings.DEVELOPMENT_TEAM = 'OTHERTEAM'; }],
  ['an app-only override leaking to the project', value => { value.project.objects.XCBuildConfiguration[projectConfigIds[0]].buildSettings.NURI_APP_BUNDLE_IDENTIFIER = 'com.ordashtech.nuri.beta'; }],
  ['an unexpected shell script change', value => { value.project.objects.PBXShellScriptBuildPhase[copyPhaseId].shellScript += ' unexpected'; }],
  ['an extra native source reference', value => { value.project.objects.PBXFileReference.UNEXPECTED = { isa: 'PBXFileReference', path: 'Other.swift' }; }],
  ['a different dependency RN path', value => { value.project.objects.XCBuildConfiguration[projectConfigIds[0]].buildSettings.REACT_NATIVE_PATH = '/other/react-native'; }],
  ['a real build setting disguised as parser comment metadata', value => { value.project.objects.XCBuildConfiguration[projectConfigIds[0]].buildSettings.OTHER_LDFLAGS_comment = '-unexpected'; }],
]) test(`semantic baseline rejects ${name}`, () => {
  const changed = structuredClone(actualProject); change(changed); assert.throws(() => verifyProject(changed), assert.AssertionError);
});

test('Alpha overrides alter only app metadata; dependency settings keep their own identity/Info/version', t => {
  const values = { NURI_APP_INFOPLIST_FILE: '/fixture/alpha/Info.plist', NURI_APP_BUNDLE_IDENTIFIER: 'com.ordashtech.nuri.beta',
    NURI_APP_BUILD_NUMBER: '1058', NURI_APP_MARKETING_VERSION: '0.4.0' };
  for (const [id, row] of Object.entries(configs)) {
    if (row?.isa !== 'XCBuildConfiguration') continue;
    const before = resolve(row.buildSettings), after = resolve(row.buildSettings, values);
    if (appIds.has(id)) for (const [field, [key]] of Object.entries(fields)) { assert.equal(unquote(after[field]), values[key]); delete before[field]; delete after[field]; }
    assert.deepEqual(after, before);
  }
  const podPath = new URL('../ios/Pods/Pods.xcodeproj/project.pbxproj', import.meta.url);
  if (!existsSync(podPath)) { t.diagnostic('Pods not installed: app/project scoping and full baseline-semantic checks ran; no installed-Pods claim.'); return; }
  const pods = xcode.project(fileURLToPath(podPath)); pods.parseSync(); assert.doesNotMatch(readFileSync(podPath, 'utf8'), /NURI_APP_/);
  for (const row of Object.values(pods.pbxXCBuildConfigurationSection())) if (row?.isa === 'XCBuildConfiguration') assert.deepEqual(resolve(row.buildSettings, values), resolve(row.buildSettings));
});

function expectedInstalledLock() {
  let value = baseline('ios/Podfile.lock', 'bebf4e468e0ed8dc9829b3d5bc5991c9db2c3cc16e54cc25f0b8cc80d9b1e110');
  const replaceOnce = (before, after) => { assert.equal(value.split(before).length, 2, `Exact lock delta anchor required: ${before}`); value = value.replace(before, after); };
  const insert = (anchor, added) => replaceOnce(anchor, added + anchor);
  // pnpm's peer-qualified store locations become public node_modules links.
  // Keep each package/subpath exact and only remove YAML quotes made needless
  // by removing @version from unscoped package paths.
  value = value.replace(/\.\.\/node_modules\/\.pnpm\/[^/]+\/node_modules\//g, '../node_modules/')
    .replace(/^  - "([^"\n]+ \(from `\.\.\/node_modules\/(?!@)[^`\n]+`\))"$/gm, '  - $1');
  for (const [name, version, pkg, next] of [
    ['EXApplication', '7.0.8', 'expo-application', 'EXConstants'],
    ['ExpoGlassEffect', '0.1.10', 'expo-glass-effect', 'ExpoHaptics'],
    ['ExpoVideo', '3.0.16', 'expo-video', 'ExpoWebBrowser'],
  ]) {
    const podAnchor = value.match(new RegExp('^  - ' + next + ' \\(\\d[^\\n]+\\n', 'm'))?.[0];
    assert.ok(podAnchor); insert(podAnchor, `  - ${name} (${version}):\n    - ExpoModulesCore\n`);
    insert(`  - ${next} (from`, `  - ${name} (from \`../node_modules/${pkg}/ios\`)\n`);
    insert(`  ${next}:\n`, `  ${name}:\n    :path: "../node_modules/${pkg}/ios"\n`);
  }
  // A real patch-version resolution, not formatting: explicitly reviewed and
  // pinned here so another implicit pod upgrade cannot pass this guard.
  for (const name of ['Environment', 'Logger', 'Privacy', 'UserDefaults']) replaceOnce(`GoogleUtilities/${name} (8.1.4)`, `GoogleUtilities/${name} (8.1.5)`);
  const checksums = {
    EXApplication: ['', '13420f8139864183f8a04fd6099077bdf8cfb186', 'EXConstants'],
    ExpoGlassEffect: ['', '73fd0ca0f64de046ad778ea1318c43a726b9e143', 'ExpoHaptics'],
    ExpoVideo: ['', 'bd6b4f7de4ec34ba73470b8f955625e821048106', 'ExpoWebBrowser'],
    GoogleUtilities: ['db34c1c11c6f2eccb6fab2340cb8ceb1451299dc', '7dc09b3fa9ecb5c2298b952313d14628b61b9da3'],
    ReactCodegen: ['afb65c815b3dff7e85429d3cc191703234cb70d1', '4c44b74b77fc41ae25b9e2c7e9bd6e2bc772c23f'],
    RNReanimated: ['f8fc0379d728d70114dbc73bece2102a9604f63f', 'ccdeb3ccba11e8117b3d2bf50fb9c0543a8af11a'],
    RNWorklets: ['f864ac9a20005a98d10646dce80ebdccd66363e6', '28ee7370ca8da356fcc914e3e68b97e9752196d2'],
  };
  for (const [name, [before, after, next]] of Object.entries(checksums)) {
    if (!next) replaceOnce(`  ${name}: ${before}`, `  ${name}: ${after}`);
    else { const anchor = value.match(new RegExp('  ' + next + ': [0-9a-f]{40}\\n'))?.[0]; assert.ok(anchor); insert(anchor, `  ${name}: ${after}\n`); }
  }
  return value;
}
const approvedLock = expectedInstalledLock();
const verifyLock = value => assert.equal(value, approvedLock);
test('Podfile.lock exactly reproduces the reviewed main-relative install delta and installed Manifest.lock', () => {
  const actual = readFileSync(new URL('../ios/Podfile.lock', import.meta.url), 'utf8'); verifyLock(actual);
  assert.equal(readFileSync(new URL('../ios/Pods/Manifest.lock', import.meta.url), 'utf8'), actual);
  for (const [pod, pkg, version] of [['EXApplication', 'expo-application', '7.0.8'], ['ExpoGlassEffect', 'expo-glass-effect', '0.1.10'], ['ExpoVideo', 'expo-video', '3.0.16']]) {
    assert.equal(require(`${pkg}/package.json`).version, version);
    const spec = JSON.parse(readFileSync(new URL(`../ios/Pods/Local Podspecs/${pod}.podspec.json`, import.meta.url), 'utf8'));
    assert.equal(spec.name, pod); assert.equal(spec.version, version);
  }
  const application = JSON.parse(readFileSync(new URL('../ios/Pods/Local Podspecs/EXApplication.podspec.json', import.meta.url), 'utf8'));
  assert.deepEqual(application.resource_bundles.ExpoApplication_privacy, ['PrivacyInfo.xcprivacy']);
  assert.match(readFileSync(new URL('../ios/Pods/Target Support Files/Pods-NURINativeLab/Pods-NURINativeLab-resources.sh', import.meta.url), 'utf8'), /EXApplication\/ExpoApplication_privacy\.bundle/);
});

test('lock guard rejects another version, removed resource pod or arbitrary checksum change', () => {
  for (const changed of [approvedLock.replaceAll('8.1.5', '8.1.6'), approvedLock.replace('  - EXApplication (7.0.8):\n    - ExpoModulesCore\n', ''), approvedLock.replace('7dc09b3fa9ecb5c2298b952313d14628b61b9da3', '0000000000000000000000000000000000000000')]) {
    assert.throws(() => verifyLock(changed), assert.AssertionError);
  }
});

const plist = value => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: value, encoding: 'utf8' }));
function privacySemantics(value) {
  const copy = structuredClone(value), rows = copy.NSPrivacyAccessedAPITypes;
  assert.ok(Array.isArray(rows)); assert.equal(new Set(rows.map(row => row.NSPrivacyAccessedAPIType)).size, rows.length);
  for (const row of rows) { assert.equal(new Set(row.NSPrivacyAccessedAPITypeReasons).size, row.NSPrivacyAccessedAPITypeReasons.length); row.NSPrivacyAccessedAPITypeReasons.sort(); }
  rows.sort((a, b) => a.NSPrivacyAccessedAPIType.localeCompare(b.NSPrivacyAccessedAPIType));
  return semantic(copy);
}
const expectedPrivacy = plist(baseline('ios/NURINativeLab/PrivacyInfo.xcprivacy', '24c8e8ea29a754f230e9f42676a15918e789903d6972ff1de93370c2a26b429c'));
expectedPrivacy.NSPrivacyAccessedAPITypes.find(row => row.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryUserDefaults').NSPrivacyAccessedAPITypeReasons.push('C56D.1');
const actualPrivacy = plist(readFileSync(new URL('../ios/NURINativeLab/PrivacyInfo.xcprivacy', import.meta.url), 'utf8'));
const verifyPrivacy = value => assert.deepEqual(privacySemantics(value), privacySemantics(expectedPrivacy));
test('privacy aggregation adds only the installed GoogleUtilities UserDefaults C56D.1 reason, preserving collection/tracking declarations', () => {
  verifyPrivacy(actualPrivacy);
  const google = plist(readFileSync(new URL('../ios/Pods/GoogleUtilities/GoogleUtilities/Privacy/Resources/PrivacyInfo.xcprivacy', import.meta.url), 'utf8'));
  assert.deepEqual(google.NSPrivacyAccessedAPITypes.find(row => row.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryUserDefaults').NSPrivacyAccessedAPITypeReasons, ['C56D.1']);
});

test('privacy guard rejects tracking, lost data declarations, missing or invented API reasons', () => {
  for (const change of [value => { value.NSPrivacyTracking = true; }, value => { value.NSPrivacyCollectedDataTypes = []; }, value => { value.NSPrivacyAccessedAPITypes.find(row => row.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryUserDefaults').NSPrivacyAccessedAPITypeReasons = ['CA92.1']; }, value => { value.NSPrivacyAccessedAPITypes[0].NSPrivacyAccessedAPITypeReasons.push('INVENTED'); }]) {
    const copy = structuredClone(actualPrivacy); change(copy); assert.throws(() => verifyPrivacy(copy), assert.AssertionError);
  }
});
