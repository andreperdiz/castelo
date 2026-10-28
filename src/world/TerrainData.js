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
// Heights are the DGT LiDAR terrain model (bare ground, 2 m, from tools/geodata) where it covers the
// town, and elsewhere the Copernicus surface model (10 m grid, bicubic) with small relief added on open
// ground; tools/geodata feathers one into the other. The ground is shaped along the curtain wall: the ground at its outer foot is pulled down
// so the wall stands ~8-12 m above it, as at Óbidos, while inside it is only a few metres above the
// streets. Outside the domain heightAt() falls back to the far DEM grid.
//
// Masks (Uint8 0..255 per texel; TerrainBake packs them into the splat map):
//   sand  -> farmland: open, flat cultivated ground (the shader lays the field patchwork on it)
//   path  -> streets and roads (255 paved: setts, paving stones, asphalt; ~130 unpaved tracks)
//   gully -> scrub and woodland (OSM scrub / wood, steep uncultivated slopes)
//   scarp -> town ground (inside the walls and among the houses outside them)
//   rock  -> bare limestone (Float32 0..1) on the steepest slopes
// the square outside Porta da Vila, between the gate and the houses south of it
// the inside of Porta da Vila's tower, and the passages through its two arches: a level floor of setts
export const PORTA_DA_VILA_TOWER = [ [ - 60.9, 224.9 ], [ - 52.9, 225.4 ], [ - 52.9, 223 ], [ - 49.3, 223 ], [ - 49.3, 226.2 ], [ - 48.4, 226.2 ], [ - 48.6, 234.8 ], [ - 56.7, 234.8 ], [ - 56.7, 236.6 ], [ - 60.3, 236.6 ], [ - 60.3, 234.8 ], [ - 60.9, 234.8 ], [ - 60.9, 224.9 ] ];
// the retaining wall between Rua Porta da Vila and Rua do Cemitério, above it on the right going south
export const CEMITERIO_WALL = [ [ - 57, 249 ], [ - 56.7, 268.2 ], [ - 59.5, 277.9 ], [ - 60.7, 286.7 ], [ - 60.9, 291.8 ], [ - 62.6, 307.1 ], [ - 67.6, 328.9 ], [ - 69.6, 334.9 ], [ - 75.4, 348.4 ], [ - 80.4, 360 ], [ - 83.4, 366.9 ] ];
// the small square just inside Porta da Vila, between Rua Direita (west) and the lane going down to the
// right (east), in front of the house where they part: its corners, the house's side first
export const PV_PRACETA = [ [ - 55, 196.2 ], [ - 47.6, 195.7 ], [ - 49.5, 213.8 ], [ - 51.4, 213.8 ], [ - 53.1, 210 ], [ - 55, 196.2 ] ];
// from the inner arch to the small square's front, where Rua Direita and the lane part, across to the
// house on the right
export const PV_FORK = [ [ - 53.6, 223.2 ], [ - 47.8, 223.6 ], [ - 43.4, 215.4 ], [ - 45, 213.4 ], [ - 52.6, 213.4 ], [ - 53.6, 223.2 ] ];
// the lane on the right of the small square, from its wall to the houses' fronts, down to the crossing
export const PV_LANE = [ [ - 49.3, 213.6 ], [ - 43.2, 215.3 ], [ - 43.5, 211.2 ], [ - 42.5, 208.7 ], [ - 41, 197.9 ], [ - 40.4, 191 ], [ - 47.3, 191 ], [ - 47.2, 195.8 ], [ - 49.3, 213.6 ] ];
export const PORTA_DA_VILA_SQUARE = [ [ - 60.2, 236.4 ], [ - 44, 236.4 ], [ - 44, 252 ], [ - 50, 262 ], [ - 60.2, 262 ], [ - 60.2, 236.4 ] ];
// Rua Dom João de Ornelas, going down from the square outside the gate toward the walls' east side
// (OSM's line, from the square), cobbled: a few steps down off the square, then a slope, with a wall
// holding the square up on its left
export const ORNELAS = [ [ - 46.7, 261.2 ], [ - 42.7, 253 ], [ - 39.1, 245.5 ], [ - 35.7, 234.9 ], [ - 31.4, 221.8 ] ];
// Porta Este, the gate in the east curtain where Travessa do Poço comes out (photo
// references/...-deforaportaeste), and the lane's end at Rua Padre Nunes Tavares
export const PORTA_ESTE = [ 74.9, 48.5 ];
export const TRAVESSA_POCO_END = [ 47.5, 42.1 ];
// Travessa do Beneficiado Faustino das Neves, off the Calçada da Misericórdia across from the top of Porta
// Este's flight (photo references/...-ruaperpendiculara): a narrow alley climbing west in long cobbled steps,
// a house on its left (south), a walled garden's tall wall on its right (north). From its foot to where
// the wall ends; the wall's line
export const BENEFICIADO = { from: [ 39.9, 39.3 ], to: [ 20.6, 41.2 ], wall: [ [ 37.4, 38.2 ], [ 20.6, 40.1 ] ] };
// the Calçada da Misericórdia from the same corner up toward Santa Maria (photo
// references/...-whatsapp-image-2026-10-21-at-10-05-24): an even cobbled climb between the same walled garden
// (west) and a house (east); the garden's east wall, and the house's corner with its faces
export const MISERICORDIA = { from: [ 39.9, 39.3 ], to: [ 29.8, 21.5 ], wall: [ [ 37.4, 38.2 ], [ 32.5, 30.3 ] ], corner: [ 37.8, 33.5 ] };

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
		this._portaDaVilaFloor();
		this._travessaPoco();
		this._beneficiado();
		this._misericordia();
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
		// on a 2 m lattice: the LiDAR detail grid's samples where it covers (it lies on the same lattice),
		// else the bicubic of the 10 m grid; then bilinear to 1 m (smooth either way)
		const C = res / 2 + 1, cs = texel * 2;
		const coarse = new Float32Array( C * C ), lidar = this.lidar = new Float32Array( C * C );
		const d = dem.detail;
		for ( let j = 0; j < C; j ++ ) for ( let i = 0; i < C; i ++ ) {

			const x = origin + i * cs, z = origin + j * cs;
			const di = d ? Math.round( ( x - d.x0 ) / d.step ) : - 1, dj = d ? Math.round( ( z - d.z0 ) / d.step ) : - 1;
			if ( di >= 0 && dj >= 0 && di < d.nx && dj < d.nz ) {

				coarse[ j * C + i ] = d.data[ dj * d.nx + di ];
				lidar[ j * C + i ] = d.w[ dj * d.nx + di ];

			} else coarse[ j * C + i ] = sampleGrid( dem.near, x, z );

		}

		for ( let j = 0; j < res; j ++ ) {

			const z = origin + ( j + 0.5 ) * texel;
			const fz = ( j + 0.5 ) / 2, jz = Math.min( C - 2, Math.floor( fz ) ), tz = fz - jz;
			for ( let i = 0; i < res; i ++ ) {

				const x = origin + ( i + 0.5 ) * texel;
				const fx = ( i + 0.5 ) / 2, ix = Math.min( C - 2, Math.floor( fx ) ), tx = fx - ix;
				const k = jz * C + ix;
				const h = ( coarse[ k ] * ( 1 - tx ) + coarse[ k + 1 ] * tx ) * ( 1 - tz ) + ( coarse[ k + C ] * ( 1 - tx ) + coarse[ k + C + 1 ] * tx ) * tz;
				// gentle undulation where the DSM is smooth at this scale (the LiDAR has the real thing)
				// + a hint of soil roughness
				const r = nz.fbm( x / 60, z / 60, 3 ) * 0.9 * ( 1 - lidar[ k ] ) + nz.noise( x / 7, z / 7 ) * 0.12;
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
		// inside the walls (and just round them) into the ridge's shape, a bit below the raw surface.
		// The LiDAR is the bare ground already, so where it covers, it's left as it is.
		const lidarAt = ( gi, gj ) => this.lidar[ Math.min( res / 2, gj >> 1 ) * ( res / 2 + 1 ) + Math.min( res / 2, gi >> 1 ) ];
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
			const t = Math.min( 1, soft[ j * n + i ] * 2 ) * ( 1 - lidarAt( ci0 + i, cj0 + j ) );
			if ( t > 0 ) heights[ k ] = lerp( heights[ k ], smooth[ j * n + i ] - 1.5, t );

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
		// the floor of Porta da Vila's tower is level (photo references/...-entreportas4) with Rua Direita
		// inside its inner arch; the outer arch (and the square before it) comes down to it
		const pv = this.gates.find( ( g ) => g.street === 'Rua Porta da Vila' );
		if ( pv ) this.pvFloor = pv.y = this.heightAt( - 51.1, 225 );
		// at Porta da Vila the curtain comes down to the gate tower's height, so the steps inside reach it
		const caps = pv ? [ { x: pv.x, z: pv.z, r: 7, y: pv.y + 8 } ] : [];
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
		// the square outside Porta da Vila: level with the gate, back to the natural ground 16-28 m out
		const pv = this.gates.find( ( g ) => g.street === 'Rua Porta da Vila' );
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
			if ( pv ) {

				const d = Math.hypot( pv.x - x, pv.z - z );
				if ( d < 28 ) heights[ k ] = lerp( pv.y, heights[ k ], smoothstep( 16, 28, d ) );

			}

		}

	}

	// Porta da Vila's tower: its floor level with Rua Direita inside. Just inside, between Rua Direita and the
	// lane going down on the right, a small square stands two high steps above the street.
	// Outside, the square is level with the gate, and so is Rua Porta da Vila for its ~150 m south to the
	// road (it only comes up to the far end's ground); Rua do Cemitério climbs away from it on the right
	// and runs on above it, behind a retaining wall.
	_portaDaVilaFloor() {

		const F = this.pvFloor;
		if ( F === undefined ) return;
		const { res, texel, origin, heights } = this;
		const level = ( k ) => {

			heights[ k ] = F;

		};
		this._fill( PORTA_DA_VILA_TOWER, level );
		// the square: level, eased back to the ground around it over 14 m
		const SQ = PORTA_DA_VILA_SQUARE, EASE = 14;
		const xs = SQ.map( ( q ) => q[ 0 ] ), zs = SQ.map( ( q ) => q[ 1 ] );
		for ( let j = Math.floor( ( Math.min( ...zs ) - EASE - origin ) / texel ); j <= Math.ceil( ( Math.max( ...zs ) + EASE - origin ) / texel ); j ++ ) for ( let i = Math.floor( ( Math.min( ...xs ) - EASE - origin ) / texel ); i <= Math.ceil( ( Math.max( ...xs ) + EASE - origin ) / texel ); i ++ ) {

			const k = j * res + i;
			if ( this.inside[ k ] ) continue;
			const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
			let d = 0;
			if ( ! pointInPolygon( x, z, SQ ) ) {

				d = Infinity;
				for ( let e = 0; e + 1 < SQ.length; e ++ ) d = Math.min( d, segmentDistance( x, z, SQ[ e ], SQ[ e + 1 ] )[ 0 ] );

			}

			heights[ k ] = lerp( F, heights[ k ], smoothstep( 0, EASE, d ) );

		}
		// the street from the gate: its pieces joined end to end, then a level band along it
		const pieces = OSM.streets.filter( ( st ) => st.name === 'Rua Porta da Vila' && st.highway === 'residential' ).map( ( st ) => st.pts );
		const road = [ [ - 58, 235 ] ];
		for ( let guard = 0; guard < 8 && pieces.length; guard ++ ) {

			const end = road[ road.length - 1 ];
			const i = pieces.findIndex( ( q ) => Math.hypot( q[ 0 ][ 0 ] - end[ 0 ], q[ 0 ][ 1 ] - end[ 1 ] ) < 2 || Math.hypot( q[ q.length - 1 ][ 0 ] - end[ 0 ], q[ q.length - 1 ][ 1 ] - end[ 1 ] ) < 2 );
			if ( i < 0 ) break;
			const q = pieces.splice( i, 1 )[ 0 ];
			const pts = Math.hypot( q[ 0 ][ 0 ] - end[ 0 ], q[ 0 ][ 1 ] - end[ 1 ] ) < 2 ? q : q.slice().reverse();
			road.push( ...pts.slice( 1 ) );

		}

		if ( road.length > 2 ) {

			const cum = [ 0 ];
			for ( let i = 1; i < road.length; i ++ ) cum.push( cum[ i - 1 ] + Math.hypot( road[ i ][ 0 ] - road[ i - 1 ][ 0 ], road[ i ][ 1 ] - road[ i - 1 ][ 1 ] ) );
			const L = cum[ cum.length - 1 ], far = road[ road.length - 1 ];
			const yEnd = this.heightAt( far[ 0 ], far[ 1 ] );
			const HALF = 4, SOFT = 7;
			const target = new Float32Array( heights.length ).fill( NaN ), weight = new Float32Array( heights.length );
			for ( let i = 0; i + 1 < road.length; i ++ ) this._stroke( [ road[ i ], road[ i + 1 ] ], HALF, SOFT, ( k, t ) => {

				if ( t <= weight[ k ] ) return;
				const x = origin + ( k % res + 0.5 ) * texel, z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
				const [ , u ] = segmentDistance( x, z, road[ i ], road[ i + 1 ] );
				const s = cum[ i ] + u * ( cum[ i + 1 ] - cum[ i ] );
				weight[ k ] = t;
				target[ k ] = lerp( F, yEnd, smoothstep( 0, 1, s / L ) );

			} );
			for ( let k = 0; k < heights.length; k ++ ) if ( weight[ k ] > 0 && ! this.inside[ k ] ) heights[ k ] = lerp( heights[ k ], target[ k ], weight[ k ] );

			// Rua do Cemitério runs beside it on the right, higher, behind a retaining wall: from the fork it
			// ramps up to 2.5 m over the street, then the wall rises slowly to 3.3 m at the far end
			const near = ( line, cl, x, z ) => {

				let best = null;
				for ( let i = 0; i + 1 < line.length; i ++ ) {

					const [ d, u ] = segmentDistance( x, z, line[ i ], line[ i + 1 ] );
					if ( ! best || d < best.d ) best = { d, u, i, s: cl[ i ] + u * ( cl[ i + 1 ] - cl[ i ] ) };

				}

				return best;

			};
			const streetY = ( x, z ) => lerp( F, yEnd, smoothstep( 0, 1, near( road, cum, x, z ).s / L ) );
			const W = CEMITERIO_WALL, cw = [ 0 ];
			for ( let i = 1; i < W.length; i ++ ) cw.push( cw[ i - 1 ] + Math.hypot( W[ i ][ 0 ] - W[ i - 1 ][ 0 ], W[ i ][ 1 ] - W[ i - 1 ][ 1 ] ) );
			const LW = cw[ cw.length - 1 ], RAMP = 21;
			const rise = ( sw ) => sw < RAMP ? 2.5 * sw / RAMP : lerp( 2.5, 3.3, ( sw - RAMP ) / ( LW - RAMP ) );
			// which side is the upper street: the side of Rua do Cemitério
			const sideOf = ( i, x, z ) => Math.sign( ( W[ i + 1 ][ 0 ] - W[ i ][ 0 ] ) * ( z - W[ i ][ 1 ] ) - ( W[ i + 1 ][ 1 ] - W[ i ][ 1 ] ) * ( x - W[ i ][ 0 ] ) );
			const up = sideOf( near( W, cw, - 64, 290 ).i, - 64, 290 );
			const xs = W.map( ( q ) => q[ 0 ] ), zs = W.map( ( q ) => q[ 1 ] ), M = 16;
			for ( let j = Math.floor( ( Math.min( ...zs ) - M - origin ) / texel ); j <= Math.ceil( ( Math.max( ...zs ) + M - origin ) / texel ); j ++ ) for ( let i = Math.floor( ( Math.min( ...xs ) - M - origin ) / texel ); i <= Math.ceil( ( Math.max( ...xs ) + M - origin ) / texel ); i ++ ) {

				const k = j * res + i;
				if ( this.inside[ k ] ) continue;
				const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
				const p = near( W, cw, x, z );
				if ( ( p.i === 0 && p.u <= 0 ) || ( p.i === W.length - 2 && p.u >= 1 ) ) continue; // beyond its ends
				const sd = p.d * ( sideOf( p.i, x, z ) === up ? 1 : - 1 );
				const wx = lerp( W[ p.i ][ 0 ], W[ p.i + 1 ][ 0 ], p.u ), wz = lerp( W[ p.i ][ 1 ], W[ p.i + 1 ][ 1 ], p.u );
				if ( sd > 0 ) heights[ k ] = lerp( heights[ k ], streetY( wx, wz ) + rise( p.s ), 1 - smoothstep( 8, M, sd ) );
				else if ( sd > - 2.5 ) heights[ k ] = streetY( x, z );

			}

			// for Walls: the wall's line, the street's level at its foot and its top (a 0.5 m parapet)
			this.cemiterioWall = W.map( ( q, i ) => {

				const y = streetY( q[ 0 ], q[ 1 ] );
				return { x: q[ 0 ], z: q[ 1 ], low: y, top: y + rise( cw[ i ] ) + 0.5 };

			} );

		}

		// inside the inner arch, level with it as far as the small square's front; the lane on the right,
		// from the square's wall to the houses, goes down from there in one even slope to the crossing
		this._fill( PV_FORK, level );
		const z0 = 213.6, z1 = 191, yC = this.heightAt( - 44.8, z1 );
		this._fill( PV_LANE, ( k ) => {

			const z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
			heights[ k ] = lerp( F, yC, clamp( ( z0 - z ) / ( z0 - z1 ), 0, 1 ) );

		} );

		this._ornelas();

		// the small square inside the inner arch: level, 0.6 m over the street. Walls builds its floor,
		// steps and walls and the stone column; the ground under it is left as it is
		const y = F + 0.6;
		this.praceta = { poly: PV_PRACETA, y };

	}

	// Rua Dom João de Ornelas (ORNELAS): a cars' slope from the square, 1.2 m down by the wall's start, then on
	// down to where it meets the ground again; beside it on its left the square runs on level to a short
	// flight of steps down to the wall's start. this.ornelas tells Walls where the steps and the wall go.
	_ornelas() {

		const F = this.pvFloor, { res, texel, origin, heights } = this;
		const R = ORNELAS, cum = [ 0 ];
		for ( let i = 1; i < R.length; i ++ ) cum.push( cum[ i - 1 ] + Math.hypot( R[ i ][ 0 ] - R[ i - 1 ][ 0 ], R[ i ][ 1 ] - R[ i - 1 ][ 1 ] ) );
		const L = cum[ cum.length - 1 ], end = R[ R.length - 1 ], yEnd = this.heightAt( end[ 0 ], end[ 1 ] );
		const HALF = 2.4, S0 = 0.5, S_W = 8, DROP = 1.2, yW = F - DROP, FLIGHT = 2.25;
		const roadY = ( s ) => s <= S0 ? F : s < S_W ? lerp( F, yW, ( s - S0 ) / ( S_W - S0 ) ) : lerp( yW, yEnd, smoothstep( 0, 1, ( s - S_W ) / ( L - S_W ) ) * 0.4 + 0.6 * ( s - S_W ) / ( L - S_W ) );
		// position, direction (going down) and the left (the square's side) at s along the line
		const at = ( s ) => {

			let i = 0;
			while ( i < R.length - 2 && cum[ i + 1 ] < s ) i ++;
			const a = R[ i ], b = R[ i + 1 ], l = cum[ i + 1 ] - cum[ i ], t = ( s - cum[ i ] ) / l;
			const dx = ( b[ 0 ] - a[ 0 ] ) / l, dz = ( b[ 1 ] - a[ 1 ] ) / l;
			return { x: a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, z: a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, dx, dz, lx: dz, lz: - dx };

		};
		// the wall's road face, a little off the road's left edge, from the steps' top to the house
		const WALL_OFF = HALF + 0.2, WALL_END = 24.8;
		const SOFT = 4;
		this._stroke( R, HALF, SOFT, ( k, t ) => {

			if ( this.inside[ k ] ) return;
			const x = origin + ( k % res + 0.5 ) * texel, z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
			let best = null;
			for ( let i = 0; i + 1 < R.length; i ++ ) {

				const [ d, u ] = segmentDistance( x, z, R[ i ], R[ i + 1 ] );
				if ( ! best || d < best.d ) best = { d, s: cum[ i ] + u * ( cum[ i + 1 ] - cum[ i ] ) };

			}

			const p = at( best.s ), side = ( x - p.x ) * p.lx + ( z - p.z ) * p.lz;
			// on the square's side: the street's level reaches a little under what stands at its edge (the
			// square's kerb, the steps and their side wall, the wall), so the ground doesn't slope out of their
			// faces; the square, level, beyond (Walls paves over the dip behind them)
			if ( side > 0 && best.s < WALL_END ) {

				const low = best.s < S_W - FLIGHT ? HALF + 1 : best.s < S_W ? HALF + 3 : WALL_OFF + 1;
				heights[ k ] = side <= low ? roadY( best.s ) : F;
				return;

			}

			if ( best.s > L - 0.5 ) t *= clamp( ( L + 3 - best.s ) / 3.5, 0, 1 );
			heights[ k ] = lerp( heights[ k ], roadY( best.s ), side > 0 ? 1 : t );

		} );
		this.ornelas = { at, roadY, F, S0, S_W, DROP, FLIGHT, HALF, WALL_OFF, WALL_END, length: L };

	}

	// Travessa do Poço, in through Porta Este (photo references/...-deforaportaeste): two low steps in the
	// passage, a cobbled slope up from the arch, then a broad flight of steps between low whitewashed walls,
	// and on up to Rua Padre Nunes Tavares. s is along the lane from the gate (out < 0 < in); the walking
	// surface is surf( s ). this.portaEste tells Walls where the steps and the walls go.
	_travessaPoco() {

		const g = this.gates.find( ( q ) => Math.hypot( q.x - PORTA_ESTE[ 0 ], q.z - PORTA_ESTE[ 1 ] ) < 3 );
		const w = g && this.wallNearest( g.x, g.z );
		if ( ! w ) return;
		const { res, texel, origin, heights } = this;
		const nx = w.p.nx, nz = w.p.nz; // outward
		const OUT = 6, E = TRAVESSA_POCO_END;
		const line = [ [ g.x + nx * OUT, g.z + nz * OUT ], [ g.x, g.z ], E ];
		const cum = [ 0, OUT, OUT + Math.hypot( E[ 0 ] - g.x, E[ 1 ] - g.z ) ];
		const L = cum[ 2 ] - OUT;
		// position, direction (going in) and the left at s
		const at = ( s ) => {

			const i = s < 0 ? 0 : 1, a = line[ i ], b = line[ i + 1 ], l = cum[ i + 1 ] - cum[ i ], t = ( s + OUT - cum[ i ] ) / l;
			const dx = ( b[ 0 ] - a[ 0 ] ) / l, dz = ( b[ 1 ] - a[ 1 ] ) / l;
			return { x: a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, z: a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, dx, dz, lx: dz, lz: - dx };

		};
		const HALF = 2.0; // the lane between its walls
		const FACE = 1.4; // the curtain's faces from its line (Walls' W / 2)
		const yOut = this.heightAt( g.x + nx * FACE, g.z + nz * FACE ), yEnd = this.heightAt( E[ 0 ], E[ 1 ] );
		// two big steps up to the threshold outside (Walls builds them), then the passage's two low steps
		const OUT_RISE = 0.17, LOW = 0.13, y1 = yOut + 2 * OUT_RISE + LOW, y2 = y1 + LOW, STEP2 = - 0.1; // (the second at the town side's recess)
		// the flight: sixteen steps, most of the way up the lane (photos references/...-entradaportaeste,
		// -escadariaportaeste), a long gentle slope below it
		const SF = 17.2, N = 16, RISE = 0.17, TREAD = 0.42, ST = SF + N * TREAD;
		const yF0 = y2 + 0.11 * ( SF - FACE ), yF1 = yF0 + N * RISE;
		// the walking surface (on the flight, the line of its nosings)
		const surf = ( s ) => s < - FACE ? this.heightAt( at( s ).x, at( s ).z ) : s < STEP2 ? y1 : s < FACE ? y2
			: s < SF ? lerp( y2, yF0, ( s - FACE ) / ( SF - FACE ) ) : s < ST ? lerp( yF0, yF1, ( s - SF ) / ( ST - SF ) )
				: lerp( yF1, yEnd, smoothstep( 0, 1, ( s - ST ) / ( L - ST ) ) * 0.5 + 0.5 * ( s - ST ) / ( L - ST ) );
		// the ground: under the passage's slabs and the flight's blocks a little below them
		const groundY = ( s ) => s < FACE ? surf( s ) - 0.05 : s >= SF && s < ST ? surf( s ) - 0.25 : surf( s );
		const SOFT = 3;
		this._stroke( [ line[ 1 ], E ], HALF, SOFT, ( k, t ) => {

			const x = origin + ( k % res + 0.5 ) * texel, z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
			const out = ( x - g.x ) * nx + ( z - g.z ) * nz;
			if ( out > FACE ) return; // beyond the outer face: the threshold's stroke below
			const [ , u ] = segmentDistance( x, z, line[ 1 ], E );
			const s = out > 0 ? - out : u * L;
			if ( s > L - 0.5 ) t *= clamp( ( L + 3 - s ) / 3.5, 0, 1 );
			heights[ k ] = lerp( heights[ k ], groundY( s ), t );

		} );
		// outside, the ground comes up to the threshold
		this._stroke( [ line[ 0 ], [ g.x + nx * FACE, g.z + nz * FACE ] ], 1.6, 2, ( k, t ) => {

			const x = origin + ( k % res + 0.5 ) * texel, z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
			const d = ( x - g.x ) * nx + ( z - g.z ) * nz;
			heights[ k ] = lerp( heights[ k ], lerp( yOut, heights[ k ], smoothstep( FACE, OUT, d ) ), t );

		} );
		// on the left (south) a raised bed behind the lane's wall, level with its top, the plane trees in it
		// (photo references/...-entradaportaeste). Beside the flight it keeps the slope's grade, so the steps,
		// steeper, catch up with its wall about half way up: the wall ends there, a gap into the bed, then an
		// L-shaped wall level with the flight's top (a balustrade on it) runs up beside the flight's upper half
		// and turns to the house, holding up the street above the bed (marked on a screenshot). The bed falls
		// back to the ground beyond its back.
		const BED = 0.9, BED_W = 6.5, BACK = 2.5, GRADE = 0.11;
		const bedY = ( s ) => y2 + GRADE * ( Math.min( s, ST ) - FACE ) + BED;
		const BED_WALL_END = SF + ( BED + 0.15 ) / ( RISE / TREAD - GRADE ), L_START = BED_WALL_END + 1.0, BED_END = ST;
		const ux = ( E[ 0 ] - g.x ) / L, uz = ( E[ 1 ] - g.z ) / L, lx = uz, lz = - ux;
		const pad = HALF + BED_W + BACK;
		const xs = [ g.x, E[ 0 ], g.x + lx * pad, E[ 0 ] + lx * pad ], zs = [ g.z, E[ 1 ], g.z + lz * pad, E[ 1 ] + lz * pad ];
		const i0 = Math.max( 0, Math.floor( ( Math.min( ...xs ) - origin ) / texel ) ), i1 = Math.min( res - 1, Math.ceil( ( Math.max( ...xs ) - origin ) / texel ) );
		const j0 = Math.max( 0, Math.floor( ( Math.min( ...zs ) - origin ) / texel ) ), j1 = Math.min( res - 1, Math.ceil( ( Math.max( ...zs ) - origin ) / texel ) );
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
			const s = ( x - g.x ) * ux + ( z - g.z ) * uz, d = ( x - g.x ) * lx + ( z - g.z ) * lz;
			if ( s < FACE + 0.2 || s > BED_END + 0.9 || d < HALF + 0.4 || d > HALF + BED_W + BACK ) continue;
			const k = j * res + i;
			// (rising behind the wall, so the 1 m texels don't lift the lane's edge in front of it; up to the
			// L-shaped wall's turn, flat right up to it, the rise to the street above behind it)
			const t = smoothstep( HALF + 0.4, HALF + 1.4, d ) * ( 1 - smoothstep( HALF + BED_W, HALF + BED_W + BACK, d ) ) * ( 1 - smoothstep( BED_END + 0.3, BED_END + 0.9, s ) );
			heights[ k ] = lerp( heights[ k ], bedY( s ), t );

		}

		// the street above the bed, beyond the L-shaped wall's turn: level with the wall's top (the flight's
		// top) a few metres back, then back to the ground
		const LTOP = yF1;
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
			const s = ( x - g.x ) * ux + ( z - g.z ) * uz, d = ( x - g.x ) * lx + ( z - g.z ) * lz;
			if ( s < BED_END + 0.9 || s > BED_END + 6 || d < HALF + 0.4 || d > HALF + BED_W + BACK ) continue;
			const k = j * res + i;
			const t = ( 1 - smoothstep( BED_END + 3, BED_END + 6, s ) ) * ( 1 - smoothstep( HALF + BED_W, HALF + BED_W + BACK, d ) );
			heights[ k ] = lerp( heights[ k ], LTOP - 0.03, t );

		}

		// on the right (north) of the flight a terrace, flat, held up by a tall wall along the flight and
		// across its foot (photo references/...-muroescadariaportaeste); level a little over the flight's
		// top, it falls back to the ground beyond its far sides
		const TERRACE = { s0: SF - 1.4, s1: ST + 1.6, depth: 15, y: yF1 + 0.9 }; // (depth: as far back as the corner wall runs)
		const largo = OSM.streets.find( ( st ) => st.name === 'Largo Doutor João Lourenço' );
		{

			const T0 = TERRACE, dIn = HALF + 0.4, dOut = HALF + T0.depth, FALL = 3;
			const pad2 = dOut + FALL, xs2 = [], zs2 = [];
			for ( const sv of [ T0.s0, T0.s1 + FALL ] ) for ( const dv of [ - dIn, - pad2 ] ) {

				xs2.push( g.x + ux * sv + lx * dv ); zs2.push( g.z + uz * sv + lz * dv );

			}

			const a0 = Math.max( 0, Math.floor( ( Math.min( ...xs2 ) - origin ) / texel ) ), a1 = Math.min( res - 1, Math.ceil( ( Math.max( ...xs2 ) - origin ) / texel ) );
			const b0 = Math.max( 0, Math.floor( ( Math.min( ...zs2 ) - origin ) / texel ) ), b1 = Math.min( res - 1, Math.ceil( ( Math.max( ...zs2 ) - origin ) / texel ) );
			// the square on it (Largo Doutor João Lourenço, OSM), already about level with it: level it too,
			// back from the corner wall's line
			const sq = largo && largo.pts;
			if ( sq ) this._fill( sq, ( k ) => {

				const x = origin + ( k % res + 0.5 ) * texel, z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
				const sv = ( x - g.x ) * ux + ( z - g.z ) * uz, dv = - ( ( x - g.x ) * lx + ( z - g.z ) * lz );
				if ( sv >= T0.s0 + 1.3 && dv >= dIn ) heights[ k ] = T0.y - 0.05;

			} );
			for ( let j = b0; j <= b1; j ++ ) for ( let i = a0; i <= a1; i ++ ) {

				const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
				const sv = ( x - g.x ) * ux + ( z - g.z ) * uz, dv = - ( ( x - g.x ) * lx + ( z - g.z ) * lz );
				if ( sv < T0.s0 + 1.0 || sv > T0.s1 + FALL || dv < dIn || dv > pad2 ) continue;
				if ( sq && pointInPolygon( x, z, sq ) ) continue; // (levelled above)
				// (rising from the walls' inner faces, so the 1 m texels don't spill it out in front of them:
				// a metre in from the corner wall, whose foot outside is far lower; Walls paves a level border
				// along them over the rest of the rise)
				const t = smoothstep( T0.s0 + 1.0, T0.s0 + 1.4, sv ) * smoothstep( dIn, dIn + 0.5, dv )
					* ( 1 - smoothstep( T0.s1, T0.s1 + FALL, sv ) ) * ( 1 - smoothstep( dOut, pad2, dv ) );
				const k = j * res + i;
				heights[ k ] = lerp( heights[ k ], T0.y - 0.05, t );

			}

		}

		// in front of the corner wall the verge: low, a little under the lane's edge and falling gently
		// away from it (photo references/...-muroescadariaportaeste), back to the ground east and north
		{

			const V0 = TERRACE.s0 - 7, V1 = TERRACE.s0 + 1.0, DV = HALF + TERRACE.depth + 1, FALL = 3; // (to under the terrace's border)
			const xs3 = [], zs3 = [];
			for ( const sv of [ V0 - FALL, V1 ] ) for ( const dv of [ - HALF, - ( DV + FALL ) ] ) {

				xs3.push( g.x + ux * sv + lx * dv ); zs3.push( g.z + uz * sv + lz * dv );

			}

			const a0 = Math.max( 0, Math.floor( ( Math.min( ...xs3 ) - origin ) / texel ) ), a1 = Math.min( res - 1, Math.ceil( ( Math.max( ...xs3 ) - origin ) / texel ) );
			const b0 = Math.max( 0, Math.floor( ( Math.min( ...zs3 ) - origin ) / texel ) ), b1 = Math.min( res - 1, Math.ceil( ( Math.max( ...zs3 ) - origin ) / texel ) );
			for ( let j = b0; j <= b1; j ++ ) for ( let i = a0; i <= a1; i ++ ) {

				const x = origin + ( i + 0.5 ) * texel, z = origin + ( j + 0.5 ) * texel;
				const sv = ( x - g.x ) * ux + ( z - g.z ) * uz, dv = - ( ( x - g.x ) * lx + ( z - g.z ) * lz );
				if ( sv < V0 - FALL || sv > V1 - 0.1 || dv < HALF + 0.3 || dv > DV + FALL ) continue;
				const t = smoothstep( V0 - FALL, V0, sv ) * ( 1 - smoothstep( DV, DV + FALL, dv ) ) * smoothstep( HALF + 0.3, HALF + 1.5, dv );
				const k = j * res + i;
				heights[ k ] = lerp( heights[ k ], surf( Math.min( sv, TERRACE.s0 ) ) - 0.05 - 0.06 * ( dv - HALF ), t );

			}

		}

		// the garden in front of the corner wall: from the planter's lane end a low wall runs along the lane
		// to the house, a gateway in it (marked on a screenshot); paved inside. GARDEN: s from the house's
		// face (s0) to the planter's front (s1), d from the wall's line (front) back (back)
		const PLANT0 = 2.6, PLANT_OUT = 1.3;
		const GARDEN = { front: HALF + PLANT0, back: HALF + TERRACE.depth - 3.4, s1: TERRACE.s0 - PLANT_OUT, s0: null, PLANT0, PLANT_OUT };
		for ( let sv = GARDEN.s1 - 0.5; sv > GARDEN.s1 - 16; sv -= 0.1 ) {

			const p = at( sv ), x = p.x - p.lx * ( GARDEN.front + 0.3 ), z = p.z - p.lz * ( GARDEN.front + 0.3 );
			if ( OSM.buildings.some( ( b ) => Math.abs( b.pts[ 0 ][ 0 ] - x ) < 40 && Math.abs( b.pts[ 0 ][ 1 ] - z ) < 40 && pointInPolygon( x, z, b.pts ) ) ) {

				GARDEN.s0 = sv + 0.05;
				break;

			}

		}

		if ( GARDEN.s0 === null ) GARDEN.s0 = GARDEN.s1 - 10;

		// outside, the way up to the gate (photo references/...-acessoportaeste): a cobbled lane from the foot of
		// the threshold's steps down east to the Chafariz Novo, a raised verge of earth and grass along its left
		// (north) side; paved
		const ACCESS = ( () => {

			const S = [ g.x + nx * ( FACE + 1.0 ), g.z + nz * ( FACE + 1.0 ) ], C = [ 104.8, 51.4 ];
			const len = Math.hypot( C[ 0 ] - S[ 0 ], C[ 1 ] - S[ 1 ] ), dir = [ ( C[ 0 ] - S[ 0 ] ) / len, ( C[ 1 ] - S[ 1 ] ) / len ], left = [ dir[ 1 ], - dir[ 0 ] ];
			const yS = yOut, yC = this.heightAt( ...C ), HALF2 = 2.4, VERGE = 1.6;
			// level a little at the steps' foot, then down (steeper in the middle)
			const y = ( t ) => lerp( yS, yC, smoothstep( 0, 1, clamp( ( t - 1.5 ) / ( len - 1.5 ), 0, 1 ) ) * 0.5 + 0.5 * clamp( ( t - 1.5 ) / ( len - 1.5 ), 0, 1 ) );
			// the verge's wall (photo references/...-img-4392): straight from the street lamp's corner to the corner of
			// Casa da Picva (marked on a screenshot), its top level, stepping down part way along; behind it a small
			// parking yard level with its higher part, then a garden bed under its lower part. u along it from P0,
			// v back from it (north, away from the lane)
			const P0 = [ 83.2, 46.55 ], P1 = [ 98.5, 46.15 ], WLen = Math.hypot( P1[ 0 ] - P0[ 0 ], P1[ 1 ] - P0[ 1 ] );
			const w = [ ( P1[ 0 ] - P0[ 0 ] ) / WLen, ( P1[ 1 ] - P0[ 1 ] ) / WLen ], n = [ w[ 1 ], - w[ 0 ] ];
			const tOf = ( P ) => ( P[ 0 ] - S[ 0 ] ) * dir[ 0 ] + ( P[ 1 ] - S[ 1 ] ) * dir[ 1 ];
			const point = ( u, v = 0 ) => [ P0[ 0 ] + w[ 0 ] * u + n[ 0 ] * v, P0[ 1 ] + w[ 1 ] * u + n[ 1 ] * v ];
			const ground = ( u ) => y( tOf( point( u, - 0.3 ) ) ) + 0.35;
			const uS = 0.4 * WLen, topA = ground( 0 ) + 1.15, topB = topA - 0.48;
			const WALL = { P0, P1, length: WLen, w, n, point, ground, uS, topA, topB, yard: topA - 1.0, bed: topB - 0.25, depth: 6,
				uv: ( x, z ) => [ ( x - P0[ 0 ] ) * w[ 0 ] + ( z - P0[ 1 ] ) * w[ 1 ], ( x - P0[ 0 ] ) * n[ 0 ] + ( z - P0[ 1 ] ) * n[ 1 ] ] };
			return { S, C, len, dir, left, y, HALF: HALF2, VERGE, WALL };

		} )();
		{

			const A = ACCESS, R = A.HALF + A.VERGE + A.WALL.depth + 0.5;
			this._stroke( [ A.S, A.C ], R, 0, ( k ) => {

				const x = origin + ( k % res + 0.5 ) * texel, z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
				const t = ( x - A.S[ 0 ] ) * A.dir[ 0 ] + ( z - A.S[ 1 ] ) * A.dir[ 1 ], d = ( x - A.S[ 0 ] ) * A.left[ 0 ] + ( z - A.S[ 1 ] ) * A.left[ 1 ];
				if ( t < 0 || t > A.len ) return;
				const yl = A.y( t ), W = A.WALL, [ wu, wv ] = W.uv( x, z );
				if ( wu > 0.3 && wu < W.length - 0.2 && wv > 1.6 && wv < W.depth ) {

					// behind the wall: the yard, level, paved; the garden bed (from a little way back, so the 1 m
					// texels don't lift the verge in front of the wall; Walls covers the strip behind it)
					heights[ k ] = wu < W.uS ? W.yard : W.bed;
					if ( wu < W.uS ) {

						this.path[ k ] = 255;
						this.scarp[ k ] = 255;

					}

				} else if ( Math.abs( d ) <= A.HALF ) {

					heights[ k ] = yl;
					this.path[ k ] = 255;
					this.scarp[ k ] = 255;

				} else if ( d > 0 && d <= A.HALF + A.VERGE ) heights[ k ] = yl + 0.35 * smoothstep( A.HALF, A.HALF + 0.8, d );

				else {

					// back to the ground beyond (the verge's back on the left, the houses on the right)
					const e = d > 0 ? d - A.HALF - A.VERGE : - d - A.HALF;
					heights[ k ] = lerp( yl + ( d > 0 ? 0.35 : 0 ), heights[ k ], smoothstep( 0, 1.5, e ) );

				}

			} );

		}

		g.y = y1;
		// the lane's frame: s along it from the gate, d across (left +)
		const frame = ( x, z ) => [ ( x - g.x ) * ux + ( z - g.z ) * uz, ( x - g.x ) * lx + ( z - g.z ) * lz ];
		this.portaEste = { gate: g, at, surf, frame, largo, HALF, FACE, STEP2, yOut, OUT_RISE, y1, y2, SF, ST, N, RISE, TREAD, BED, bedY, BED_WALL_END, L_START, LTOP, TERRACE, GARDEN, ACCESS, length: L };

	}

	// Travessa do Beneficiado (BENEFICIADO): an even climb from the Calçada to the wall's end, paved; Walls lays
	// the steps' stone edges on it. this.beneficiado tells Walls where.
	_beneficiado() {

		const B = BENEFICIADO, { res, texel, origin, heights } = this;
		const L = Math.hypot( B.to[ 0 ] - B.from[ 0 ], B.to[ 1 ] - B.from[ 1 ] );
		const dir = [ ( B.to[ 0 ] - B.from[ 0 ] ) / L, ( B.to[ 1 ] - B.from[ 1 ] ) / L ];
		const y0 = this.heightAt( ...B.from ), y1 = this.heightAt( ...B.to );
		const y = ( t ) => lerp( y0, y1, clamp( t / L, 0, 1 ) );
		const HALF = 1.5;
		this._stroke( [ B.from, B.to ], HALF, 1.0, ( k, w ) => {

			const x = origin + ( k % res + 0.5 ) * texel, z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
			const t = ( x - B.from[ 0 ] ) * dir[ 0 ] + ( z - B.from[ 1 ] ) * dir[ 1 ];
			heights[ k ] = lerp( heights[ k ], y( t ), w );
			if ( w > 0.5 ) {

				this.path[ k ] = 255;
				this.scarp[ k ] = 255;

			}

		} );
		this.beneficiado = { from: B.from, to: B.to, wall: B.wall, dir, length: L, y, HALF };

	}

	// the Calçada da Misericórdia (MISERICORDIA): an even climb, paved. this.misericordia tells Walls where.
	_misericordia() {

		const M = MISERICORDIA, { res, texel, origin, heights } = this;
		const L = Math.hypot( M.to[ 0 ] - M.from[ 0 ], M.to[ 1 ] - M.from[ 1 ] );
		const dir = [ ( M.to[ 0 ] - M.from[ 0 ] ) / L, ( M.to[ 1 ] - M.from[ 1 ] ) / L ];
		const y0 = this.heightAt( ...M.from ), y1 = this.heightAt( ...M.to );
		const y = ( t ) => lerp( y0, y1, clamp( t / L, 0, 1 ) );
		this._stroke( [ M.from, M.to ], 1.8, 1.2, ( k, w ) => {

			const x = origin + ( k % res + 0.5 ) * texel, z = origin + ( Math.floor( k / res ) + 0.5 ) * texel;
			const t = ( x - M.from[ 0 ] ) * dir[ 0 ] + ( z - M.from[ 1 ] ) * dir[ 1 ];
			heights[ k ] = lerp( heights[ k ], y( t ), w );
			if ( w > 0.5 ) {

				this.path[ k ] = 255;
				this.scarp[ k ] = 255;

			}

		} );
		// the house's corner, where Town puts it (it pushes footprint corners 1.5 m back from a lane's centre
		// line), and its faces from there: up the street, and along Travessa do Poço's line
		const [ dc, tc ] = segmentDistance( M.corner[ 0 ], M.corner[ 1 ], M.from, M.to );
		const foot = [ M.from[ 0 ] + ( M.to[ 0 ] - M.from[ 0 ] ) * tc, M.from[ 1 ] + ( M.to[ 1 ] - M.from[ 1 ] ) * tc ];
		const corner = dc >= 1.5 ? M.corner : [ foot[ 0 ] + ( M.corner[ 0 ] - foot[ 0 ] ) / dc * 1.5, foot[ 1 ] + ( M.corner[ 1 ] - foot[ 1 ] ) / dc * 1.5 ];
		const f = ( P ) => {

			const l = Math.hypot( P[ 0 ] - corner[ 0 ], P[ 1 ] - corner[ 1 ] );
			return [ ( P[ 0 ] - corner[ 0 ] ) / l, ( P[ 1 ] - corner[ 1 ] ) / l ];

		};
		this.misericordia = { from: M.from, to: M.to, wall: M.wall, corner, cornerFaces: [ f( [ 32.1, 20.2 ] ), f( [ 48.7, 35.8 ] ) ], dir, length: L, y };

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
			if ( ! half || ( st.tunnel && st.tunnel !== 'building_passage' ) ) continue; // (paved under the buildings it passes)
			const paved = ! UNPAVED.has( st.surface ) && ! ( ( st.highway === 'track' || st.highway === 'path' ) && ! st.surface );
			const v = paved ? 255 : 130;
			this._stroke( st.pts, half, 0.8, ( k, t ) => {

				const q = Math.round( v * t );
				if ( q > path[ k ] ) path[ k ] = q;

			} );

		}

		// the square outside Porta da Vila, the floor of its tower and the small square inside: setts (town ground + paved), as in the photos
		for ( const poly of [ PORTA_DA_VILA_SQUARE, PORTA_DA_VILA_TOWER, PV_FORK, PV_LANE ] ) this._fill( poly, ( k ) => {

			path[ k ] = 255;
			this.scarp[ k ] = 255;

		} );
		this._stroke( ORNELAS, 2.6, 0.6, ( k, t ) => {

			if ( t < 0.5 ) return;
			path[ k ] = 255;
			this.scarp[ k ] = 255;

		} );

		// squares (closed pedestrian ways are plazas)
		for ( const st of OSM.streets ) {

			if ( st.highway !== 'pedestrian' || st.pts.length < 4 ) continue;
			const a = st.pts[ 0 ], b = st.pts[ st.pts.length - 1 ];
			if ( a[ 0 ] !== b[ 0 ] || a[ 1 ] !== b[ 1 ] ) continue;
			this._fill( st.pts, ( k ) => {

				path[ k ] = 255;

			} );

		}

		// by Porta Este the square is the terrace the corner wall holds up: paved over the terrace, and not
		// in front of the corner wall (the earth verge there)
		const pe = this.portaEste;
		if ( pe ) {

			const { res, texel, origin } = this, TR = pe.TERRACE, H = pe.HALF;
			const at = ( k ) => pe.frame( origin + ( k % res + 0.5 ) * texel, origin + ( Math.floor( k / res ) + 0.5 ) * texel );
			// (its outline is stroked like a street too: off within that stroke's reach of it)
			if ( pe.largo ) this._stroke( pe.largo.pts, STREET_HALF.pedestrian + 0.8, 0, ( k ) => {

				const [ s, d ] = at( k );
				if ( s < TR.s0 && - d > H + 0.2 ) path[ k ] = 0;

			} );
			if ( pe.largo ) this._fill( pe.largo.pts, ( k ) => {

				const [ s, d ] = at( k );
				if ( s < TR.s0 && - d > H + 0.2 ) path[ k ] = 0;

			} );
			const c = [ [ TR.s0, H ], [ TR.s1, H ], [ TR.s1, H + TR.depth ], [ TR.s0, H + TR.depth ] ].map( ( [ s, d ] ) => {

				const p = pe.at( s );
				return [ p.x - p.lx * d, p.z - p.lz * d ];

			} );
			this._fill( c, ( k ) => {

				path[ k ] = 255;
				this.scarp[ k ] = 255;

			} );
			// and the garden in front of the corner wall
			const G = pe.GARDEN, gc = [ [ G.s0, G.front + 0.4 ], [ G.s1, G.front + 0.4 ], [ G.s1, G.back ], [ G.s0, G.back ] ].map( ( [ s, d ] ) => {

				const p = pe.at( s );
				return [ p.x - p.lx * d, p.z - p.lz * d ];

			} );
			this._fill( gc, ( k ) => {

				path[ k ] = 255;
				this.scarp[ k ] = 255;

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
