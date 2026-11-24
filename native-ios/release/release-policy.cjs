// Daniel's November 22 policy: shared Alpha changes also ship to Beta and Pro.
// Community stays Alpha-only until the user explicitly changes this policy.
// This is build tooling; do not import the product registry into the app bundle.
const PRODUCTS = Object.freeze({
  alpha: Object.freeze({ flavor: 'live-alpha', bundle: 'com.ordashtech.nuri.beta', appId: '6831012896', community: true, communityMode: 'live-api-v1' }),
  beta: Object.freeze({ flavor: 'early-access', bundle: 'com.ordashtech.nuri.earlyaccess', appId: '6831131920', community: false, communityMode: 'disabled' }),
  pro: Object.freeze({ flavor: 'app-store', bundle: 'com.ordashtech.nuri.nativelab', appId: '6818022351', community: false, communityMode: 'disabled' }),
});
const RELEASE_POLICY = Object.freeze({
  revision: 1,
  sharedChangesSyncTo: Object.freeze(Object.keys(PRODUCTS)),
  communityRequiresExplicitUserAuthorization: true,
});
const fail = message => { throw new Error('Nuri release policy: ' + message); };

function assertReleasePolicy(profiles) {
  if (!profiles || typeof profiles !== 'object') fail('all three registered release profiles are required.');
  const expected = Object.values(PRODUCTS).map(product => product.flavor).sort();
  const actual = Object.keys(profiles).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('shared updates must include Alpha, Beta and Pro profiles.');
  }
  for (const [lane, product] of Object.entries(PRODUCTS)) {
    const profile = profiles[product.flavor];
    if (!profile || profile.flavor !== product.flavor || profile.bundleIdentifier !== product.bundle
      || profile.appStoreId !== product.appId) fail(lane + ' must preserve its registered product identity.');
    if (profile.communityEnabled !== product.community || profile.communityMode !== product.communityMode) {
      fail(lane + ' Community exposure changed without an explicit policy change.');
    }
  }
  return profiles;
}

// Run after signing all channels and before declaring a synchronized release
// complete. Store distribution/review states separately: Pro still needs Apple
// review while the two TestFlight groups can become installable sooner.
function assertSynchronizedReleaseCohort(receipts) {
  if (!Array.isArray(receipts) || receipts.length !== RELEASE_POLICY.sharedChangesSyncTo.length) {
    fail('a synchronized release requires exactly three signed channel receipts.');
  }
  const byLane = new Map();
  for (const receipt of receipts) {
    if (!receipt || !Object.hasOwn(PRODUCTS, receipt.lane) || byLane.has(receipt.lane)) {
      fail('signed receipts must identify each registered lane exactly once.');
    }
    const product = PRODUCTS[receipt.lane];
    if (receipt.appId !== product.appId || receipt.bundle !== product.bundle
      || receipt.entitlements?.signatureVerified !== true || receipt.entitlements.communityEntry !== product.community) {
      fail(receipt.lane + ' signed identity or Community boundary does not match policy.');
    }
    if (typeof receipt.source !== 'string' || !receipt.source
      || !/^[0-9a-f]{64}$/.test(receipt.sourceManifestSha256 ?? '')) {
      fail(receipt.lane + ' needs its frozen common source and SHA-256 manifest.');
    }
    byLane.set(receipt.lane, receipt);
  }
  const common = byLane.get('alpha');
  if ([...byLane.values()].some(receipt => receipt.source !== common.source
    || receipt.sourceManifestSha256 !== common.sourceManifestSha256)) {
    fail('all three signed channels must use the same frozen common source inputs.');
  }
  return { revision: RELEASE_POLICY.revision, lanes: [...RELEASE_POLICY.sharedChangesSyncTo],
    source: common.source, sourceManifestSha256: common.sourceManifestSha256 };
}

module.exports = { PRODUCTS, RELEASE_POLICY, assertReleasePolicy, assertSynchronizedReleaseCohort };
