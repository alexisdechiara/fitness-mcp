# Third-party notices

## lyfta-mcp

Parts of `src/clients/lyfta.ts` are adapted from
[`jkronlachner/lyfta-mcp`](https://github.com/jkronlachner/lyfta-mcp), version 0.3.1.

Copyright (c) 2026 Julian Kronlachner

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## yazio_public_api

`src/clients/yazio.ts` is written from the endpoint and authentication description published in
[`saganos/yazio_public_api`](https://github.com/saganos/yazio_public_api), commit
`9902893cf8b0329f544b176e4f4885e1e5930ee2`. No source is copied: only the documented paths, the
public OAuth client credentials of the Yazio application and the form encoding of the token
request are reused.

MIT, Copyright (c) 2020 saganos.

## yazio and yazio-mcp

The npm package `yazio@1.1.3` was the Yazio client until its broken token request was replaced by
the first-party client above; it is no longer a dependency. The licence question its missing
package metadata raised therefore no longer applies to this project.

`fliptheweb/yazio-mcp` is MIT, Copyright (c) 2024 Artur Kornakov. Its code is not copied or
bundled; its verified tool contracts informed this integration.
