// Converts the raw geodata (tools/geodata/fetch.sh) into the game's local frame:
//   public/data/dem-near.bin   Int16 decimetres, NEAR_N x NEAR_N samples, NEAR_STEP m apart, centred on the origin
//   public/data/dem-far.bin    Int16 decimetres, FAR_N x FAR_N samples, FAR_STEP m apart (box-filtered)
//   public/data/dem-detail.bin Int16 centimetres, DETAIL_STEP m apart over the DGT LiDAR tiles (if any)
//   public/data/dem-detail-w.bin  Uint8, how much of each detail sample is LiDAR (255) vs Copernicus (0)
//   src/world/obidos/osm.json  walls, towers, gates, buildings, streets, landuse, trees as local polylines
// Local frame (WorldLayout): x east, z south (north = -z), metres from ORIGIN (the centre of the walls'
// bounding box). Heights are the Copernicus DSM (surface model: it includes roofs and tree tops) except
// where DGT LiDAR terrain tiles (MDT-2m-*.tif, bare ground, 2 m, ETRS89 / PT-TM06) lie in raw/: those
// replace it, feathered into it over LIDAR_FEATHER m at the edge of their coverage.
//   node tools/geodata/build.mjs       (skips the OSM step if raw/obidos-osm.json is missing)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';

const HERE = path.dirname( fileURLToPath( import.meta.url ) );
const ROOT = path.resolve( HERE, '../..' );
const RAW = path.join( HERE, 'raw' );

export const ORIGIN = { lat: 39.3615849, lon: - 9.1572126 };
const NEAR_STEP = 10, NEAR_HALF = 1300; // m
const FAR_STEP = 60, FAR_HALF = 24000; // m
const DETAIL_STEP = 2, DETAIL_HALF = 1024, LIDAR_FEATHER = 80; // m; the detail grid stays inside the 2048 m heightmap

// metres per degree at the origin (WGS84 series)
const phi = ORIGIN.lat * Math.PI / 180;
const M_LAT = 111132.92 - 559.82 * Math.cos( 2 * phi ) + 1.175 * Math.cos( 4 * phi );
const M_LON = 111412.84 * Math.cos( phi ) - 93.5 * Math.cos( 3 * phi );
const toLocal = ( lat, lon ) => [ ( lon - ORIGIN.lon ) * M_LON, - ( lat - ORIGIN.lat ) * M_LAT ];
const toGeo = ( x, z ) => [ ORIGIN.lat - z / M_LAT, ORIGIN.lon + x / M_LON ];

// ---------------------------------------------------------------- DEM

async function loadTiles() {

	const tiles = [];
	for ( const f of fs.readdirSync( RAW ).filter( ( f ) => f.startsWith( 'cop30_' ) && f.endsWith( '.tif' ) ) ) {

		const img = await ( await fromFile( path.join( RAW, f ) ) ).getImage();
		const [ x0, y0, x1, y1 ] = img.getBoundingBox();
		const data = ( await img.readRasters() )[ 0 ];
		tiles.push( { x0, y0, x1, y1, w: img.getWidth(), h: img.getHeight(), data } );

	}

	return tiles;

}

function makeSampler( tiles ) {

	// pixel-is-area grid: centre of pixel (i, j) at x0 + (i + 0.5) / w * (x1 - x0)
	const at = ( lat, lon ) => {

		for ( const t of tiles ) {

			if ( lon < t.x0 || lon >= t.x1 || lat < t.y0 || lat >= t.y1 ) continue;
			const fx = ( lon - t.x0 ) / ( t.x1 - t.x0 ) * t.w - 0.5;
			const fy = ( t.y1 - lat ) / ( t.y1 - t.y0 ) * t.h - 0.5;
			return { t, fx, fy };

		}

		return null;

	};

	const px = ( t, i, j ) => t.data[ Math.min( t.h - 1, Math.max( 0, j ) ) * t.w + Math.min( t.w - 1, Math.max( 0, i ) ) ];
	// Catmull-Rom bicubic
	const cr = ( p0, p1, p2, p3, t ) => p1 + 0.5 * t * ( p2 - p0 + t * ( 2 * p0 - 5 * p1 + 4 * p2 - p3 + t * ( 3 * ( p1 - p2 ) + p3 - p0 ) ) );
	return ( lat, lon ) => {

		const s = at( lat, lon );
		if ( ! s ) return 0;
		const { t, fx, fy } = s;
		const i = Math.floor( fx ), j = Math.floor( fy ), tx = fx - i, ty = fy - j;
		const row = ( jj ) => cr( px( t, i - 1, jj ), px( t, i, jj ), px( t, i + 1, jj ), px( t, i + 2, jj ), tx );
		return cr( row( j - 1 ), row( j ), row( j + 1 ), row( j + 2 ), ty );

	};

}

