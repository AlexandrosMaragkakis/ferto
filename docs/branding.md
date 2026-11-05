# FERTO identity

The chosen mark is **Next Disc**: a record with a forward cut. The user selected
this direction on 5 November 2026 after reviewing the monochrome shortlist.

The interface gets its colours from the current song's artwork. Branding
therefore adds no fixed accent colour. The page keeps its existing FERTO text;
the symbol is used as the favicon. A future optional in-page mark should use
the provided monochrome geometry and inherit `currentColor` from the current
text colour, rather than assigning a brand hue.

## Assets

| File | Use |
| --- | --- |
| [mark.svg](../web/public/brand/mark.svg) | Transparent monochrome symbol; inherits text colour when inlined |
| [wordmark.svg](../web/public/brand/wordmark.svg) | Geometric FERTO lettering, drawn as paths |
| [lockup.svg](../web/public/brand/lockup.svg) | Symbol plus wordmark for standalone material |
| [favicon.svg](../web/public/favicon.svg) | Neutral black tile and white mark, independent of song colours |
| [favicon.ico](../web/public/favicon.ico) | 16/32/48 px fallback icons |
| [favicon-16.png](../web/public/favicon-16.png), [favicon-32.png](../web/public/favicon-32.png), [favicon-48.png](../web/public/favicon-48.png) | Matching raster favicon exports |
| [apple-touch-icon.png](../web/public/apple-touch-icon.png) | Opaque 180 px touch icon |
| [icon-512.png](../web/public/brand/icon-512.png) | Opaque 512 px square icon/avatar |
| [social-preview.png](../web/public/social-preview.png) | Neutral 1200 × 630 sharing image |
| [social-preview.svg](../web/public/brand/social-preview.svg) | Editable sharing-image source |

The icon/touch links are installed and deployed. The page-polish checkpoint
adds description, Open Graph and sharing-card metadata with the public origin
from the explicitly selected instance configuration. The page header uses live text;
it has not been replaced by the outlined wordmark or a fixed-colour image.

## Provenance and licensing record

The final SVG symbol and geometric wordmark were authored in code for this
project during the Codex-assisted design pass. No raster tracing, stock icon
or third-party font outlines were used. The sharing-image descriptor is plain
system-font text; no font files are bundled. PNG/ICO files are exports of the
same geometry, not separate designs.

Earlier generated explorations remain local and are not production assets.
The chosen FERTO geometry does not incorporate Spotify marks or album artwork.
Spotify's own attribution is separate: the listening link uses the unmodified
official full Spotify logo in white or black for the current theme. See the
[third-party asset notice](../THIRD_PARTY_NOTICES.md) for sources and hashes.

The original FERTO SVG, PNG and ICO assets, documentation illustrations and
editable sources are covered by the repository's [MIT License](../LICENSE),
chosen by the user on 5 November 2026. Spotify marks and music artwork retain
their own rights and terms, as recorded in the third-party notice. This
copyright license does not promise trademark clearance or grant Spotify
endorsement.
