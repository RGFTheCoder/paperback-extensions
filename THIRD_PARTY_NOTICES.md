# Third-Party Notices

This project includes third-party code. The relevant licenses and attributions
are reproduced below.

---

## Baseline JPEG decoder — `shared/descramble/jpeg.ts`

The marker parsing, Huffman entropy decode, dequantization and integer inverse
DCT in `shared/descramble/jpeg.ts` are a TypeScript port of the baseline decoder
from **jpeg-js** (https://github.com/jpeg-js/jpeg-js), which is in turn derived
from notmasteryet's public-domain-spirited JPEG decoder. That code is licensed
under the Apache License, Version 2.0.

```
Copyright 2011 notmasteryet

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The port is limited to baseline sequential DCT decoding and emits tightly-packed
RGBA; progressive, arithmetic, 12-bit and CMYK support were removed.
