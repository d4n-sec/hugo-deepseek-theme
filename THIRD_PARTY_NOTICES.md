# Third-Party Notices

hugo-deepseek-theme (originally developed as Threadline) is an independent
project. It is released under the MIT License in
[LICENSE](LICENSE), Copyright (c) 2026 Threadline theme contributors.

## Reference-only visual inspiration

Threadline's conversation-inspired layout and reading interactions were informed
by observing the DeepSeek Harness interface. No DeepSeek Harness source code,
HTML, CSS, JavaScript, templates, assets, logos, fonts, icon files, or personal
session content were copied into this project. The relationship is visual and
interactional reference only; Threadline is not a DeepSeek product and is not
affiliated with or endorsed by DeepSeek.

For reference, the upstream project is:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Project license (MIT): <https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE>
- Upstream third-party notices: <https://github.com/deepseek-ai/deepseek-harness/blob/master/THIRD_PARTY_NOTICES.md>

Those upstream terms and dependencies do not apply to Threadline merely because
the interface was consulted as a reference. The upstream notices are linked so
readers can inspect the actual reference project and its licensing. No DeepSeek
Harness dependency, logo, or asset is bundled here.

## Runtime dependencies

The distributed browser theme has no third-party runtime libraries, JavaScript
frameworks, CSS frameworks, web fonts, analytics, or CDN dependencies.

- UI icons are original inline SVGs authored for Threadline, except for the
  Lucide pin documented below.
- Typography uses the operating system font stack; no font files are bundled.
- The example site uses fictional author and article content.
- The optional comments service uses only the Python 3.11+ standard library and
  is not bundled with a Python runtime. Python itself is provided by the
  operator's environment.
- GitHub Issues, GitHub OAuth, the GitHub API, and GitHub App/OAuth App services
  are external services used at the operator's choice. Use is subject to GitHub's
  terms and policies. No GitHub SDK or client library is bundled.

## Lucide pin icon

The search pin is adapted from Lucide's
[`pin.svg`](https://github.com/lucide-icons/lucide/blob/ee8e10d746a10907205366cfd984922f0c58939a/icons/pin.svg)
at commit `ee8e10d746a10907205366cfd984922f0c58939a`. Its paths are scaled
from a 24 × 24 to a 20 × 20 viewBox. It is not among the Feather-derived icons
listed in the [Lucide license](https://github.com/lucide-icons/lucide/blob/ee8e10d746a10907205366cfd984922f0c58939a/LICENSE).
The same notice is published with the static site at `licenses/lucide-pin.txt`.

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Build-time mathematics

Hugo's `transform.ToMath` uses Hugo's embedded KaTeX engine to generate MathML
at build time. Hugo and the engine are not distributed with this theme, and no
KaTeX JavaScript, CSS, or fonts are shipped as browser assets. Hugo is
[Apache-2.0 licensed](https://github.com/gohugoio/hugo/blob/master/LICENSE).
KaTeX is [MIT licensed](https://github.com/KaTeX/KaTeX/blob/main/LICENSE),
Copyright (c) 2013–2020 Khan Academy and other contributors. The local Hugo
0.169.0 release uses KaTeX 0.18.4; other supported Hugo releases may use a
different embedded version.

## Development-only tools

The following tools were used to build or verify the project and are not
distributed as part of the theme or service:

| Tool | License | Role |
| --- | --- | --- |
| [Hugo Extended](https://github.com/gohugoio/hugo) | Apache-2.0 | Static site generator used for builds and verification. |
| [Python](https://www.python.org/) standard library | Python Software Foundation License | Runtime used by the comments service and its tests; not vendored. |
| [Playwright CLI](https://github.com/microsoft/playwright) | Apache-2.0 | Local, development-only browser verification. Not required at runtime and not shipped. |
| GitHub REST and OAuth documentation | Documentation reference | Consulted to implement the service contract and GitHub App/OAuth App setup. Documentation is not bundled code. |

Hugo and Playwright are not included in this repository's distributed theme.
The local development checkout may contain a project-specific tool directory,
but it is not part of the theme. GitHub service use is governed by GitHub's
terms, including the [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service).

## Service, examples, and fixtures

- The Python comments service is part of this repository and is licensed under
  the same root MIT License.
- Example articles, author identities, avatars, illustrations, comments, issue
  content, and UI test fixtures are fictional or generic sample data.
- `server/tests/mock_github.py` is a local test double. It is not an official
  GitHub implementation and is not evidence of live GitHub integration.

## Operator additions

If an operator adds third-party code, fonts, icons, analytics, embedded
services, or other assets to a deployment, that operator is responsible for
checking the applicable licenses, including attribution and notice
requirements, and for adding appropriate notices to their own distribution.