function writeGrid( file, n, step, fn ) {

	const out = new Int16Array( n * n );
	const half = ( n - 1 ) / 2 * step;
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const h = fn( - half + i * step, - half + j * step );
		out[ j * n + i ] = Math.max( - 32000, Math.min( 32000, Math.round( h * 10 ) ) );

	}

	fs.writeFileSync( file, Buffer.from( out.buffer ) );
	return out;

}

// ---------------------------------------------------------------- DGT LiDAR (PT-TM06)

// ETRS89 / Portugal TM06 (EPSG:3763): transverse Mercator on GRS80 (Snyder's series). ETRS89 and
// WGS84 differ by well under a metre here.
const TM = { lat0: 39.66825833333333, lon0: - 8.133108333333333, a: 6378137, f: 1 / 298.257222101 };
function toTM06( lat, lon ) {

	const { a, f } = TM, e2 = f * ( 2 - f ), ep2 = e2 / ( 1 - e2 ), e4 = e2 * e2, e6 = e4 * e2;
	const merid = ( p ) => a * ( ( 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256 ) * p - ( 3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024 ) * Math.sin( 2 * p )
		+ ( 15 * e4 / 256 + 45 * e6 / 1024 ) * Math.sin( 4 * p ) - 35 * e6 / 3072 * Math.sin( 6 * p ) );
	const p = lat * Math.PI / 180, s = Math.sin( p ), c = Math.cos( p ), t = Math.tan( p );
	const N = a / Math.sqrt( 1 - e2 * s * s ), T = t * t, C = ep2 * c * c, A = ( lon - TM.lon0 ) * Math.PI / 180 * c;
	const E = N * ( A + ( 1 - T + C ) * A ** 3 / 6 + ( 5 - 18 * T + T * T + 72 * C - 58 * ep2 ) * A ** 5 / 120 );
	const Nn = merid( p ) - merid( TM.lat0 * Math.PI / 180 ) + N * t * ( A * A / 2 + ( 5 - T + 9 * C + 4 * C * C ) * A ** 4 / 24
		+ ( 61 - 58 * T + T * T + 600 * C - 330 * ep2 ) * A ** 6 / 720 );
	return [ E, Nn ];

}

