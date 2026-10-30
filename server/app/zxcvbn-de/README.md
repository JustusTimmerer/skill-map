# German word lists for the password check

`app/strength.py` adds these lists to the English lists of the Python package `zxcvbn`. Without them, zxcvbn rates German words as random letters, so a weak German password gets a high score.

The files come unchanged from the npm package `@zxcvbn-ts/language-de` 4.1.1 (folder `src/` of the package, published on 2026-06-16, npm `shasum` c6a91f43119fdedefe35b7049c8e4f7af9dd88fa).

| File | Content | SHA-256 |
|---|---|---|
| `commonWords.json` | 21998 common German words | `78a153c3e2773b5a6f1468d2994dd404617d2ef9d02a74afbf115749c5f5a647` |
| `firstnames.json` | 1158 first names | `d5f1a3d91b12f1b407fbe6ecfd1c0ac4b1c9316b169aeb611a238310035e463a` |
| `lastnames.json` | 3000 last names | `c7dc8db5edf40cee86f13d0fe0ba3eb3f96882be662f105c45998839dec3f55b` |

The package is under the MIT license (`LICENSE.txt`). `commonWords.json` comes from the OpenSubtitles 2024 data of OPUS under the ODC-BY license, and `NOTICE.md` and `THIRD_PARTY_LICENSES.md` give its attribution. Each copy of these lists keeps both files.

The package also has a list from the German Wikipedia (800 KB). The check does not use it, because the package does not name its license.
