#!/usr/bin/env node
// Read-only release verification. Never unlocks/signs, writes/extracts files,
// contacts production, prints credentials, or alters the original 1007/1008 builds.
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const signingDirectory = "/Users/wangding/Library/Application Support/NURI Release Signing/build1007.FLojww";
const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  assert.ok(["--archive", "--ipa", "--ipa-app", "--baseline-only", "--build"].includes(name), "unrecognized argument");
  if (name === "--baseline-only") options.set(name, true);
  else {
    assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith("--"), `missing ${name} value`);
    const value = process.argv[++i];
    if (name === "--build") {
      assert.ok(["1008", "1009"].includes(value), "--build must be 1008 or 1009");
      assert.ok(!options.has(name), "duplicate --build argument");
      options.set(name, value);
    } else options.set(name, resolve(value));
  }
}
const identity = {
  bundle: "com.ordashtech.nuri.nativelab", team: "6PL6HQYU7P", version: "0.3.0", build: options.get("--build") || "1008", display: "Nuri",
  profile: "eef75416-6e46-4388-ab31-9e5159d5ff0d", certificate: "AB87E0C98D349BD895BDAFB466129DB17D5E9C12",
};
const archive = options.get("--archive") || join(project, `build/archives/NURI-Native-Lab-0.3.0-${identity.build}.xcarchive`);
const ipa = options.get("--ipa") || join(signingDirectory, identity.build === "1009" ? "export1009-summary/NURINativeLab.ipa" : "export1008-external-links/NURINativeLab.ipa");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sha1 = (data) => createHash("sha1").update(data).digest("hex").toUpperCase();
function command(executable, args, input, encoding = "utf8") {
  // Child errors are replaced with an operation-only error; no raw file bodies
  // or arbitrary process output can escape into a release report.
  try { return execFileSync(executable, args, { input, encoding, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }); }
  catch { throw new Error(`read-only verification command failed: ${executable} ${args.slice(0, 2).join(" ")}`); }
}
const plistJson = (bytes) => JSON.parse(command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], bytes));
const plistField = (bytes, name, format = "raw") => command("/usr/bin/plutil", ["-extract", name, format, "-o", "-", "-"], bytes).trim();
const report = (name, details = {}) => console.log(JSON.stringify({ check: name, result: "PASS", ...details }));

