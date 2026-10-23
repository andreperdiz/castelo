import OSM from './osm.json' with { type: 'json' };

// Óbidos geodata in the local frame (see WorldLayout): the OpenStreetMap features converted by
// tools/geodata/build.mjs (© OpenStreetMap contributors, ODbL) and the DEM grids (public/data):
// Copernicus (© DLR / Airbus, provided under COPERNICUS by the EU and ESA) and, round the town, the
// DGT LiDAR terrain model (© Direção-Geral do Território, CC BY 4.0).
export { OSM };

// ---------------------------------------------------------------- DEM grids

// Loads public/data/dem*.bin (int16 decimetres) as { near, far } grids:
// { n, step, half, data: Float32Array (m) }, row 0 = north edge (z = -half), column 0 = west edge.
// and, where there are DGT LiDAR tiles, detail: { nx, nz, x0, z0, step, data (m), w (0..1, how much is
// LiDAR) }, row 0 at z0, column 0 at x0.
export async function loadDEM( base = 'data/' ) {

	const read = async ( name ) => {

		if ( typeof process !== 'undefined' && process.versions && process.versions.node && typeof window === 'undefined' ) {

			// node (tests): read from public/
			const fs = await import( 'node:fs' );
			const url = new URL( '../../../public/' + base + name, import.meta.url );
			return fs.readFileSync( url );

		}

		const r = await fetch( base + name );
		if ( ! r.ok ) throw new Error( `failed to load ${ base + name }: ${ r.status }` );
		return name.endsWith( '.json' ) ? new TextEncoder().encode( await r.text() ) : new Uint8Array( await r.arrayBuffer() );

	};

	const meta = JSON.parse( new TextDecoder().decode( await read( 'dem.json' ) ) );
	const grid = async ( g ) => {

		const bytes = await read( g.file );
		const i16 = new Int16Array( bytes.buffer, bytes.byteOffset, g.n * g.n );
		const data = new Float32Array( g.n * g.n );
		for ( let i = 0; i < data.length; i ++ ) data[ i ] = i16[ i ] * 0.1;
		return { n: g.n, step: g.step, half: ( g.n - 1 ) / 2 * g.step, data };

	};

	const detail = async ( g ) => {

		const n = g.nx * g.nz, bytes = await read( g.file ), wb = await read( g.weights );
		const i16 = new Int16Array( bytes.buffer, bytes.byteOffset, n );
		const data = new Float32Array( n ), w = new Float32Array( n );
		for ( let i = 0; i < n; i ++ ) {

			data[ i ] = i16[ i ] * 0.01;
			w[ i ] = wb[ i ] / 255;

		}

		return { nx: g.nx, nz: g.nz, x0: g.x0, z0: g.z0, step: g.step, data, w };

	};

	return { origin: meta.origin, near: await grid( meta.near ), far: await grid( meta.far ), detail: meta.detail ? await detail( meta.detail ) : null };

}

// Catmull-Rom bicubic sample of a DEM grid at local (x, z); clamps at the edges
export function sampleGrid( g, x, z ) {

	const fx = ( x + g.half ) / g.step, fz = ( z + g.half ) / g.step;
	const n = g.n, d = g.data;
	const i = Math.floor( fx ), j = Math.floor( fz ), tx = fx - i, tz = fz - j;
	const at = ( a, b ) => d[ ( b < 0 ? 0 : b >= n ? n - 1 : b ) * n + ( a < 0 ? 0 : a >= n ? n - 1 : a ) ];
	const cr = ( p0, p1, p2, p3, t ) => p1 + 0.5 * t * ( p2 - p0 + t * ( 2 * p0 - 5 * p1 + 4 * p2 - p3 + t * ( 3 * ( p1 - p2 ) + p3 - p0 ) ) );
	const row = ( b ) => cr( at( i - 1, b ), at( i, b ), at( i + 1, b ), at( i + 2, b ), tx );
	return cr( row( j - 1 ), row( j ), row( j + 1 ), row( j + 2 ), tz );

}

// bilinear sample (cheap, for the far field)
export function sampleGridLinear( g, x, z ) {

	const n = g.n, d = g.data;
	let fx = ( x + g.half ) / g.step, fz = ( z + g.half ) / g.step;
	fx = fx < 0 ? 0 : fx > n - 1.0001 ? n - 1.0001 : fx;
	fz = fz < 0 ? 0 : fz > n - 1.0001 ? n - 1.0001 : fz;
	const i = Math.floor( fx ), j = Math.floor( fz ), tx = fx - i, tz = fz - j;
	const k = j * n + i;
	return ( d[ k ] * ( 1 - tx ) + d[ k + 1 ] * tx ) * ( 1 - tz ) + ( d[ k + n ] * ( 1 - tx ) + d[ k + n + 1 ] * tx ) * tz;

}

// ---------------------------------------------------------------- polylines

export function polylineLength( pts ) {

	let s = 0;
	for ( let i = 0; i + 1 < pts.length; i ++ ) s += Math.hypot( pts[ i + 1 ][ 0 ] - pts[ i ][ 0 ], pts[ i + 1 ][ 1 ] - pts[ i ][ 1 ] );
	return s;

}

