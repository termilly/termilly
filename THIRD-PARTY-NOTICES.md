# Third-party notices

Termilly includes the components below, each under its own license. Termilly itself is under the Apache License 2.0 ([LICENSE](LICENSE)).

| Component | Version | License | Where |
|---|---|---|---|
| [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`) | 6.0.0 | MIT | `wwwroot/lib/xterm.js`, `xterm.css` |
| `@xterm/addon-fit` | 0.11.0 | MIT | `wwwroot/lib/addon-fit.js` |
| `@xterm/addon-unicode11` | 0.8.0 | MIT | `wwwroot/lib/addon-unicode11.js` |
| `@xterm/addon-image`, with node-sixel, inwasm and xterm-wasm-parts inside | 0.9.0 | MIT | `wwwroot/lib/addon-image.js` |
| [highlight.js](https://highlightjs.org) | 11.10.0 | BSD-3-Clause | `wwwroot/lib/highlight.min.js` |
| [YamlDotNet](https://github.com/aaubry/YamlDotNet) | 16.3.0 | MIT | `YamlDotNet.dll` |
| System.IO.Ports, Microsoft.Extensions.DependencyInjection ([.NET](https://github.com/dotnet/runtime)) | 10.0 | MIT | `System.IO.Ports.dll`, `Microsoft.Extensions.DependencyInjection*.dll` |
| [Windows Terminal's ConPTY](https://github.com/microsoft/terminal) (`Microsoft.Windows.Console.ConPTY`) | 1.25.260930003 | MIT | Windows: `conpty\conpty.dll`, `conpty\x64\OpenConsole.exe` |
| [WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2) (`Microsoft.Web.WebView2`) | 1.0.4258.31 | BSD-3-Clause style (below) | Windows: `Microsoft.Web.WebView2.*.dll`, `WebView2Loader.dll` |
| Windows SDK projection (`Microsoft.Windows.SDK.NET.dll`, `WinRT.Runtime.dll`) | 10.0.19041 | Microsoft (CsWinRT: MIT) | Windows |
| [Photino.NET](https://github.com/tryphotino/photino.NET) and Photino.Native | 4.0.16, 4.0.22 | Apache-2.0 | Linux: `Photino.NET.dll`, `Photino.Native.so` |

**Installed alongside, not part of Termilly:** the full Windows setup carries Microsoft's own installers for the [.NET 10 Desktop Runtime](https://dotnet.microsoft.com) (MIT, with Microsoft's installer terms) and the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (Microsoft Software License Terms), unchanged and signed by Microsoft, and runs them only if they're missing. On Linux, .NET and WebKitGTK come from the distribution's packages.

## MIT License

Used by the components marked MIT above, under these copyright notices:

- xterm.js and its addons: Copyright (c) 2017-2019, 2019, 2020, 2021, 2022, 2023 The xterm.js authors (https://github.com/xtermjs/xterm.js); Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com); Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
- node-sixel, inwasm and xterm-wasm-parts (inside addon-image): Copyright (c) 2019, 2021 Joerg Breitbart
- Code from VS Code inside xterm.js and addon-image: Copyright (c) Microsoft Corporation
- YamlDotNet: Copyright (c) 2008, 2009, 2010, 2011, 2012, 2013, 2014 Antoine Aubry and contributors
- .NET libraries, ConPTY and CsWinRT: Copyright (c) Microsoft Corporation and contributors

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## highlight.js: BSD 3-Clause License

```
BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## WebView2 SDK

```
Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * The name of Microsoft Corporation, or the names of its contributors 
may not be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Photino.NET and Photino.Native: Apache License 2.0

Copyright TryPhotino and contributors. Under the same Apache License 2.0 as Termilly: the full text is in [LICENSE](LICENSE).