function baseline() {
  const oldBundle = join(project, "build/archives/NURI-Native-Lab-0.3.0-1007.xcarchive/Products/Applications/NURINativeLab.app/main.jsbundle");
  const oldIpa = join(signingDirectory, "export1007-roundtrip/NURINativeLab.ipa");
  assert.equal(sha256(readFileSync(oldBundle)), "68538b11d4f76f606876e6f555e1d7cfe23485791ccafbc91dd858160f37d748", "1007 original bundle changed");
  assert.equal(sha256(readFileSync(oldIpa)), "6bfac0e09943ad84ebaf7639300d5ac0e3f0d1fbfe4ce2a4854f984a4e928f8f", "1007 original IPA changed");
  report("1007 originals remain unchanged");
  if (identity.build === "1009") {
    const priorBundle = join(project, "build/archives/NURI-Native-Lab-0.3.0-1008.xcarchive/Products/Applications/NURINativeLab.app/main.jsbundle");
    const priorIpa = join(signingDirectory, "export1008-external-links/NURINativeLab.ipa");
    assert.equal(sha256(readFileSync(priorBundle)), "af52da7376c41003c40467cc8ced3f0754479bc747b7ed7b8db1d82d12bf00a5", "1008 original bundle changed");
    assert.equal(sha256(readFileSync(priorIpa)), "873a9e7e1eeb726ef0a42462762dc267e460e27eedd4fbdff41719a1a1ff8da8", "1008 original IPA changed");
    report("1008 originals remain unchanged");
  }
}
function appIdentity(info, config) {
  assert.equal(info.CFBundleIdentifier, identity.bundle);
  assert.equal(info.CFBundleShortVersionString, identity.version);
  assert.equal(info.CFBundleVersion, identity.build);
  assert.equal(info.CFBundleDisplayName, identity.display);
  assert.equal(info.NuriAPNSEnvironment, "production");
  assert.equal(info.ITSAppUsesNonExemptEncryption, false);
  assert.deepEqual(info.UIDeviceFamily, [1], "unexpected tablet/device-family configuration");
  assert.equal(config.ios.bundleIdentifier, identity.bundle);
  assert.equal(config.ios.buildNumber, identity.build);
  assert.equal(config.version, identity.version);
  assert.equal(config.ios.appleTeamId, identity.team);
  assert.equal(config.ios.infoPlist.CFBundleDisplayName, identity.display);
  assert.equal(config.ios.entitlements["aps-environment"], "production");
}
function entitlements(value) {
  assert.equal(value["application-identifier"], `${identity.team}.${identity.bundle}`);
  assert.equal(value["com.apple.developer.team-identifier"], identity.team);
  assert.equal(value["aps-environment"], "production");
  assert.equal(value["get-task-allow"], false);
  assert.equal(value["beta-reports-active"], true);
}
function profile(bytes) {
  const xml = command("/usr/bin/security", ["cms", "-D"], bytes);
  assert.equal(plistField(xml, "UUID"), identity.profile);
  entitlements(JSON.parse(plistField(xml, "Entitlements", "json")));
  const expiration = plistField(xml, "ExpirationDate");
  assert.ok(Date.parse(expiration) > Date.now(), "provisioning profile expired");
  // Only this matching profile is permitted. The profile's first certificate
  // is public certificate material, never a private key or credential.
  const certificate = Buffer.from(plistField(xml, "DeveloperCertificates.0"), "base64");
  assert.equal(sha1(certificate), identity.certificate);
  report("production provisioning profile", { uuid: identity.profile, certificateSha1: identity.certificate, expiration });
}

