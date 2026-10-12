import { Noise2D, smoothstep, clamp, lerp } from '../util/Noise.js';
import { WORLD } from './WorldLayout.js';
import { OSM, sampleGrid, sampleGridLinear, curtainWall, resample, SegmentIndex, pointInPolygon, segmentDistance } from './obidos/Geo.js';

const RES = 2048; // 1 m texels over the 2048 m domain

// street half-widths (m) by OSM highway class
const STREET_HALF = {
	motorway: 6, motorway_link: 3.5, primary: 4, primary_link: 3, secondary: 3.5, tertiary: 3.2, unclassified: 2.8,
	residential: 2.6, service: 2.0, pedestrian: 2.0, living_street: 2.2, footway: 0.9, path: 0.6, cycleway: 1.0,
	track: 1.5, steps: 1.0,
};
const UNPAVED = new Set( [ 'earth', 'dirt', 'ground', 'grass', 'unpaved', 'compacted', 'gravel', 'sand', 'rock' ] );

// Óbidos heightmap (1 m texels over 2048 m) plus bilinear queries.
//
// Heights are the Copernicus surface model (10 m grid from tools/geodata, bicubic) with small relief
// added on open ground, and shaped along the curtain wall: the ground at its outer foot is pulled down
// so the wall stands ~8-12 m above it, as at Óbidos, while inside it is only a few metres above the
// streets. Outside the domain heightAt() falls back to the far DEM grid.
//
// Masks (Uint8 0..255 per texel; TerrainBake packs them into the splat map):
//   sand  -> farmland: open, flat cultivated ground (the shader lays the field patchwork on it)
//   path  -> streets and roads (255 paved: setts, paving stones, asphalt; ~130 unpaved tracks)
//   gully -> scrub and woodland (OSM scrub / wood, steep uncultivated slopes)
//   scarp -> town ground (inside the walls and among the houses outside them)
//   rock  -> bare limestone (Float32 0..1) on the steepest slopes
export class TerrainData {

	constructor( dem, seed = 7 ) {

		this.dem = dem;
		this.size = WORLD.terrainSize;
		this.res = RES;
		this.texel = this.size / this.res;
		this.origin = - this.size / 2;
		this.noise = new Noise2D( seed );
		this.noise2 = new Noise2D( seed * 31 + 5 );
		const n = this.res * this.res;
		this.heights = new Float32Array( n );
		this.rock = new Float32Array( n );
		this.sand = new Uint8Array( n );
		this.path = new Uint8Array( n );
		this.gully = new Uint8Array( n );
		this.scarp = new Uint8Array( n );
		this.pads = [];
		this.timings = {};

		let t = performance.now();
		const mark = ( k ) => {

			const now = performance.now();
			this.timings[ k ] = now - t;
			t = now;

		};

		this.wallInfo = curtainWall();
		this.townPoly = this.wallInfo.poly;
		this.wallIndex = new SegmentIndex( [ this.wallInfo.line ], 16 );
		this._base();
		mark( 'base' );
		this._town();
		mark( 'town' );
		this._wallProfile();
		this._shapeWall();
		mark( 'wall' );
		this._streets();
		this._landcover();
		mark( 'masks' );
		this.buildMinMax();
		mark( 'minmax' );

	}

	// ------------------------------------------------------------------ generation

	idx( x, z ) {

		const i = Math.floor( ( x - this.origin ) / this.texel ), j = Math.floor( ( z - this.origin ) / this.texel );
		if ( i < 0 || j < 0 || i >= this.res || j >= this.res ) return - 1;
		return j * this.res + i;

	}