// distance from (x, z) to segment a-b, and the parameter along it
export function segmentDistance( x, z, a, b ) {

	const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ];
	const l2 = dx * dx + dz * dz;
	let t = l2 > 0 ? ( ( x - a[ 0 ] ) * dx + ( z - a[ 1 ] ) * dz ) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return [ Math.hypot( x - a[ 0 ] - dx * t, z - a[ 1 ] - dz * t ), t ];

}

export function pointInPolygon( x, z, poly ) {

	let inside = false;
	for ( let i = 0, j = poly.length - 1; i < poly.length; j = i ++ ) {

		const [ xi, zi ] = poly[ i ], [ xj, zj ] = poly[ j ];
		if ( ( zi > z ) !== ( zj > z ) && x < ( xj - xi ) * ( z - zi ) / ( zj - zi ) + xi ) inside = ! inside;

	}

	return inside;

}

export function polygonArea( poly ) {

	let a = 0;
	for ( let i = 0, j = poly.length - 1; i < poly.length; j = i ++ ) a += poly[ j ][ 0 ] * poly[ i ][ 1 ] - poly[ i ][ 0 ] * poly[ j ][ 1 ];
	return a / 2;

}

// resample a polyline at a fixed spacing (keeps the ends)
export function resample( pts, step ) {

	const out = [ pts[ 0 ].slice() ];
	let carry = 0;
	for ( let i = 0; i + 1 < pts.length; i ++ ) {

		const a = pts[ i ], b = pts[ i + 1 ];
		const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
		let s = step - carry;
		while ( s <= L ) {

			const t = s / L;
			out.push( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ] );
			s += step;

		}

		carry = L - ( s - step );

	}

	const last = pts[ pts.length - 1 ];
	const pl = out[ out.length - 1 ];
	if ( Math.hypot( last[ 0 ] - pl[ 0 ], last[ 1 ] - pl[ 1 ] ) > step * 0.3 ) out.push( last.slice() );
	else out[ out.length - 1 ] = last.slice();
	return out;

}

// Bins polyline segments in a uniform grid for nearest-segment queries.
export class SegmentIndex {

	constructor( lines, cell = 16 ) {

		this.cell = cell;
		this.bins = new Map();
		this.segs = [];
		for ( const line of lines ) {

			const pts = line.pts || line;
			for ( let i = 0; i + 1 < pts.length; i ++ ) {

				const s = { a: pts[ i ], b: pts[ i + 1 ], line, i };
				const id = this.segs.push( s ) - 1;
				const x0 = Math.floor( Math.min( s.a[ 0 ], s.b[ 0 ] ) / cell ), x1 = Math.floor( Math.max( s.a[ 0 ], s.b[ 0 ] ) / cell );
				const z0 = Math.floor( Math.min( s.a[ 1 ], s.b[ 1 ] ) / cell ), z1 = Math.floor( Math.max( s.a[ 1 ], s.b[ 1 ] ) / cell );
				for ( let z = z0; z <= z1; z ++ ) for ( let x = x0; x <= x1; x ++ ) {

					const k = x * 73856093 ^ z * 19349663;
					let b = this.bins.get( k );
					if ( ! b ) this.bins.set( k, b = [] );
					b.push( id );

				}

			}

		}

	}

	// nearest segment within `radius`: { d, seg, t } or null
	nearest( x, z, radius ) {

		const c = this.cell;
		const x0 = Math.floor( ( x - radius ) / c ), x1 = Math.floor( ( x + radius ) / c );
		const z0 = Math.floor( ( z - radius ) / c ), z1 = Math.floor( ( z + radius ) / c );
		let best = null, bd = radius;
		for ( let bz = z0; bz <= z1; bz ++ ) for ( let bx = x0; bx <= x1; bx ++ ) {

			const b = this.bins.get( bx * 73856093 ^ bz * 19349663 );
			if ( ! b ) continue;
			for ( const id of b ) {

				const s = this.segs[ id ];
				const [ d, t ] = segmentDistance( x, z, s.a, s.b );
				if ( d < bd ) {

					bd = d;
					best = { d, seg: s, t };

				}

			}

		}

		return best;

	}

}

// ---------------------------------------------------------------- the walls

// The curtain wall as one loop: OSM draws it as two near-parallel ways (inner and outer faces, ~2-4 m
// apart) from the castle round to the castle; the castle enclosure closes the loop. Returns
// { line: [[x, z]] (open, castle to castle), poly: closed interior polygon, outward: the sign s for
// which ( dz, -dx ) * s points out of the town for a segment direction ( dx, dz ) }.
export function curtainWall() {

	const byId = ( id ) => OSM.walls.find( ( w ) => w.id === id );
	const inner = byId( 1276266197 ) || OSM.walls.reduce( ( a, b ) => ( b.pts.length > a.pts.length ? b : a ) );
	const line = inner.pts.map( ( p ) => p.slice() );
	const poly = line.slice();
	// vote over the segments: which side of the line is outside the polygon
	let votes = 0;
	for ( let i = 0; i + 1 < line.length; i ++ ) {

		const a = line[ i ], b = line[ i + 1 ];
		const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ], L = Math.hypot( dx, dz );
		if ( L < 1 ) continue;
		const mx = ( a[ 0 ] + b[ 0 ] ) / 2 + dz / L * 2, mz = ( a[ 1 ] + b[ 1 ] ) / 2 - dx / L * 2;
		votes += pointInPolygon( mx, mz, poly ) ? - 1 : 1;

	}

	return { line, poly, outward: votes >= 0 ? 1 : - 1 };

}
