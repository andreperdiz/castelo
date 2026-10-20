# Credits

Castelo is a fork of [Tidewater](https://github.com/dgreenheck/tidewater) by DRG Software Solutions LLC.
Its engine, sky, atmosphere, clouds, post chain, walker, free camera and sound come from Tidewater. The code in
this repository is released under the MIT license (see `LICENSE`). The data below keeps its own licence.

## Map data: `src/world/obidos/osm.json`

Streets, buildings, the town walls, towers, gates, land use and trees of Óbidos are derived from
[OpenStreetMap](https://www.openstreetmap.org/copyright) data, © OpenStreetMap contributors, available under
the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). The derived file is
rebuilt by `tools/geodata/` (`fetch.sh`, then `node tools/geodata/build.mjs`).

## Elevation data: `public/data/dem-*.bin`

Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018,
provided under COPERNICUS by the European Union and ESA; all rights reserved. The GLO-30 tiles are read
from the public AWS Open Data bucket and resampled to the local frame by `tools/geodata/build.mjs`.

Around the town (`dem-detail*.bin`, and blended into `dem-near.bin`) the heights come from the LiDAR digital
terrain model at 2 m (MDT-2m, 2024 flight) by the [Direção-Geral do Território](https://www.dgterritorio.gov.pt/),
available under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) from its
[data portal](https://cdd.dgterritorio.gov.pt/) (a free account is needed to download the tiles). The tiles are
reprojected from PT-TM06 to the local frame and feathered into the Copernicus heights at their edges.

## Audio: `public/audio/`

Ten field recordings from [Freesound](https://freesound.org), all released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), taken with their processing from Tidewater. No
attribution is required, but every file is credited with its author and source link in
[`public/audio/CREDITS.md`](public/audio/CREDITS.md).

Recordists: bruno.auzet, felix.blume, hdfreema, 200221-WeanBekker, SilentStrikeZ, SecureSubset, squashy555,
Soojay, coalcon, dubminister, nathankwright and SorenF109.

## Fonts

[Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) are both under the
SIL Open Font License 1.1. They are loaded from Google Fonts at runtime and are not part of this repository.

## Libraries

The SMAA area and search lookup textures (`public/textures/smaa/`) are from three.js (MIT), which ships
them from J. Jimenez et al.'s SMAA reference implementation (MIT).

[Vite](https://vite.dev) (MIT) and [geotiff.js](https://geotiffjs.github.io/) (MIT, used only by the geodata
tool) are npm dependencies and are not vendored here.

## Techniques and references

These are published techniques. No code from the papers is included.

| Technique | Source |
|---|---|
| Atmosphere | S. Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique* (2020) |
| Volumetric cloud modelling | A. Schneider (Guerrilla Games), the *Nubis* talks |
| Motion blur | M. McGuire et al., *A Reconstruction Filter for Plausible Motion Blur* (2012); J. Jimenez, *Next Generation Post Processing in Call of Duty: Advanced Warfare* (2014) |
| Bloom | J. Jimenez (2014) |
| Sharpening (RCAS) | AMD FidelityFX Super Resolution 1 |
| SMAA / FXAA | J. Jimenez et al., *SMAA: Enhanced Subpixel Morphological Antialiasing* (2012); T. Lottes, *FXAA* (2009); ported from three.js' SMAANode / FXAANode (MIT) |

The cloud noise, lighting and sampling scheme (`src/sky/Clouds.js`) is adapted from DRG Software Solutions'
own *Sky Pro WebGPU*. It is published here under this repository's MIT license by its copyright holder.