	// the DEM, with a little relief on open ground (furrows / tussocks the 30 m data can't show)
	_base() {

		const { res, texel, origin, heights, dem } = this;
		const nz = this.noise;
		// bicubic of the 10 m grid, evaluated on a 2 m lattice, then bilinear to 1 m (smooth either way)
		const C = res / 2 + 1, cs = texel * 2;
		const coarse = new Float32Array( C * C );
		for ( let j = 0; j < C; j ++ ) for ( let i = 0; i < C; i ++ ) coarse[ j * C + i ] = sampleGrid( dem.near, origin + i * cs, origin + j * cs );
		for ( let j = 0; j < res; j ++ ) {

			const z = origin + ( j + 0.5 ) * texel;
			const fz = ( j + 0.5 ) / 2, jz = Math.min( C - 2, Math.floor( fz ) ), tz = fz - jz;
			for ( let i = 0; i < res; i ++ ) {

				const x = origin + ( i + 0.5 ) * texel;
				const fx = ( i + 0.5 ) / 2, ix = Math.min( C - 2, Math.floor( fx ) ), tx = fx - ix;
				const k = jz * C + ix;
				const h = ( coarse[ k ] * ( 1 - tx ) + coarse[ k + 1 ] * tx ) * ( 1 - tz ) + ( coarse[ k + C ] * ( 1 - tx ) + coarse[ k + C + 1 ] * tx ) * tz;
				// gentle undulation (the DSM is smooth at this scale) + a hint of soil roughness
				const r = nz.fbm( x / 60, z / 60, 3 ) * 0.9 + nz.noise( x / 7, z / 7 ) * 0.12;
				heights[ j * res + i ] = h + r;

			}

		}

	}

	// inside-the-walls mask (scarp) and the ground there: the DSM averages roofs into the town's
	// ground, so the streets inside sit a little lower than the raw surface
	_town() {

		const { res, texel, origin, heights, scarp } = this;
		const poly = this.townPoly;
		let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
		for ( const [ x, z ] of poly ) {

			x0 = Math.min( x0, x ); x1 = Math.max( x1, x ); z0 = Math.min( z0, z ); z1 = Math.max( z1, z );

		}

		this.townBounds = { x0, x1, z0, z1 };
		// scanline fill of the town polygon
		const inside = this.inside = new Uint8Array( res * res );
		const j0 = Math.max( 0, Math.floor( ( z0 - origin ) / texel ) ), j1 = Math.min( res - 1, Math.ceil( ( z1 - origin ) / texel ) );
		for ( let j = j0; j <= j1; j ++ ) {

			const z = origin + ( j + 0.5 ) * texel;
			const xs = [];
			for ( let a = 0, b = poly.length - 1; a < poly.length; b = a ++ ) {

				const [ xa, za ] = poly[ a ], [ xb, zb ] = poly[ b ];
				if ( ( za > z ) !== ( zb > z ) ) xs.push( xa + ( z - za ) / ( zb - za ) * ( xb - xa ) );

			}

			xs.sort( ( a, b ) => a - b );
			for ( let q = 0; q + 1 < xs.length; q += 2 ) {

				const i0 = Math.max( 0, Math.ceil( ( xs[ q ] - origin ) / texel - 0.5 ) ), i1 = Math.min( res - 1, Math.floor( ( xs[ q + 1 ] - origin ) / texel - 0.5 ) );
				for ( let i = i0; i <= i1; i ++ ) inside[ j * res + i ] = 1;

			}

		}

		for ( let k = 0; k < res * res; k ++ ) if ( inside[ k ] ) scarp[ k ] = 255;

		// The surface model is lumpy in the town (roofs and gardens averaged in): smooth the ground
		// inside the walls (and just round them) into the ridge's shape, a bit below the raw surface
		const M = 40;
		const ci0 = Math.max( 0, Math.floor( ( x0 - M - origin ) / texel ) ), ci1 = Math.min( res - 1, Math.ceil( ( x1 + M - origin ) / texel ) );
		const cj0 = Math.max( 0, Math.floor( ( z0 - M - origin ) / texel ) ), cj1 = Math.min( res - 1, Math.ceil( ( z1 + M - origin ) / texel ) );
		const w = ci1 - ci0 + 1, hgt = cj1 - cj0 + 1, n = Math.max( w, hgt );
		const crop = new Float32Array( n * n ), mask = new Float32Array( n * n );
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const gi = Math.min( ci1, ci0 + i ), gj = Math.min( cj1, cj0 + j );
			crop[ j * n + i ] = heights[ gj * res + gi ];
			mask[ j * n + i ] = inside[ gj * res + gi ];

		}