// the LiDAR tiles mosaicked onto one 2 m grid (NaN where there's no tile); null if there are none
async function loadLidar() {

	const files = fs.readdirSync( RAW ).filter( ( f ) => /^MDT-2m-.*\.tiff?$/.test( f ) );
	if ( ! files.length ) return null;
	const tiles = [];
	for ( const f of files ) {

		const img = await ( await fromFile( path.join( RAW, f ) ) ).getImage();
		const [ x0, y0, x1, y1 ] = img.getBoundingBox();
		tiles.push( { x0, y0, x1, y1, w: img.getWidth(), h: img.getHeight(), data: ( await img.readRasters() )[ 0 ], nodata: img.getGDALNoData() ?? - 999 } );

	}

	const res = ( tiles[ 0 ].x1 - tiles[ 0 ].x0 ) / tiles[ 0 ].w;
	const E0 = Math.min( ...tiles.map( ( t ) => t.x0 ) ), N1 = Math.max( ...tiles.map( ( t ) => t.y1 ) );
	const w = Math.round( ( Math.max( ...tiles.map( ( t ) => t.x1 ) ) - E0 ) / res ), h = Math.round( ( N1 - Math.min( ...tiles.map( ( t ) => t.y0 ) ) ) / res );
	const data = new Float32Array( w * h ).fill( NaN );
	for ( const t of tiles ) {

		const oi = Math.round( ( t.x0 - E0 ) / res ), oj = Math.round( ( N1 - t.y1 ) / res );
		for ( let j = 0; j < t.h; j ++ ) for ( let i = 0; i < t.w; i ++ ) {

			const v = t.data[ j * t.w + i ];
			if ( v > t.nodata + 1 ) data[ ( oj + j ) * w + oi + i ] = v;

		}

	}

	console.log( `LiDAR: ${ files.length } tiles, ${ w } x ${ h } at ${ res } m` );
	// bilinear between pixel centres; NaN unless all four are there
	return ( lat, lon ) => {

		const [ E, N ] = toTM06( lat, lon );
		const fx = ( E - E0 ) / res - 0.5, fy = ( N1 - N ) / res - 0.5;
		const i = Math.floor( fx ), j = Math.floor( fy );
		if ( i < 0 || j < 0 || i + 1 >= w || j + 1 >= h ) return NaN;
		const tx = fx - i, ty = fy - j, k = j * w + i;
		return ( data[ k ] * ( 1 - tx ) + data[ k + 1 ] * tx ) * ( 1 - ty ) + ( data[ k + w ] * ( 1 - tx ) + data[ k + w + 1 ] * tx ) * ty;

	};

}

// LiDAR over the heightmap, feathered into the Copernicus heights (cop) where its coverage ends:
// { nx, nz, x0, z0, h (Float32, m), w (Float32 0..1) } on the DETAIL_STEP lattice, or null
function detailGrid( lidar, cop ) {

	const S = DETAIL_STEP, n = Math.round( 2 * DETAIL_HALF / S ) + 1;
	const lid = new Float32Array( n * n );
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) lid[ j * n + i ] = lidar( ...toGeo( - DETAIL_HALF + i * S, - DETAIL_HALF + j * S ) );
	// crop to the covered rows and columns
	let i0 = n, i1 = - 1, j0 = n, j1 = - 1;
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) if ( ! isNaN( lid[ j * n + i ] ) ) {

		i0 = Math.min( i0, i ); i1 = Math.max( i1, i ); j0 = Math.min( j0, j ); j1 = Math.max( j1, j );

	}

	if ( i1 < 0 ) return null;
	const nx = i1 - i0 + 1, nz = j1 - j0 + 1, x0 = - DETAIL_HALF + i0 * S, z0 = - DETAIL_HALF + j0 * S;
	// distance (m) to the nearest uncovered sample or the grid's edge: two-pass chamfer
	const d = new Float32Array( nx * nz );
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const edge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
		d[ j * nx + i ] = edge || isNaN( lid[ ( j0 + j ) * n + i0 + i ] ) ? 0 : 1e9;

	}

	const D = S, DD = S * Math.SQRT2;
	const relax = ( k, k2, c ) => {

		if ( d[ k2 ] + c < d[ k ] ) d[ k ] = d[ k2 ] + c;

	};

	for ( let j = 1; j < nz; j ++ ) for ( let i = 1; i < nx - 1; i ++ ) {

		const k = j * nx + i;
		relax( k, k - 1, D ); relax( k, k - nx, D ); relax( k, k - nx - 1, DD ); relax( k, k - nx + 1, DD );

	}

	for ( let j = nz - 2; j >= 0; j -- ) for ( let i = nx - 2; i > 0; i -- ) {

		const k = j * nx + i;
		relax( k, k + 1, D ); relax( k, k + nx, D ); relax( k, k + nx + 1, DD ); relax( k, k + nx - 1, DD );

	}

	const h = new Float32Array( nx * nz ), w = new Float32Array( nx * nz );
	let sum = 0, cnt = 0;
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const k = j * nx + i, x = x0 + i * S, z = z0 + j * S, c = cop( x, z );
		const t = Math.min( 1, d[ k ] / LIDAR_FEATHER ), wt = t * t * ( 3 - 2 * t );
		const l = lid[ ( j0 + j ) * n + i0 + i ];
		w[ k ] = wt;
		h[ k ] = wt > 0 ? c + ( l - c ) * wt : c;
		if ( wt > 0 ) {

			sum += c - l; cnt ++;

		}

	}

	console.log( `detail ${ nx } x ${ nz } from (${ x0 }, ${ z0 }); Copernicus is on average ${ ( sum / cnt ).toFixed( 2 ) } m above the LiDAR ground` );
	return { nx, nz, x0, z0, h, w };

}