// Read the Mach-O code-signature SuperBlob in memory. IPA membership reads are
// performed through unzip stdout, not through temporary filesystem extraction.
function signatureSlots(binary) {
  assert.equal(binary.readUInt32LE(0), 0xfeedfacf, "expected an arm64 thin Mach-O");
  const count = binary.readUInt32LE(16);
  let commandOffset = 32, signature;
  for (let i = 0; i < count; i++) {
    const code = binary.readUInt32LE(commandOffset), length = binary.readUInt32LE(commandOffset + 4);
    assert.ok(length >= 8 && commandOffset + length <= binary.length, "invalid Mach-O load command");
    if (code === 0x1d) {
      const offset = binary.readUInt32LE(commandOffset + 8), size = binary.readUInt32LE(commandOffset + 12);
      signature = binary.subarray(offset, offset + size);
    }
    commandOffset += length;
  }
  assert.ok(signature, "Mach-O has no code signature");
  assert.equal(signature.readUInt32BE(0), 0xfade0cc0, "unexpected code signature format");
  const slots = new Map(), slotCount = signature.readUInt32BE(8);
  for (let i = 0; i < slotCount; i++) {
    const entry = 12 + i * 8, type = signature.readUInt32BE(entry), offset = signature.readUInt32BE(entry + 4);
    const length = signature.readUInt32BE(offset + 4);
    assert.ok(offset + length <= signature.length, "invalid signature slot");
    slots.set(type, signature.subarray(offset + 8, offset + length));
  }
  return slots;
}
function certificateAndEntitlements(binary) {
  const slots = signatureSlots(binary);
  assert.ok(slots.has(5) && slots.has(0x10000), "required entitlement or CMS signature slot missing");
  entitlements(plistJson(slots.get(5)));
  const certificates = command("/usr/bin/openssl", ["pkcs7", "-inform", "DER", "-print_certs"], slots.get(0x10000));
  const pem = certificates.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  assert.ok(pem.some((value) => sha1(new X509Certificate(value).raw) === identity.certificate), "actual CMS lacks expected signing certificate");
}
// Export the pure/read-only signature checks for an independent baseline probe.
export { signatureSlots, certificateAndEntitlements };
function featureBundle(bundle) {
  assert.ok(bundle.includes(Buffer.from("https://nurifam.app/api")), "production API missing");
  const markers = identity.build === "1008"
    ? ["daily-video-external-title", "home-daily-video-external-title", "detail-external-link-notice", "daily-post-source", "daily-video-source"]
    : ["daily-video-external-title", "detail-external-link-notice", "daily-post-source", "daily-video-source",
      "daily-video-summary-section", "daily-video-summary-disclosure", "daily-post-ai-summary", "daily-post-summary-disclosure", "detail-resource-summary-", "home-daily-post-summary-label", "dailyPostPreview"];
  for (const marker of markers) {
    assert.ok(bundle.includes(Buffer.from(marker)), `compiled external-link marker missing: ${marker}`);
  }
  report("compiled external-link feature markers");
  if (identity.build === "1009") {
    const containsText = (text) => bundle.includes(Buffer.from(text, "utf8")) || bundle.includes(Buffer.from(text, "utf16le"));
    for (const text of [
      "AI 检索摘要",
      "AI 根据检索到的信息整理，可能仅包含部分内容，也可能有误；请打开原站核对，不代表完整原文或完整视频内容。",
      "根据标题和公开检索片段整理，未观看完整视频或获取字幕。请到原站核对。",
      "这是资源短简介，不是原文或完整视频转录；请到原站核对细节。",
    ]) assert.ok(containsText(text), "compiled resource-summary label or disclosure missing");
    // This preview banner is only a source comment, so its absence alone is
    // not evidence of production mode. Also reject the preview-memory module's
    // real runtime guard; previewDisabled separately proves the compiled flag.
    for (const text of [
      "SIMULATOR PREVIEW ONLY",
      "NURI simulator preview storage requires EXPO_PUBLIC_PREVIEW_MODE=1; never use it for a release.",
    ]) assert.ok(!containsText(text), "simulator-only preview storage marker in release bundle");
    report("compiled short-summary features and disclosures", { previewStorageGuardAbsent: true });
  }
  // The bundle can retain the unused player's implementation because its safe
  // URL helpers are imported. Absence of all player-related strings would be a
  // false gate. Runtime screen regression tests prove no embedded/copy UI.
}
function previewDisabled(bundlePath) {
  const disassembly = command(join(project, "ios/Pods/hermes-engine/destroot/bin/hermesc"), ["-b", "-dump-bytecode", bundlePath]);
  const lines = disassembly.split("\n");
  const previewExport = lines.findIndex((line) => /LoadConstString\s+r\d+, "isPreviewMode"/.test(line));
  assert.ok(previewExport >= 0, "compiled preview export not identified");
  const section = lines.slice(previewExport, previewExport + 40).join("\n");
  assert.match(section, /LoadConstFalse\s+(r\d+)\n\s+StoreNPToEnvironment\s+r\d+, 1, \1/, "preview export is not initialized to false");
  const apiExport = lines.findIndex((line) => /LoadConstString\s+r\d+, "API"/.test(line));
  assert.ok(apiExport >= 0, "compiled API export not identified");
  const apiSection = lines.slice(apiExport, apiExport + 22).join("\n");
  assert.match(apiSection, /LoadConstString\s+(r\d+), "https:\/\/nurifam\.a"\.\.\.\n\s+StoreToEnvironment\s+r\d+, 4, \1/, "API is not compiled to the production constant");
  const matchingEndpoints = lines.filter((line) => /^s\d+\[ASCII/.test(line) && /https:\/\/nurifam\.a/.test(line));
  assert.equal(matchingEndpoints.length, 1, "ambiguous production-prefix string in compiled bundle");
  assert.ok(matchingEndpoints[0].endsWith(": https://nurifam.app/api"), "compiled API constant differs from production");
  report("compiled production JS", { previewMode: false, api: "https://nurifam.app/api" });
}
export { previewDisabled };
function archiveVerification() {
  const app = join(archive, "Products/Applications/NURINativeLab.app");
  const info = plistJson(readFileSync(join(app, "Info.plist")));
  const config = JSON.parse(readFileSync(join(app, "EXConstants.bundle/app.config"), "utf8"));
  appIdentity(info, config);
  const properties = JSON.parse(plistField(readFileSync(join(archive, "Info.plist")), "ApplicationProperties", "json"));
  assert.equal(properties.CFBundleVersion, identity.build);
  assert.equal(properties.CFBundleIdentifier, identity.bundle);
  assert.equal(properties.CFBundleShortVersionString, identity.version);
  assert.equal(properties.Team, identity.team);
  assert.equal(plistJson(readFileSync(join(app, "Expo.plist"))).EXUpdatesEnabled, false);
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  certificateAndEntitlements(readFileSync(join(app, info.CFBundleExecutable)));
  profile(readFileSync(join(app, "embedded.mobileprovision")));
  const bundle = readFileSync(join(app, "main.jsbundle"));
  featureBundle(bundle); previewDisabled(join(app, "main.jsbundle"));
  report(`${identity.build} archive identity and strict signature`, { bundle: identity.bundle, version: identity.version, build: identity.build, team: identity.team, jsSha256: sha256(bundle) });
  return { app, bundle, config };
}
function ipaVerification(candidate) {
  command("/usr/bin/unzip", ["-tq", ipa]);
  const members = command("/usr/bin/unzip", ["-Z1", ipa]).split("\n");
  assert.deepEqual(members.filter((name) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name)), ["Payload/NURINativeLab.app/Info.plist"]);
  const member = (path) => command("/usr/bin/unzip", ["-p", ipa, `Payload/NURINativeLab.app/${path}`], undefined, null);
  const info = plistJson(member("Info.plist")), config = JSON.parse(member("EXConstants.bundle/app.config").toString("utf8"));
  appIdentity(info, config); assert.deepEqual(config, candidate.config);
  assert.equal(sha256(member("main.jsbundle")), sha256(candidate.bundle), "IPA JS differs from verified archive");
  assert.equal(plistJson(member("Expo.plist")).EXUpdatesEnabled, false);
  profile(member("embedded.mobileprovision"));
  certificateAndEntitlements(member(info.CFBundleExecutable));
  report(`${identity.build} IPA ZIP, identity, JS and signing metadata`, { ipaSha256: sha256(readFileSync(ipa)) });
  if (options.has("--ipa-app")) {
    const app = options.get("--ipa-app");
    assert.equal(sha256(readFileSync(join(app, "main.jsbundle"))), sha256(member("main.jsbundle")));
    assert.equal(sha256(readFileSync(join(app, info.CFBundleExecutable))), sha256(member(info.CFBundleExecutable)));
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    report("already-extracted IPA app strict signature");
  } else console.log(JSON.stringify({ check: "exported IPA strict signature", result: "NOT_RUN", reason: "Supply --ipa-app pointing to an already-extracted exact IPA app; this script never extracts/writes files." }));
}

try {
  baseline();
  if (!options.has("--baseline-only")) {
    if (!existsSync(archive) || !existsSync(ipa)) {
      console.log(JSON.stringify({ result: "PENDING", archiveExists: existsSync(archive), ipaExists: existsSync(ipa) }));
      process.exitCode = 3;
    } else ipaVerification(archiveVerification());
  }
} catch (error) {
  // Intentionally no child stdout/stderr, arbitrary assertion values, private
  // profile bodies, or credential-file reads in this failure report.
  console.error(JSON.stringify({ result: "FAIL", reason: error.message.split("\n")[0] }));
  process.exitCode = 1;
}