		const smooth = boxBlur2( crop, n, 9 );
		const soft = boxBlur2( mask, n, 6 );
		for ( let j = 0; j < hgt; j ++ ) for ( let i = 0; i < w; i ++ ) {

			const k = ( cj0 + j ) * res + ci0 + i;
			const t = Math.min( 1, soft[ j * n + i ] * 2 );
			heights[ k ] = lerp( heights[ k ], smooth[ j * n + i ] - 1.5, t );

		}

	}

	// Gates: where streets cross the curtain (the street passes under an arch in the wall)
	_gates() {

		this.gates = this.gatesFor( this.wallInfo.line );

	}

	gatesFor( line ) {

		const gates = [];
		for ( const st of OSM.streets ) {

			if ( ! ( st.highway in STREET_HALF ) || st.tunnel ) continue;
			for ( let i = 0; i + 1 < st.pts.length; i ++ ) {

				const hit = segIntersect( st.pts[ i ], st.pts[ i + 1 ], line );
				if ( hit && ! gates.some( ( g ) => Math.hypot( g.x - hit[ 0 ], g.z - hit[ 1 ] ) < 12 ) ) {

					const half = Math.max( 1.4, Math.min( 2.2, STREET_HALF[ st.highway ] ) );
					gates.push( { x: hit[ 0 ], z: hit[ 1 ], y: this.heightAt( hit[ 0 ], hit[ 1 ] ), half, street: st.name || st.highway, highway: st.highway } );

				}

			}

		}

		return gates;

	}

	// Wall-walk height along a wall line (2 m samples): a few metres above the ground just inside, and
	// at least ~8 m above the ground just outside; smoothed along the wall, with the slope kept to what
	// flights of steps can take, and room for an arch over each gate. Returns { pts, length, outward }:
	// pts [{ x, z, s, nx, nz (outward normal), dx, dz (tangent), gi, ge (ground in / out), top }].
	// caps [{ x, z, r, y }]: no higher than y within r (the slope limit eases the wall down to it).
	profile( lineIn, outward, { gates = [], aboveIn = 3.2, aboveOut = 7.5, closed = false, caps = [] } = {} ) {

		const line = resample( lineIn, 2 );
		const pts = [];
		let s = 0;
		const n = line.length;
		for ( let i = 0; i < n; i ++ ) {

			const ia = closed ? ( i - 1 + n ) % n : Math.max( 0, i - 1 ), ib = closed ? ( i + 1 ) % n : Math.min( n - 1, i + 1 );
			const a = line[ ia ], b = line[ ib ];
			let dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ];
			const L = Math.hypot( dx, dz ) || 1;
			dx /= L; dz /= L;
			const nx = dz * outward, nz = - dx * outward; // outward normal
			if ( i > 0 ) s += Math.hypot( line[ i ][ 0 ] - line[ i - 1 ][ 0 ], line[ i ][ 1 ] - line[ i - 1 ][ 1 ] );
			const [ x, z ] = line[ i ];
			let gi = - Infinity;
			for ( const d of [ 4, 7, 10 ] ) gi = Math.max( gi, this.heightAt( x - nx * d, z - nz * d ) );
			const ge = this.heightAt( x + nx * 12, z + nz * 12 );
			pts.push( { x, z, s, nx, nz, dx, dz, gi, ge } );

		}

		// raw top, then a moving average (~16 m) and a slope limit (1 : 2.5)
		const raw = pts.map( ( p ) => {

			let t = Math.max( p.gi + aboveIn, p.ge + aboveOut );
			for ( const g of gates ) {

				const d = Math.hypot( g.x - p.x, g.z - p.z );
				if ( d < 14 ) t = Math.max( t, g.y + 6.4 - Math.max( 0, d - 4 ) * 0.15 );

			}

			return t;

		} );
		const at = ( i ) => raw[ closed ? ( i + n ) % n : clamp( i, 0, n - 1 ) ];
		const sm = raw.map( ( _, i ) => {

			let sum = 0, w = 0;
			for ( let k = - 4; k <= 4; k ++ ) {

				const wk = 1 - Math.abs( k ) / 5;
				sum += at( i + k ) * wk; w += wk;

			}

			return Math.max( sum / w, raw[ i ] - 0.6 );

		} );

		for ( const c of caps ) pts.forEach( ( p, i ) => {

			if ( Math.hypot( p.x - c.x, p.z - c.z ) < c.r ) sm[ i ] = Math.min( sm[ i ], c.y );

		} );
		const maxRise = 2 / 2.5;
		for ( let pass = 0; pass < ( closed ? 2 : 1 ); pass ++ ) {

			for ( let i = 1; i < n; i ++ ) sm[ i ] = Math.min( sm[ i ], sm[ i - 1 ] + maxRise );
			for ( let i = n - 2; i >= 0; i -- ) sm[ i ] = Math.min( sm[ i ], sm[ i + 1 ] + maxRise );

		}

		pts.forEach( ( p, i ) => {

			p.top = sm[ i ];

		} );
		return { pts, length: s, outward, closed };

	}

	_wallProfile() {

		this._gates();
		// Porta da Vila: the walk just clears the gate's arch, and dips 12 m west of it to where the sloping
		// path up from inside the gate meets it
		const pv = this.gates.find( ( g ) => g.street === 'Rua Porta da Vila' );
		const caps = pv ? [ { x: pv.x, z: pv.z, r: 4, y: pv.y + 5.2 }, { x: pv.x - 12, z: pv.z - 1, r: 1.5, y: this.heightAt( pv.x - 2.5, pv.z - 3 ) + 1.5 } ] : [];
		this.wall = this.profile( this.wallInfo.line, this.wallInfo.outward, { gates: this.gates, caps } );

	}

	// wall profile at the point of the curtain nearest (x, z): { p, d, side (+1 outside), t }
	wallNearest( x, z, radius = 40 ) {

		const near = this.wallIndex.nearest( x, z, radius );
		if ( ! near ) return null;
		const { a, b } = near.seg;
		const ex = b[ 0 ] - a[ 0 ], ez = b[ 1 ] - a[ 1 ];
		const cross = ( ez * ( x - a[ 0 ] ) - ex * ( z - a[ 1 ] ) ) * this.wallInfo.outward;
		// profile sample by arc length (2 m spacing)
		const pts = this.wall.pts;
		let best = null, bd = Infinity;
		const cx = a[ 0 ] + ex * near.t, cz = a[ 1 ] + ez * near.t;
		// pts are dense: search near the matching index range
		const guess = this._wallGuess || 0;
		for ( let k = 0; k < pts.length; k ++ ) {

			const q = pts[ ( guess + k ) % pts.length ];
			const dd = ( q.x - cx ) * ( q.x - cx ) + ( q.z - cz ) * ( q.z - cz );
			if ( dd < bd ) {

				bd = dd; best = q;
				if ( dd < 1.1 ) break;

			}

		}

		this._wallGuess = pts.indexOf( best );
		return { p: best, d: near.d, side: cross >= 0 ? 1 : - 1 };

	}

	// pull the ground at the wall's outer foot down: the curtain stands 8-12 m above it, falling back
	// to the natural slope over ~20 m. Gates keep their ramps.
	_shapeWall() {

		const { res, texel, origin, heights } = this;
		const b = this.townBounds;
		const R = 26;
		const i0 = Math.max( 0, Math.floor( ( b.x0 - R - origin ) / texel ) ), i1 = Math.min( res - 1, Math.ceil( ( b.x1 + R - origin ) / texel ) );
		const j0 = Math.max( 0, Math.floor( ( b.z0 - R - origin ) / texel ) ), j1 = Math.min( res - 1, Math.ceil( ( b.z1 + R - origin ) / texel ) );
		const nz = this.noise2;
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			const k = j * res + i;
			if ( this.inside[ k ] ) continue;
			const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
			const w = this.wallNearest( x, z, R );
			if ( ! w ) continue;
			let gateK = 1;
			for ( const g of this.gates ) gateK = Math.min( gateK, smoothstep( 6, 16, Math.hypot( g.x - x, g.z - z ) ) );
			const drop = 9.5 + nz.fbm( w.p.s / 40, 3.7, 2 ) * 3;
			const target = w.p.top - drop;
			const k2 = smoothstep( 1.5, R, w.d );
			const h = heights[ k ];
			const shaped = Math.min( h, lerp( target, h, k2 ) );
			heights[ k ] = lerp( h, shaped, gateK );

		}

	}

	// rasterize a thick polyline: cb( k, t ) with t = 1 on the centre line .. 0 at half + soft
	_stroke( pts, half, soft, cb ) {

		const { res, texel, origin } = this;
		for ( let s = 0; s + 1 < pts.length; s ++ ) {

			const a = pts[ s ], b = pts[ s + 1 ];
			const r = half + soft;
			const i0 = Math.max( 0, Math.floor( ( Math.min( a[ 0 ], b[ 0 ] ) - r - origin ) / texel ) ), i1 = Math.min( res - 1, Math.ceil( ( Math.max( a[ 0 ], b[ 0 ] ) + r - origin ) / texel ) );
			const j0 = Math.max( 0, Math.floor( ( Math.min( a[ 1 ], b[ 1 ] ) - r - origin ) / texel ) ), j1 = Math.min( res - 1, Math.ceil( ( Math.max( a[ 1 ], b[ 1 ] ) + r - origin ) / texel ) );
			for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

				const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
				const [ d ] = segmentDistance( x, z, a, b );
				if ( d < r ) cb( j * res + i, 1 - smoothstep( half, r, d ) );

			}

		}

	}

	_fill( poly, cb ) {

		const { res, texel, origin } = this;
		let z0 = Infinity, z1 = - Infinity;
		for ( const p of poly ) {

			z0 = Math.min( z0, p[ 1 ] ); z1 = Math.max( z1, p[ 1 ] );

		}

		const j0 = Math.max( 0, Math.floor( ( z0 - origin ) / texel ) ), j1 = Math.min( res - 1, Math.ceil( ( z1 - origin ) / texel ) );
		for ( let j = j0; j <= j1; j ++ ) {

			const z = origin + ( j + 0.5 ) * texel;
			const xs = [];
			for ( let a = 0, b = poly.length - 1; a < poly.length; b = a ++ ) {

				const [ xa, za ] = poly[ a ], [ xb, zb ] = poly[ b ];
				if ( ( za > z ) !== ( zb > z ) ) xs.push( xa + ( z - za ) / ( zb - za ) * ( xb - xa ) );

			}

			xs.sort( ( a, b ) => a - b );
			for ( let q = 0; q + 1 < xs.length; q += 2 ) {

				const i0 = Math.max( 0, Math.ceil( ( xs[ q ] - origin ) / texel - 0.5 ) ), i1 = Math.min( res - 1, Math.floor( ( xs[ q + 1 ] - origin ) / texel - 0.5 ) );
				for ( let i = i0; i <= i1; i ++ ) cb( j * res + i );

			}

		}

	}

	_streets() {

		const path = this.path;
		for ( const st of OSM.streets ) {

			const half = STREET_HALF[ st.highway ];
			if ( ! half || st.tunnel ) continue;
			const paved = ! UNPAVED.has( st.surface ) && ! ( ( st.highway === 'track' || st.highway === 'path' ) && ! st.surface );
			const v = paved ? 255 : 130;
			this._stroke( st.pts, half, 0.8, ( k, t ) => {

				const q = Math.round( v * t );
				if ( q > path[ k ] ) path[ k ] = q;

			} );

		}

		// squares (closed pedestrian ways are plazas)
		for ( const st of OSM.streets ) {

			if ( st.highway !== 'pedestrian' || st.pts.length < 4 ) continue;
			const a = st.pts[ 0 ], b = st.pts[ st.pts.length - 1 ];
			if ( a[ 0 ] !== b[ 0 ] || a[ 1 ] !== b[ 1 ] ) continue;
			this._fill( st.pts, ( k ) => {

				path[ k ] = 255;

			} );

		}

	}

	_landcover() {

		const { res, texel, origin, heights, sand, gully, scarp, rock, path } = this;
		const nz = this.noise, nz2 = this.noise2;
		// OSM land use
		const scrubK = new Uint8Array( res * res ), farmK = new Uint8Array( res * res );
		for ( const l of OSM.landuse ) {

			if ( l.pts.length < 4 ) continue;
			const k = l.kind;
			if ( k === 'scrub' || k === 'wood' || k === 'forest' || k === 'heath' ) this._fill( l.pts, ( q ) => {

				scrubK[ q ] = 255;

			} );
			else if ( k === 'farmland' || k === 'meadow' || k === 'orchard' || k === 'grass' || k === 'vineyard' || k === 'village_green' ) this._fill( l.pts, ( q ) => {

				farmK[ q ] = 255;

			} );

		}

		// building coverage, blurred: town ground around the houses outside the walls
		const bcov = new Float32Array( res * res );
		for ( const b of OSM.buildings ) this._fill( b.pts, ( q ) => {

			bcov[ q ] = 1;

		} );
		const blur = boxBlur2( bcov, res, 9 );
		for ( let j = 1; j < res - 1; j ++ ) for ( let i = 1; i < res - 1; i ++ ) {

			const k = j * res + i;
			const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
			const h = heights[ k ];
			const hx = ( heights[ k + 1 ] - heights[ k - 1 ] ) / ( 2 * texel ), hz = ( heights[ k + res ] - heights[ k - res ] ) / ( 2 * texel );
			const slope = Math.sqrt( hx * hx + hz * hz );
			const town = Math.max( scarp[ k ] / 255, smoothstep( 0.08, 0.35, blur[ k ] ) );
			scarp[ k ] = Math.round( town * 255 );
			// scrub on steep uncultivated slopes and in OSM scrub / woods; patches elsewhere
			const patch = nz.fbm( x / 140, z / 140, 3 ) + nz2.noise( x / 35, z / 35 ) * 0.25;
			let scrub = Math.max( scrubK[ k ] / 255, smoothstep( 0.18, 0.4, slope + patch * 0.15 ) );
			scrub = Math.max( scrub, smoothstep( 0.35, 0.55, patch ) * 0.85 );
			scrub *= 1 - town;
			// farmland on the gentler open ground
			let farm = smoothstep( 0.2, 0.08, slope ) * ( 1 - scrub ) * ( 1 - town );
			farm = Math.max( farm, farmK[ k ] / 255 * ( 1 - town ) );
			sand[ k ] = Math.round( clamp( farm, 0, 1 ) * 255 );
			gully[ k ] = Math.round( clamp( scrub * ( 1 - farmK[ k ] / 255 * 0.8 ), 0, 1 ) * 255 );
			// bare limestone on the steepest slopes outside the walls (not under streets)
			const r = smoothstep( 0.55, 0.95, slope + nz2.noise( x / 18, z / 18 ) * 0.25 ) * ( 1 - path[ k ] / 255 ) * ( this.inside[ k ] ? 0 : 1 );
			rock[ k ] = r;

		}

	}

	// ------------------------------------------------------------------ edits / queries

	heightAt( x, z ) {

		const { res, texel, origin, heights } = this;
		const fx = ( x - origin ) / texel - 0.5, fz = ( z - origin ) / texel - 0.5;
		if ( fx < 0 || fz < 0 || fx >= res - 1 || fz >= res - 1 ) return this.dem ? sampleGridLinear( this.dem.far, x, z ) : 0;
		const i = Math.floor( fx ), j = Math.floor( fz );
		const tx = fx - i, tz = fz - j;
		const k = j * res + i;
		const a = heights[ k ], b = heights[ k + 1 ], c = heights[ k + res ], d = heights[ k + res + 1 ];
		return ( a * ( 1 - tx ) + b * tx ) * ( 1 - tz ) + ( c * ( 1 - tx ) + d * tx ) * tz;

	}

	normalAt( x, z, out ) {

		const e = this.texel;
		const hx = this.heightAt( x + e, z ) - this.heightAt( x - e, z );
		const hz = this.heightAt( x, z + e ) - this.heightAt( x, z - e );
		out.set( - hx, 2 * e, - hz ).normalize();
		return out;

	}

	isInsideTown( x, z ) {

		return pointInPolygon( x, z, this.townPoly );

	}

	// min/max pyramid for CDLOD culling bounds
	buildMinMax() {

		const tile = 8; // texels per tile at the finest level
		const n = this.res / tile;
		this.mmTile = tile;
		this.mmN = n;
		const mn0 = new Float32Array( n * n ), mx0 = new Float32Array( n * n );
		const H = this.heights, res = this.res;
		for ( let tj = 0; tj < n; tj ++ ) for ( let ti = 0; ti < n; ti ++ ) {

			let mn = Infinity, mx = - Infinity;
			const jEnd = Math.min( res - 1, ( tj + 1 ) * tile ), iEnd = Math.min( res - 1, ( ti + 1 ) * tile );
			for ( let j = tj * tile; j <= jEnd; j ++ ) {

				const row = j * res;
				for ( let i = ti * tile; i <= iEnd; i ++ ) {

					const h = H[ row + i ];
					if ( h < mn ) mn = h;
					if ( h > mx ) mx = h;

				}

			}

			mn0[ tj * n + ti ] = mn;
			mx0[ tj * n + ti ] = mx;

		}

		this.mmLevels = [ { n, min: mn0, max: mx0 } ];
		let cur = this.mmLevels[ 0 ];
		while ( cur.n > 1 ) {

			const m = cur.n >> 1;
			const mn = new Float32Array( m * m ), mx = new Float32Array( m * m );
			for ( let j = 0; j < m; j ++ ) for ( let i = 0; i < m; i ++ ) {

				const a = ( 2 * j ) * cur.n + 2 * i, b = a + cur.n;
				mn[ j * m + i ] = Math.min( cur.min[ a ], cur.min[ a + 1 ], cur.min[ b ], cur.min[ b + 1 ] );
				mx[ j * m + i ] = Math.max( cur.max[ a ], cur.max[ a + 1 ], cur.max[ b ], cur.max[ b + 1 ] );

			}

			cur = { n: m, min: mn, max: mx };
			this.mmLevels.push( cur );

		}

	}

	boundsFor( x0, z0, x1, z1 ) {

		const { origin, texel, mmTile } = this;
		const span = Math.max( x1 - x0, z1 - z0 ) / ( texel * mmTile );
		const l = Math.max( 0, Math.min( this.mmLevels.length - 1, Math.ceil( Math.log2( Math.max( 1, span / 2 ) ) ) ) );
		const L = this.mmLevels[ l ];
		const ts = texel * mmTile * ( 1 << l );
		const i0 = Math.floor( ( x0 - origin ) / ts ), i1 = Math.floor( ( x1 - origin ) / ts );
		const j0 = Math.floor( ( z0 - origin ) / ts ), j1 = Math.floor( ( z1 - origin ) / ts );
		let mn = Infinity, mx = - Infinity;
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			if ( i < 0 || j < 0 || i >= L.n || j >= L.n ) continue;
			const k = j * L.n + i;
			if ( L.min[ k ] < mn ) mn = L.min[ k ];
			if ( L.max[ k ] > mx ) mx = L.max[ k ];

		}

		if ( mn === Infinity ) {

			mn = 0; mx = 0;

		}

		return [ mn - 1, mx + 2 ];

	}

}