// ---------------------------------------------------------------- OSM

function convertOSM() {

	const osm = JSON.parse( fs.readFileSync( path.join( RAW, 'obidos-osm.json' ) ) );
	const nodes = new Map(), ways = new Map();
	for ( const e of osm.elements ) {

		if ( e.type === 'node' ) nodes.set( e.id, e );
		else if ( e.type === 'way' ) ways.set( e.id, e );

	}

	const r1 = ( v ) => Math.round( v * 10 ) / 10;
	const pts = ( w ) => w.nodes.map( ( id ) => nodes.get( id ) ).filter( Boolean ).map( ( n ) => toLocal( n.lat, n.lon ).map( r1 ) );
	const pick = ( t, keys ) => {

		const o = {};
		for ( const k of keys ) if ( t[ k ] !== undefined ) o[ k ] = t[ k ];
		return o;

	};

	const out = { origin: ORIGIN, walls: [], towers: [], gates: [], buildings: [], streets: [], landuse: [], barriers: [], trees: [], pois: [] };
	const TAGS = [ 'name', 'building', 'building:levels', 'roof:shape', 'roof:levels', 'amenity', 'historic', 'man_made', 'tower:type', 'height', 'denomination', 'shop', 'tourism' ];
	for ( const w of ways.values() ) {

		const t = w.tags;
		if ( ! t ) continue;
		const p = pts( w );
		if ( p.length < 2 ) continue;
		const closed = w.nodes[ 0 ] === w.nodes[ w.nodes.length - 1 ];
		if ( t.barrier === 'city_wall' ) out.walls.push( { id: w.id, closed, pts: p, ...pick( t, [ 'name', 'defensive_works', 'two_sided' ] ) } );
		else if ( t.man_made === 'tower' && t[ 'tower:type' ] === 'defensive' ) out.towers.push( { id: w.id, pts: p, ...pick( t, TAGS ) } );
		else if ( t.historic === 'city_gate' ) out.gates.push( { id: w.id, pts: p, ...pick( t, TAGS ) } );
		else if ( t.building ) out.buildings.push( { id: w.id, pts: p, ...pick( t, TAGS ) } );
		else if ( t.highway ) out.streets.push( { id: w.id, pts: p, highway: t.highway, ...pick( t, [ 'name', 'surface', 'width', 'tunnel', 'layer', 'incline', 'step_count' ] ) } );
		else if ( t.landuse || t.natural || t.leisure ) out.landuse.push( { id: w.id, closed, pts: p, kind: t.landuse || t.natural || t.leisure } );
		else if ( t.barrier ) out.barriers.push( { id: w.id, pts: p, kind: t.barrier } );

	}

	for ( const n of nodes.values() ) {

		const t = n.tags;
		if ( ! t ) continue;
		const [ x, z ] = toLocal( n.lat, n.lon ).map( r1 );
		if ( t.natural === 'tree' ) out.trees.push( [ x, z ] );
		else if ( t.historic || t.amenity ) out.pois.push( { x, z, ...pick( t, [ 'name', 'historic', 'amenity' ] ) } );

	}

	return out;

}

// ---------------------------------------------------------------- main

const tiles = await loadTiles();
const sample = makeSampler( tiles );
const cop = ( x, z ) => sample( ...toGeo( x, z ) );
const lidar = await loadLidar();
const detail = lidar && detailGrid( lidar, cop );

