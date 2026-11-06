# Offline Traditional Chinese conversion

`cn2t.js` is copied byte-for-byte from
`opencc-js@1.4.2/package/dist/umd/cn2t.js`, distributed by the official npm
registry. It is the minimal Simplified-to-Traditional build, not a remote
service. Upstream commit: `ba20c6eda99e7ec385bcf706da2776372675b898`.

- https://registry.npmjs.org/opencc-js/-/opencc-js-1.4.2.tgz
- https://github.com/nk2028/opencc-js/tree/ba20c6eda99e7ec385bcf706da2776372675b898
- Code: MIT; bundled OpenCC data: Apache-2.0.

Exact upstream `LICENSE`, `LICENSES/Apache-2.0.txt` (copied as
`APACHE-2.0.txt`) and `THIRD_PARTY_LICENSES.md` are retained beside the build.
The build's SHA-256 is
`d66d920069ab526db08c6f2bc15fcf6feb7d07de3cf98e7e27c0aaf7d136baee`
(1,100,656 UTF-8 bytes). No generated bundle or
dictionary content is manually changed. No HTML converter is used; only the
pure string converter is called locally.
