# Offline pinyin data and algorithm provenance

The keyboard engine adapts the pure candidate/segmentation approach from
`simple-ime` 1.2.4, commit `d503bee97392f3b99e1fb9d6f23cecc86ced6f26`.
Its MIT notice is retained in `LICENSE`.

`google-pinyin-dict.json` is an exact, unmodified copy of the upstream JSON
file named `dict/google-pinyin-dict.txt`, not its emoji-augmented runtime
dictionary. It contains real Chinese word-frequency data, not UI fixtures.

- Source: https://github.com/nieyuyao/simple-ime/blob/d503bee97392f3b99e1fb9d6f23cecc86ced6f26/dict/google-pinyin-dict.txt
- SHA-256: `b69f653eeae8f730eb90c8d07f6587c0d2d879e2533e41aa14e49027bb02ea3d`
- UTF-8 bytes: 4,093,442
- Keys: 49,506; records: 103,385; distinct words: 54,666.
- The upstream emoji data is deliberately excluded.

The 416 syllables embedded in `pinyinEngine.ts` are the exact ordered values
from `src/data/pinyin.txt` at the same simple-ime commit (1,760 UTF-8 bytes,
SHA-256 `e463de9d56cb9e2ed9f1057d706c8fba6464f74b4a8e0fc9dd832769cbf20289`).
Only the delimiter changes from newlines to `|` in the TypeScript constant.

The upstream project credits `dongyuwei/web-pinyin-ime`, whose README identifies
the Google/AOSP PinyinIME word-frequency source and Apache-2.0 license.
The original notice is retained in `AOSP-NOTICE`.

- https://github.com/nieyuyao/simple-ime/blob/d503bee97392f3b99e1fb9d6f23cecc86ced6f26/README.md
- https://github.com/dongyuwei/web-pinyin-ime/blob/ee505cf7bab43cf70dcc2540579027aea432f28a/README.md
- https://android.googlesource.com/platform/packages/inputmethods/PinyinIME/+/refs/heads/master/NOTICE

`pinyinEngine.ts` is a modified, bounded adaptation: no DOM/Chrome APIs,
package/runtime downloads, typo-corrector exhaustive search, user learning,
keystroke logging, persistence or network calls. Minimum-syllable segmentation
uses dynamic programming; word combinations and prefix scanning have explicit
limits: 32 raw input characters, 32 returned candidates, at most 8,192 matching
prefix keys, and an eight-path beam. Public dictionary keys are cached; typed
input and lookup memoization are not retained between requests. Returned
strings always replace the complete original composition.
This is a small offline input engine, not an OS-level predictive language model.

Traditional output uses separately attributed `opencc-js` 1.4.2. This converts
the dictionary's simplified candidates; it is not a distinct Traditional
Chinese language model.
