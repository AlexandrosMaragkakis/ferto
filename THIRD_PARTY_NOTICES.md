# Third-party assets

FERTO's original code, documentation, branding and demo illustrations are
covered by the [MIT License](LICENSE). Third-party assets below keep their
own rights and terms; the MIT grant does not cover Spotify marks or music
artwork. Dependency packages retain the licenses shipped with those packages.

The real track identifiers, titles and Spotify artwork URLs in
[`scripts/demo-catalogue.sql`](scripts/demo-catalogue.sql) identify Spotify
content; they do not license the recordings, music metadata or artwork under
MIT. The demo loads artwork and playback from Spotify at runtime and keeps
Spotify attribution and listening links.

## Spotify attribution

The app uses unmodified official white and black full-logo SVGs from Spotify's
[Design & Branding Guidelines](https://developer.spotify.com/documentation/design),
downloaded on 5 November 2026 from the linked
[official full-logo archive](https://developer.spotify.com/images/guidelines/design/2024-spotify-full-logo.zip).
Spotify owns these marks. Their use is subject to Spotify's terms and brand
guidelines; they are not relicensed as FERTO artwork.

| Repository file | Original archive entry | SHA-256 |
| --- | --- | --- |
| `web/public/third-party/spotify-logo-white.svg` | `Full_Logo_White_RGB.svg` | `31cdfcdd58d3533a32d287267a1c404f376749b1fc4da99e4baa2233684f053c` |
| `web/public/third-party/spotify-logo-black.svg` | `Full_Logo_Black_RGB.svg` | `b91219c14405166e3667deb7f250df4b939a8a5dbc8460ee9525a75672ba9ec5` |

Archive SHA-256: `b3d28ef2474a46b88aeb67c1449b522046003233a3df59e8e63582830101270f`.

The listening link keeps the logo geometry and colours unchanged, uses a width
of 92 px, and links to the current track on Spotify. Album artwork comes from
Spotify at runtime, is displayed without cropping or overlaid controls, and is
not included in FERTO's source assets or sharing image. The official Spotify
Embed provides its own player and attribution.

## Documentation image

`docs/images/demo-cover.svg` is original geometric artwork authored for this
project and covered by MIT. `docs/images/ferto-demo.png` captures FERTO with
fictional recording metadata and that artwork; the external player is omitted
and no real music cover is bundled. The screenshot includes the official
Spotify attribution logo used by the interface, which retains Spotify's rights
and terms as described above.