// the best height at (x, z): the detail grid (bilinear) where there is one, else Copernicus
const at = ! detail ? cop : ( x, z ) => {

	const fx = ( x - detail.x0 ) / DETAIL_STEP, fz = ( z - detail.z0 ) / DETAIL_STEP;
	const i = Math.floor( fx ), j = Math.floor( fz );
	if ( i < 0 || j < 0 || i + 1 >= detail.nx || j + 1 >= detail.nz ) return cop( x, z );
	const tx = fx - i, tz = fz - j, k = j * detail.nx + i, H = detail.h, nx = detail.nx;
	return ( H[ k ] * ( 1 - tx ) + H[ k + 1 ] * tx ) * ( 1 - tz ) + ( H[ k + nx ] * ( 1 - tx ) + H[ k + nx + 1 ] * tx ) * tz;

};

// near grid: box filter over the 10 m cell (5 x 5 taps), so the LiDAR detail doesn't alias into it
const nearN = Math.round( 2 * NEAR_HALF / NEAR_STEP ) + 1;
writeGrid( path.join( ROOT, 'public/data/dem-near.bin' ), nearN, NEAR_STEP, ! detail ? cop : ( x, z ) => {

	let s = 0;
	for ( let b = - 2; b <= 2; b ++ ) for ( let a = - 2; a <= 2; a ++ ) s += at( x + a * NEAR_STEP / 5, z + b * NEAR_STEP / 5 );
	return s / 25;

} );

// far grid: box filter over the sample footprint (5 x 5 taps of the 30 m DEM per 60 m cell)
const farN = Math.round( 2 * FAR_HALF / FAR_STEP ) + 1;
writeGrid( path.join( ROOT, 'public/data/dem-far.bin' ), farN, FAR_STEP, ( x, z ) => {

	let s = 0;
	for ( let b = - 2; b <= 2; b ++ ) for ( let a = - 2; a <= 2; a ++ ) s += cop( x + a * FAR_STEP / 5, z + b * FAR_STEP / 5 );
	return s / 25;

} );

const meta = {
	origin: ORIGIN,
	near: { n: nearN, step: NEAR_STEP, file: 'dem-near.bin' },
	far: { n: farN, step: FAR_STEP, file: 'dem-far.bin' },
	units: 'int16 decimetres, row-major, row 0 = north (z = -half), column 0 = west (x = -half)',
};
if ( detail ) {

	const { nx, nz, x0, z0, h, w } = detail;
	fs.writeFileSync( path.join( ROOT, 'public/data/dem-detail.bin' ), Buffer.from( Int16Array.from( h, ( v ) => Math.max( - 32000, Math.min( 32000, Math.round( v * 100 ) ) ) ).buffer ) );
	fs.writeFileSync( path.join( ROOT, 'public/data/dem-detail-w.bin' ), Buffer.from( Uint8Array.from( w, ( v ) => Math.round( v * 255 ) ).buffer ) );
	meta.detail = { nx, nz, x0, z0, step: DETAIL_STEP, file: 'dem-detail.bin', weights: 'dem-detail-w.bin',
		units: 'int16 centimetres, row 0 at z0 (north), column 0 at x0 (west); weights uint8, 255 = DGT LiDAR, 0 = Copernicus' };

} else for ( const f of [ 'dem-detail.bin', 'dem-detail-w.bin' ] ) fs.rmSync( path.join( ROOT, 'public/data', f ), { force: true } );

fs.writeFileSync( path.join( ROOT, 'public/data/dem.json' ), JSON.stringify( meta, null, '\t' ) );
console.log( `near ${ nearN }^2, far ${ farN }^2${ detail ? `, detail ${ detail.nx } x ${ detail.nz }` : '' }` );

if ( fs.existsSync( path.join( RAW, 'obidos-osm.json' ) ) ) {

	const osm = convertOSM();
	fs.mkdirSync( path.join( ROOT, 'src/world/obidos' ), { recursive: true } );
	fs.writeFileSync( path.join( ROOT, 'src/world/obidos/osm.json' ), JSON.stringify( osm ) );
	console.log( `osm: ${ Object.entries( osm ).filter( ( [ , v ] ) => Array.isArray( v ) ).map( ( [ k, v ] ) => `${ k } ${ v.length }` ).join( ', ' ) }` );

} else console.log( 'osm: raw/obidos-osm.json missing, osm.json left as it is' );
