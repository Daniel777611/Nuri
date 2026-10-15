#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
signing_dir="/Users/wangding/Library/Application Support/NURI Release Signing/build1007.FLojww"
checked_chain="$signing_dir/nuri-release-checked.keychain"
canonical_chain="/Users/wangding/Library/Keychains/login.keychain-db"
archive_path="$PWD/build/archives/NURI-Native-Lab-0.3.0-1008.xcarchive"
export_path="$signing_dir/export1008-external-links"
if [[ -e "$archive_path" || -e "$export_path" ]]; then
  print -u2 "1008 output already exists; inspect it rather than overwrite."
  exit 2
fi
current_chains="$(/usr/bin/security list-keychains -d user)"
if [[ "${current_chains//[\"[:space:]]/}" != "$canonical_chain" ]]; then
  print -u2 "Keychain search list changed; no changes made."
  exit 3
fi
restore_signing() {
  /usr/bin/security list-keychains -d user -s "$canonical_chain"
  /usr/bin/security lock-keychain "$checked_chain"
}
trap restore_signing EXIT
"$signing_dir/signing-helper" status-checked "$signing_dir"
/usr/bin/security list-keychains -d user -s "$canonical_chain" "$checked_chain"
export NODE_BINARY="/Users/wangding/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
export PATH="${NODE_BINARY:h}:$PATH"
export EXPO_NO_DOTENV=1
export EXPO_PUBLIC_PREVIEW_MODE=0
/usr/bin/caffeinate -i /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -jobs 2 -workspace ios/NURINativeLab.xcworkspace -scheme NURINativeLab \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath build/device -archivePath "$archive_path" \
  DEVELOPMENT_TEAM=6PL6HQYU7P CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=AB87E0C98D349BD895BDAFB466129DB17D5E9C12 \
  PROVISIONING_PROFILE_SPECIFIER=eef75416-6e46-4388-ab31-9e5159d5ff0d \
  CURRENT_PROJECT_VERSION=1008 MARKETING_VERSION=0.3.0 archive \
  2>&1 | /usr/bin/tee build/verification/nuri-1008-device-archive.log
/usr/bin/codesign --verify --deep --strict --verbose=2 "$archive_path/Products/Applications/NURINativeLab.app"
/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -exportArchive \
  -archivePath "$archive_path" -exportPath "$export_path" \
  -exportOptionsPlist "$signing_dir/ExportOptions-1007-local.plist" \
  2>&1 | /usr/bin/tee build/verification/nuri-1008-export.log
/usr/bin/unzip -t "$export_path/NURINativeLab.ipa"
/usr/bin/shasum -a 256 "$export_path/NURINativeLab.ipa"