// first crossing of segment p-q with a polyline: [x, z] or null
function segIntersect( p, q, line ) {

	for ( let i = 0; i + 1 < line.length; i ++ ) {

		const a = line[ i ], b = line[ i + 1 ];
		const d = ( q[ 0 ] - p[ 0 ] ) * ( b[ 1 ] - a[ 1 ] ) - ( q[ 1 ] - p[ 1 ] ) * ( b[ 0 ] - a[ 0 ] );
		if ( Math.abs( d ) < 1e-9 ) continue;
		const t = ( ( a[ 0 ] - p[ 0 ] ) * ( b[ 1 ] - a[ 1 ] ) - ( a[ 1 ] - p[ 1 ] ) * ( b[ 0 ] - a[ 0 ] ) ) / d;
		const u = ( ( a[ 0 ] - p[ 0 ] ) * ( q[ 1 ] - p[ 1 ] ) - ( a[ 1 ] - p[ 1 ] ) * ( q[ 0 ] - p[ 0 ] ) ) / d;
		if ( t >= 0 && t <= 1 && u >= 0 && u <= 1 ) return [ p[ 0 ] + ( q[ 0 ] - p[ 0 ] ) * t, p[ 1 ] + ( q[ 1 ] - p[ 1 ] ) * t ];

	}

	return null;

}

// separable box blur of radius r (two passes each way ~ a soft tent)
function boxBlur2( src, n, r ) {

	const tmp = new Float32Array( n * n ), out = new Float32Array( n * n );
	const pass = ( a, b, horizontal ) => {

		const inv = 1 / ( 2 * r + 1 );
		for ( let line = 0; line < n; line ++ ) {

			let acc = 0;
			const at = ( q ) => a[ horizontal ? line * n + clamp( q, 0, n - 1 ) : clamp( q, 0, n - 1 ) * n + line ];
			for ( let q = - r; q <= r; q ++ ) acc += at( q );
			for ( let q = 0; q < n; q ++ ) {

				b[ horizontal ? line * n + q : q * n + line ] = acc * inv;
				acc += at( q + r + 1 ) - at( q - r );

			}

		}

	};

	pass( src, tmp, true );
	pass( tmp, out, false );
	pass( out, tmp, true );
	pass( tmp, out, false );
	return out;

}
