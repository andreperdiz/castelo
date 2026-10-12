import { Group, Mesh, Vector3 } from '../../engine/index.js';
import { MeshKit } from './MeshKit.js';
import { OSM, resample, pointInPolygon, polygonArea, SegmentIndex } from './Geo.js';

// The walls of Óbidos: the curtain round the town, the castle's own enclosure, the towers and the
// gates, with a walkable wall walk all the way round.
//
// Cross-section (metres from the wall line, + = outward):
//   -1.4 .. +0.75  the wall walk (no railing on the town side: you can step off into the street)
//   +0.75 .. +1.4  the parapet, 0.95 m above the walk, with merlons 0.8 m higher (crenels to look through)
// The walk follows the profile from TerrainData.profile(), cut into level treads so that slopes become
// flights of steps (rise STEP_RISE). Each 0.6 m piece is one walkable collider (the walk) plus one solid
// one (the parapet and merlons, tall enough that you can't climb over). Gates leave an arched passage
// under the walk. Flights of stone steps against the inner face lead up from the streets.
const W = 2.8;
const PARAPET_IN = 0.75; // parapet inner face
const PARAPET_H = 0.95;
const MERLON_H = 0.8;
const MERLON_W = 1.1;
const MERLON_PITCH = 1.85;
const PIECE = 0.6;
const STEP_RISE = 0.18;
const FOOT = 2.0; // the faces go this far below the ground
// Porta da Vila's town and west walls (after OSM way 475653576): east end, inner arch, corner, curtain
const PORTA_DA_VILA = [ [ - 44, 225.7 ], [ - 51.1, 225 ], [ - 61.2, 223.9 ], [ - 61.8, 233.3 ] ];

export class Walls {

	constructor( { scene, terrain, colliders, materials } ) {

		this.terrain = terrain;
		this.colliders = colliders;
		this.group = new Group();
		this.group.name = 'Walls';
		this.kit = new MeshKit();
		this.kit.color = [ 1, 1, 1 ];
		this.stairs = [];
		this.towerTops = [];
		this.walkLines = [];
		this.buildingIndex = new SegmentIndex( OSM.buildings.map( ( b ) => b.pts ), 12 );

		// Porta da Vila's outer arch is narrower than the street, so it clears the tower's west wall, and
		// springs a little lower, to stay under the walk where it comes down toward the steps inside
		const portaDaVila = terrain.gates.find( ( g ) => g.street === 'Rua Porta da Vila' );
		if ( portaDaVila ) Object.assign( portaDaVila, { half: 1.7, spring: 2.0 } );
		// the curtain round the town
		this.curtain = this._wallLine( terrain.wall, terrain.gates, 0.37 );
		if ( portaDaVila ) this._portaDaVila( portaDaVila );
		// the castle enclosure (Paço dos Alcaides): its own closed loop
		const castle = OSM.walls.find( ( w ) => w.name && /Castelo/.test( w.name ) );
		if ( castle ) {

			const poly = castle.pts.slice( 0, - 1 );
			const outward = polygonArea( poly ) > 0 ? - 1 : 1;
			// which way is out: test a point off the first segment
			const sgn = this._outwardSign( poly );
			const loop = poly.concat( [ poly[ 0 ] ] );
			const gates = terrain.gatesFor( loop );
			const prof = terrain.profile( loop, sgn ?? outward, { gates, aboveIn: 3.5, aboveOut: 6.5, closed: false } );
			this.castle = this._wallLine( prof, gates, 0.61 );
			this.castleGates = gates;

		}

		// the short extra stretches (the barbican and the bits by the castle gate)
		for ( const w of OSM.walls ) {

			if ( w.pts.length < 2 || w.closed || w.id === 1276266197 || w.id === 475653576 ) continue;
			const prof = terrain.profile( w.pts, 1, { aboveIn: 2.5, aboveOut: 5 } );
			this._wallLine( prof, [], 0.83, { parapetBoth: true } );

		}

		this._towers();
		this._stairs();
		this._portaDaVilaStairs();

		const mesh = new Mesh( this.kit.build(), materials.stone );
		mesh.name = 'walls';
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.staticVelocity = true;
		this.group.add( mesh );
		this.mesh = mesh;
		scene.add( this.group );

	}

	// Porta da Vila is a gate tower open to the sky. The curtain makes its outer (south) and east sides,
	// with the outer arch to the left as you come in; these are its town (north) and west sides, after
	// OSM way 475653576, with the inner arch to the right, so the way through crosses the tower on a
	// diagonal.
	_portaDaVila( outerGate ) {

		const T = this.terrain;
		// the west wall stops at the curtain walk's town edge, so its walk runs straight onto the curtain's
		const pts = PORTA_DA_VILA;
		const inner = { x: - 51.1, z: 225, y: T.heightAt( - 51.1, 225 ), half: 1.6, street: 'Rua da Porta da Vila', highway: 'pedestrian' };
		// outward + 1: into the tower, so the parapet guards the drop into it and the town side is open
		// to the steps below
		const prof = T.profile( pts, 1, { gates: [ inner, outerGate ], aboveIn: 3, aboveOut: 3 } );
		// the tower's walls stand level with the curtain's walk where they join it
		const end = this._nearestWalk( pts[ 3 ][ 0 ], pts[ 3 ][ 1 ] + 1, 4 );
		if ( end ) for ( const p of prof.pts ) p.top = end.p.y;
		this.portaDaVila = this._wallLine( prof, [ inner ], 0.37 );
		this.portaDaVila.gates = [ outerGate, inner ];

	}

	// The way up onto the walls at Porta da Vila (OSM way 314791407). A metre past the inner arch, on
	// the left, a broad flight of deep, low steps runs along the tower's town wall, turns left at the
	// corner and runs along its west wall; a few metres short of the curtain it becomes a sloping path,
	// which turns right along the curtain's town face and rises until it is level with the walk.
	_portaDaVilaStairs() {

		if ( ! this.portaDaVila ) return;
		const T = this.terrain, kit = this.kit;
		const width = 3, tread = 1.6, off = W / 2 + width / 2 + 0.02;
		// a centre line beside a wall line a -> b, on side s (+ 1: to the left of a -> b on the map)
		const beside = ( a, b, s ) => {

			const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ], L = Math.hypot( dx, dz );
			const nx = - dz / L * s, nz = dx / L * s;
			return { a: [ a[ 0 ] + nx * off, a[ 1 ] + nz * off ], dx: dx / L, dz: dz / L };

		};
		const meet = ( l, m ) => {

			const k = ( ( m.a[ 0 ] - l.a[ 0 ] ) * m.dz - ( m.a[ 1 ] - l.a[ 1 ] ) * m.dx ) / ( l.dx * m.dz - l.dz * m.dx );
			return [ l.a[ 0 ] + l.dx * k, l.a[ 1 ] + l.dz * k ];

		};
		const at = ( p, l, d ) => [ p[ 0 ] + l.dx * d, p[ 1 ] + l.dz * d ];
		const [ , a, b, c ] = PORTA_DA_VILA;
		const north = beside( b, a, - 1 ), west = beside( c, b, - 1 ); // both running toward the corner from below
		const curtain = beside( [ - 60.8, 234.7 ], [ - 72, 233.7 ], 1 ); // the curtain west of the tower, westward
		const corner = meet( north, west );
		const turn = meet( west, curtain );
		const startX = - 53.7, stepsEndZ = turn[ 1 ] - 5; // a metre past the arch; 5 m before the right turn

		const steps = [];
		let y = - Infinity;
		const put = ( p, l, len, rise ) => {

			const g = T.heightAt( p[ 0 ], p[ 1 ] );
			const ahead = T.heightAt( p[ 0 ] + l.dx * len / 2, p[ 1 ] + l.dz * len / 2 );
			y = y === - Infinity ? ahead + 0.15 : Math.min( y + rise[ 1 ], Math.max( y + rise[ 0 ], ahead + 0.15 ) );
			steps.push( { x: p[ 0 ], z: p[ 1 ], y, g: Math.min( g, ahead ), yaw: Math.atan2( - l.dz, l.dx ), len } );

		};
		// deep, low steps: each a little above the ground at its far edge
		const flight = ( from, l, length, rise ) => {

			const n = Math.max( 1, Math.round( length / tread ) ), len = length / n;
			for ( let i = 0; i < n; i ++ ) put( at( from, l, len * ( i + 0.5 ) ), l, len, rise );

		};
		const up = { dx: - north.dx, dz: - north.dz }; // north leg, walking up (west)
		const dStart = ( startX - corner[ 0 ] ) / north.dx;
		flight( at( corner, north, dStart ), up, dStart - width / 2, [ 0.1, 0.38 ] );
		put( corner, { dx: - west.dx, dz: - west.dz }, width, [ 0.1, 0.38 ] ); // the landing
		const wUp = { dx: - west.dx, dz: - west.dz };
		const wLen = ( stepsEndZ - corner[ 1 ] ) / wUp.dz - width / 2;
		flight( at( corner, wUp, width / 2 ), wUp, wLen, [ 0.1, 0.38 ] );
		// the sloping path (fine treads, 1 in 5, then 1 in 4 along the curtain), to the turn and then along
		// the curtain until level with its walk
		const RUN = 0.3;
		const walkAt = ( p ) => ( this._nearestWalk( p[ 0 ] + curtain.dz * off, p[ 1 ] - curtain.dx * off, 3 ) || { p: { y: Infinity } } ).p.y;
		const ramp = [ { p: at( corner, wUp, width / 2 + wLen ), l: wUp, len: ( turn[ 1 ] - stepsEndZ ) / wUp.dz - width / 2 }, { p: at( turn, curtain, width / 2 ), l: curtain, len: 30 } ];
		let level = false;
		for ( const r of ramp ) {

			for ( let d = RUN / 2; d < r.len && ! level; d += RUN ) {

				const p = at( r.p, r.l, d );
				const slope = RUN / ( r.l === curtain ? 4 : 5 );
				put( p, r.l, RUN, [ slope, slope + 0.05 ] );
				if ( r.l === curtain && y >= walkAt( p ) - 0.3 ) level = true; // a kerb-high step up onto it

			}

			if ( r.l === wUp ) put( turn, curtain, width, [ 0.06, 0.1 ] ); // a landing at the turn

		}

		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 1, 0.98, 0.95 ];
		for ( const st of steps ) {

			const bottom = st.g - 0.6, h = st.y - bottom;
			kit.box( st.x, bottom + h / 2, st.z, st.len + 0.02, h, width, st.yaw, 'bottom' );
			this.colliders.addBox( new Vector3( st.x, bottom + h / 2, st.z ), new Vector3( st.len / 2 + 0.01, h / 2, width / 2 ), st.yaw, { walkable: true, tag: 'stair' } );

		}

		steps.reverse(); // top first, like the other flights
		// clear: houses keep this far from the flight's centre line (about 1.8 m of street beside it)
		this.stairs.push( { x: steps[ 0 ].x, z: steps[ 0 ].z, top: steps[ 0 ].y, bottom: steps[ steps.length - 1 ], n: steps.length, steps: steps.map( ( st ) => ( { x: st.x, z: st.z, y: st.y } ) ), clear: width / 2 + 1.8, level } );

	}

	_outwardSign( poly ) {

		let votes = 0;
		for ( let i = 0; i + 1 < poly.length; i ++ ) {

			const a = poly[ i ], b = poly[ i + 1 ];
			const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ], L = Math.hypot( dx, dz );
			if ( L < 1 ) continue;
			const mx = ( a[ 0 ] + b[ 0 ] ) / 2 + dz / L * 2, mz = ( a[ 1 ] + b[ 1 ] ) / 2 - dx / L * 2;
			votes += pointInPolygon( mx, mz, poly ) ? - 1 : 1;

		}

		return votes >= 0 ? 1 : - 1;

	}

	// Build one wall from a profile ({ pts, outward } at 2 m): resample to PIECE, step the walk, emit
	// the faces, merlons and colliders. Returns the pieces (for stairs / towers).
	_wallLine( profile, gates, seed, { parapetBoth = false } = {} ) {

		const P = profile.pts;
		if ( P.length < 2 ) return null;
		// resample positions at PIECE; interpolate top and normal from the 2 m profile by arc length
		const line = resample( P.map( ( p ) => [ p.x, p.z ] ), PIECE );
		const samples = [];
		let j = 0, s = 0;
		for ( let i = 0; i < line.length; i ++ ) {

			if ( i > 0 ) s += Math.hypot( line[ i ][ 0 ] - line[ i - 1 ][ 0 ], line[ i ][ 1 ] - line[ i - 1 ][ 1 ] );
			while ( j < P.length - 2 && P[ j + 1 ].s < s ) j ++;
			const a = P[ j ], b = P[ j + 1 ];
			const t = Math.max( 0, Math.min( 1, ( s - a.s ) / ( ( b.s - a.s ) || 1 ) ) );
			let nx = a.nx + ( b.nx - a.nx ) * t, nz = a.nz + ( b.nz - a.nz ) * t;
			const nl = Math.hypot( nx, nz ) || 1;
			nx /= nl; nz /= nl;
			const top = a.top + ( b.top - a.top ) * t;
			samples.push( { x: line[ i ][ 0 ], z: line[ i ][ 1 ], s, nx, nz, tx: - nz * profile.outward, tz: nx * profile.outward, top } );

		}

		const n = samples.length;
		// level treads
		for ( const p of samples ) p.y = Math.round( p.top / STEP_RISE ) * STEP_RISE;
		// cross-sections at the piece boundaries (mid-points between samples)
		const off = ( p, d ) => [ p.x + p.nx * d, p.z + p.nz * d ];
		const edge = [];
		for ( let k = 0; k <= n; k ++ ) {

			const a = samples[ Math.max( 0, k - 1 ) ], b = samples[ Math.min( n - 1, k ) ];
			const m = { x: ( a.x + b.x ) / 2, z: ( a.z + b.z ) / 2, nx: ( a.nx + b.nx ) / 2, nz: ( a.nz + b.nz ) / 2 };
			const l = Math.hypot( m.nx, m.nz ) || 1;
			m.nx /= l; m.nz /= l;
			edge.push( m );

		}

		// gate passages: the pieces over a gate
		for ( const p of samples ) {

			p.gate = null;
			for ( const g of gates ) {

				const along = Math.abs( ( p.x - g.x ) * p.tx + ( p.z - g.z ) * p.tz );
				const d = Math.hypot( p.x - g.x, p.z - g.z );
				if ( d < g.half + 0.3 && along < g.half + 0.3 ) p.gate = g;

			}

		}
		// round arch over each passage: its radius reaches the jambs (the outermost piece edges), and the
		// crown stays about 4.2 m above the street unless the arch is too wide for that
		const arcR = new Map();
		for ( let i = 0; i < n; i ++ ) {

			const g = samples[ i ].gate;
			if ( ! g ) continue;
			const p = samples[ i ];
			for ( const e of [ edge[ i ], edge[ i + 1 ] ] ) arcR.set( g, Math.max( arcR.get( g ) || 0, Math.abs( ( e.x - g.x ) * p.tx + ( e.z - g.z ) * p.tz ) ) );

		}

		const archY = ( g, p, x, z ) => {

			const R = arcR.get( g ), a = ( x - g.x ) * p.tx + ( z - g.z ) * p.tz;
			return g.y + ( g.spring ?? Math.max( 2.4, 4.2 - R ) ) + Math.sqrt( Math.max( 0, R * R - a * a ) );

		};

		const T = this.terrain;
		const kit = this.kit;
		const ground = ( xz ) => T.heightAt( xz[ 0 ], xz[ 1 ] );
		const inner = - W / 2, outer = W / 2;
		const pIn = parapetBoth ? - PARAPET_IN : inner;
		kit.vdata = [ seed, 0.8, 0, 0 ];
		let u = 0;
		for ( let i = 0; i < n; i ++ ) {

			const p = samples[ i ];
			const A = edge[ i ], B = edge[ i + 1 ];
			const y = p.y;
			const len = Math.hypot( B.x - A.x, B.z - A.z );
			if ( len < 1e-3 ) continue;
			const up = [ 0, 1, 0 ];
			const outN = [ p.nx, 0, p.nz ], inN = [ - p.nx, 0, - p.nz ];
			const IA = off( A, inner ), IB = off( B, inner ), PA = off( A, PARAPET_IN ), PB = off( B, PARAPET_IN );
			const OA = off( A, outer ), OB = off( B, outer );
			const gate = p.gate;
			// soffit of the passage, sampled in slices across the piece so the arch reads as a curve
			const SUB = 4;
			const arch = gate ? Array.from( { length: SUB + 1 }, ( _, k ) => {

				const t = k / SUB, m = { x: A.x + ( B.x - A.x ) * t, z: A.z + ( B.z - A.z ) * t, nx: A.nx + ( B.nx - A.nx ) * t, nz: A.nz + ( B.nz - A.nz ) * t };
				return { t, m, y: archY( gate, p, m.x, m.z ) };

			} ) : null;
			const yg = gate ? Math.min( arch[ 0 ].y, arch[ SUB ].y ) : null;
			// a face from the arch up to yTop, at offset d from the wall line
			const archFace = ( d, yTop, N, u0 ) => {

				for ( let k = 0; k < SUB; k ++ ) {

					const a = arch[ k ], b = arch[ k + 1 ], qa = off( a.m, d ), qb = off( b.m, d );
					const ua = u0 + len * a.t, ub = u0 + len * b.t;
					kit.quadFacing( [ qa[ 0 ], a.y, qa[ 1 ] ], [ qb[ 0 ], b.y, qb[ 1 ] ], [ qb[ 0 ], yTop, qb[ 1 ] ], [ qa[ 0 ], yTop, qa[ 1 ] ], N,
						[ [ ua, a.y ], [ ub, b.y ], [ ub, yTop ], [ ua, yTop ] ] );

				}

			};
			const tone = 0.92 + 0.08 * Math.sin( p.s * 0.05 + seed * 9 );
			kit.color = [ tone, tone * 0.99, tone * 0.97 ];

			// walk
			kit.quadFacing( [ IA[ 0 ], y, IA[ 1 ] ], [ IB[ 0 ], y, IB[ 1 ] ], [ PB[ 0 ], y, PB[ 1 ] ], [ PA[ 0 ], y, PA[ 1 ] ], up,
				[ [ u, 0 ], [ u + len, 0 ], [ u + len, W / 2 + PARAPET_IN ], [ u, W / 2 + PARAPET_IN ] ] );
			// inner face
			const gIn = Math.min( ground( IA ), ground( IB ) ) - FOOT;
			if ( gate ) archFace( inner, y, inN, u );
			else kit.quadFacing( [ IA[ 0 ], gIn, IA[ 1 ] ], [ IB[ 0 ], gIn, IB[ 1 ] ], [ IB[ 0 ], y, IB[ 1 ] ], [ IA[ 0 ], y, IA[ 1 ] ], inN,
				[ [ u, gIn ], [ u + len, gIn ], [ u + len, y ], [ u, y ] ] );
			// parapet: inner face, top, outer face (down to the ground outside)
			const yp = y + PARAPET_H;
			kit.quadFacing( [ PA[ 0 ], y, PA[ 1 ] ], [ PB[ 0 ], y, PB[ 1 ] ], [ PB[ 0 ], yp, PB[ 1 ] ], [ PA[ 0 ], yp, PA[ 1 ] ], inN,
				[ [ u, y ], [ u + len, y ], [ u + len, yp ], [ u, yp ] ] );
			kit.quadFacing( [ PA[ 0 ], yp, PA[ 1 ] ], [ PB[ 0 ], yp, PB[ 1 ] ], [ OB[ 0 ], yp, OB[ 1 ] ], [ OA[ 0 ], yp, OA[ 1 ] ], up,
				[ [ u, 0 ], [ u + len, 0 ], [ u + len, 0.65 ], [ u, 0.65 ] ] );
			const gOut = Math.min( ground( OA ), ground( OB ) ) - FOOT;
			if ( gate ) archFace( outer, yp, outN, u );
			else kit.quadFacing( [ OA[ 0 ], gOut, OA[ 1 ] ], [ OB[ 0 ], gOut, OB[ 1 ] ], [ OB[ 0 ], yp, OB[ 1 ] ], [ OA[ 0 ], yp, OA[ 1 ] ], outN,
				[ [ u, gOut ], [ u + len, gOut ], [ u + len, yp ], [ u, yp ] ] );
			if ( parapetBoth ) {

				// a free-standing stretch: a parapet on the town side too
				const QA = off( A, pIn ), QB = off( B, pIn );
				kit.quadFacing( [ QA[ 0 ], y, QA[ 1 ] ], [ QB[ 0 ], y, QB[ 1 ] ], [ QB[ 0 ], yp, QB[ 1 ] ], [ QA[ 0 ], yp, QA[ 1 ] ], outN );
				kit.quadFacing( [ IA[ 0 ], yp, IA[ 1 ] ], [ IB[ 0 ], yp, IB[ 1 ] ], [ QB[ 0 ], yp, QB[ 1 ] ], [ QA[ 0 ], yp, QA[ 1 ] ], up );
				kit.quadFacing( [ IA[ 0 ], y, IA[ 1 ] ], [ IB[ 0 ], y, IB[ 1 ] ], [ IB[ 0 ], yp, IB[ 1 ] ], [ IA[ 0 ], yp, IA[ 1 ] ], inN );

			}

			// the passage: soffit and jambs
			if ( gate ) {

				for ( let k = 0; k < SUB; k ++ ) {

					const a = arch[ k ], b = arch[ k + 1 ];
					const ia = off( a.m, inner ), ib = off( b.m, inner ), oa = off( a.m, outer ), ob = off( b.m, outer );
					kit.quadFacing( [ ia[ 0 ], a.y, ia[ 1 ] ], [ ib[ 0 ], b.y, ib[ 1 ] ], [ ob[ 0 ], b.y, ob[ 1 ] ], [ oa[ 0 ], a.y, oa[ 1 ] ], [ 0, - 1, 0 ] );

				}

				const prev = samples[ i - 1 ], next = samples[ i + 1 ];
				const tA = [ - p.tx, 0, - p.tz ], tB = [ p.tx, 0, p.tz ];
				const yA = arch[ 0 ].y, yB = arch[ SUB ].y;
				if ( ! prev || prev.gate !== gate ) kit.quadFacing( [ IA[ 0 ], gIn, IA[ 1 ] ], [ OA[ 0 ], gOut, OA[ 1 ] ], [ OA[ 0 ], yA, OA[ 1 ] ], [ IA[ 0 ], yA, IA[ 1 ] ], tB );
				if ( ! next || next.gate !== gate ) kit.quadFacing( [ IB[ 0 ], gIn, IB[ 1 ] ], [ OB[ 0 ], gOut, OB[ 1 ] ], [ OB[ 0 ], yB, OB[ 1 ] ], [ IB[ 0 ], yB, IB[ 1 ] ], tA );

			}

			// risers to the next tread (or the end caps)
			const next = samples[ i + 1 ];
			const prev = samples[ i - 1 ];
			if ( ! prev ) this._cap( A, gIn, y, inner, outer, [ - p.tx, 0, - p.tz ] );
			if ( ! next ) this._cap( B, gIn, y, inner, outer, [ p.tx, 0, p.tz ] );
			else if ( next.y !== y ) {

				const lo = Math.min( y, next.y ), hi = Math.max( y, next.y );
				const face = next.y > y ? [ - p.tx, 0, - p.tz ] : [ p.tx, 0, p.tz ];
				const BI = off( B, inner ), BP = off( B, PARAPET_IN ), BO = off( B, outer );
				kit.quadFacing( [ BI[ 0 ], lo, BI[ 1 ] ], [ BP[ 0 ], lo, BP[ 1 ] ], [ BP[ 0 ], hi, BP[ 1 ] ], [ BI[ 0 ], hi, BI[ 1 ] ], face,
					[ [ 0, lo ], [ 2.15, lo ], [ 2.15, hi ], [ 0, hi ] ] );
				kit.quadFacing( [ BP[ 0 ], lo + PARAPET_H, BP[ 1 ] ], [ BO[ 0 ], lo + PARAPET_H, BO[ 1 ] ], [ BO[ 0 ], hi + PARAPET_H, BO[ 1 ] ], [ BP[ 0 ], hi + PARAPET_H, BP[ 1 ] ], face,
					[ [ 0, lo ], [ 0.65, lo ], [ 0.65, hi ], [ 0, hi ] ] );

			}

			// merlons on the parapet
			const m0 = Math.floor( ( p.s - PIECE / 2 ) / MERLON_PITCH ), m1 = Math.floor( ( p.s + PIECE / 2 ) / MERLON_PITCH );
			for ( let m = m0; m <= m1; m ++ ) {

				const sc = m * MERLON_PITCH + MERLON_W / 2;
				if ( sc < p.s - PIECE / 2 || sc >= p.s + PIECE / 2 ) continue;
				const yaw = Math.atan2( - p.tz, p.tx );
				const c = off( p, ( PARAPET_IN + outer ) / 2 );
				const mh = MERLON_H * ( 0.95 + 0.1 * Math.sin( m * 12.9 ) );
				kit.box( c[ 0 ] + p.tx * ( sc - p.s ), yp + mh / 2, c[ 1 ] + p.tz * ( sc - p.s ), MERLON_W, mh, outer - PARAPET_IN, yaw, 'bottom' );
				if ( parapetBoth ) {

					const c2 = off( p, - ( PARAPET_IN + outer ) / 2 );
					kit.box( c2[ 0 ] + p.tx * ( sc - p.s ), yp + mh / 2, c2[ 1 ] + p.tz * ( sc - p.s ), MERLON_W, mh, outer - PARAPET_IN, yaw, 'bottom' );

				}

			}

			// colliders: the walk (walkable) and the parapet (solid, too tall to climb)
			const yaw = Math.atan2( - p.tz, p.tx );
			const bottom = gate ? yg : Math.min( gIn, gOut );
			const walkW = PARAPET_IN - pIn;
			const wc = off( p, ( pIn + PARAPET_IN ) / 2 );
			this.colliders.addBox( new Vector3( wc[ 0 ], ( y + bottom ) / 2, wc[ 1 ] ), new Vector3( PIECE / 2 + 0.02, ( y - bottom ) / 2, walkW / 2 ), yaw, { walkable: true, tag: 'wall' } );
			const pc = off( p, ( PARAPET_IN + outer ) / 2 );
			const ptop = y + PARAPET_H + MERLON_H + 0.1;
			this.colliders.addBox( new Vector3( pc[ 0 ], ( ptop + bottom ) / 2, pc[ 1 ] ), new Vector3( PIECE / 2 + 0.02, ( ptop - bottom ) / 2, ( outer - PARAPET_IN ) / 2 ), yaw, { walkable: false, tag: 'parapet' } );
			if ( parapetBoth ) {

				const qc = off( p, ( inner + pIn ) / 2 );
				this.colliders.addBox( new Vector3( qc[ 0 ], ( ptop + bottom ) / 2, qc[ 1 ] ), new Vector3( PIECE / 2 + 0.02, ( ptop - bottom ) / 2, ( pIn - inner ) / 2 ), yaw, { walkable: false, tag: 'parapet' } );

			}

			u += len;

		}

		const wl = { samples, outward: profile.outward, parapetBoth };
		this.walkLines.push( wl );
		return wl;

	}

	// end cap across the whole wall section at cross-section point m
	_cap( m, y0, y, inner, outer, face ) {

		const kit = this.kit;
		const off = ( d ) => [ m.x + m.nx * d, m.z + m.nz * d ];
		const I = off( inner ), O = off( outer );
		kit.quadFacing( [ I[ 0 ], y0, I[ 1 ] ], [ O[ 0 ], y0, O[ 1 ] ], [ O[ 0 ], y + PARAPET_H, O[ 1 ] ], [ I[ 0 ], y + PARAPET_H, I[ 1 ] ], face );

	}

	// nearest walk sample on any wall line within r (for towers and stairs)
	_nearestWalk( x, z, r = 6 ) {

		let best = null, bd = r;
		for ( const wl of this.walkLines ) for ( const p of wl.samples ) {

			const d = Math.hypot( p.x - x, p.z - z );
			if ( d < bd ) {

				bd = d;
				best = p;

			}

		}

		return best ? { p: best, d: bd } : null;

	}

	// Towers from the OSM footprints. Those on the curtain (cubelos, torreões) rise to the walk with a
	// crenellated parapet round the outer sides, so the walk carries on over them; the keep and the
	// big towers stand taller and are solid.
	_towers() {

		const T = this.terrain, kit = this.kit;
		const TALL = { 'Torre de Dom Fernando': 15, 'Torre de Dom Dinis': 10, 'Torre Albarrã': 9, 'Torre do Facho': 7, 'cubelo quadrangular': 4 };
		for ( const t of OSM.towers ) {

			let poly = t.pts.slice( 0, - 1 );
			if ( poly.length < 3 ) continue;
			if ( polygonArea( poly ) < 0 ) poly = poly.reverse(); // counter-clockwise in (x, z)
			const cx = poly.reduce( ( a, q ) => a + q[ 0 ], 0 ) / poly.length, cz = poly.reduce( ( a, q ) => a + q[ 1 ], 0 ) / poly.length;
			const near = this._nearestWalk( cx, cz, 14 );
			let base = Infinity;
			for ( const q of poly ) base = Math.min( base, T.heightAt( q[ 0 ], q[ 1 ] ) );
			base -= FOOT;
			const walkY = near ? near.p.y : T.heightAt( cx, cz ) + 6;
			const extra = TALL[ t.name ] ?? ( t.name === 'torreão' ? 3 : 0 );
			const top = walkY + extra;
			const walkable = extra === 0;
			kit.vdata = [ 0.13 + cx * 0.01, 0.9, 0, 0 ];
			kit.color = [ 0.95, 0.94, 0.92 ];
			// sides
			let u = 0;
			for ( let i = 0; i < poly.length; i ++ ) {

				const a = poly[ i ], b = poly[ ( i + 1 ) % poly.length ];
				const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
				const nOut = [ ( b[ 1 ] - a[ 1 ] ) / L, 0, - ( b[ 0 ] - a[ 0 ] ) / L ];
				// counter-clockwise in (x, z) with z down: ( dz, -dx ) points out
				const sgn = pointInPolygon( ( a[ 0 ] + b[ 0 ] ) / 2 + nOut[ 0 ] * 0.3, ( a[ 1 ] + b[ 1 ] ) / 2 + nOut[ 2 ] * 0.3, poly ) ? - 1 : 1;
				const nn = [ nOut[ 0 ] * sgn, 0, nOut[ 2 ] * sgn ];
				const mx = ( a[ 0 ] + b[ 0 ] ) / 2, mz = ( a[ 1 ] + b[ 1 ] ) / 2;
				const onWalk = walkable && near && this._nearestWalk( mx, mz, 1.6 );
				const yTop = top + ( onWalk ? 0 : PARAPET_H );
				kit.quadFacing( [ a[ 0 ], base, a[ 1 ] ], [ b[ 0 ], base, b[ 1 ] ], [ b[ 0 ], yTop, b[ 1 ] ], [ a[ 0 ], yTop, a[ 1 ] ], nn,
					[ [ u, base ], [ u + L, base ], [ u + L, yTop ], [ u, yTop ] ] );
				// parapet + merlons along the edges away from the walk
				if ( ! onWalk ) {

					const nm = Math.max( 1, Math.round( L / MERLON_PITCH ) );
					const yaw = Math.atan2( - ( b[ 1 ] - a[ 1 ] ), b[ 0 ] - a[ 0 ] );
					for ( let k = 0; k < nm; k ++ ) {

						const t0 = ( k + 0.5 ) / nm;
						const px = a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t0 - nn[ 0 ] * 0.3, pz = a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t0 - nn[ 2 ] * 0.3;
						kit.box( px, yTop + MERLON_H / 2, pz, Math.min( MERLON_W, L / nm * 0.6 ), MERLON_H, 0.6, yaw, 'bottom' );

					}

					// a parapet collider along the edge
					const ec = [ mx - nn[ 0 ] * 0.3, mz - nn[ 2 ] * 0.3 ];
					this.colliders.addBox( new Vector3( ec[ 0 ], ( top + yTop + MERLON_H ) / 2 + 0.05, ec[ 1 ] ), new Vector3( L / 2, ( yTop + MERLON_H - top ) / 2 + 0.05, 0.3 ), yaw, { walkable: false, tag: 'parapet' } );

				}

				u += L;

			}

			// roof / walking surface (fan triangulation of the convex-ish footprint)
			for ( let i = 1; i + 1 < poly.length; i ++ ) {

				const a = poly[ 0 ], b = poly[ i ], c = poly[ i + 1 ];
				kit.tri( [ a[ 0 ], top, a[ 1 ] ], [ b[ 0 ], top, b[ 1 ] ], [ c[ 0 ], top, c[ 1 ] ], [ [ a[ 0 ], a[ 1 ] ], [ b[ 0 ], b[ 1 ] ], [ c[ 0 ], c[ 1 ] ] ], [ 0, 1, 0 ] );

			}

			// the inner rim of the parapet (between the walk level and the parapet top)
			for ( let i = 0; i < poly.length; i ++ ) {

				const a = poly[ i ], b = poly[ ( i + 1 ) % poly.length ];
				const mx = ( a[ 0 ] + b[ 0 ] ) / 2, mz = ( a[ 1 ] + b[ 1 ] ) / 2;
				if ( walkable && near && this._nearestWalk( mx, mz, 1.6 ) ) continue;
				const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
				const ins = [ - ( b[ 1 ] - a[ 1 ] ) / L, ( b[ 0 ] - a[ 0 ] ) / L ];
				const sgn = pointInPolygon( mx + ins[ 0 ] * 0.3, mz + ins[ 1 ] * 0.3, poly ) ? 1 : - 1;
				const d = [ ins[ 0 ] * sgn * 0.6, ins[ 1 ] * sgn * 0.6 ];
				kit.quadFacing( [ a[ 0 ] + d[ 0 ], top, a[ 1 ] + d[ 1 ] ], [ b[ 0 ] + d[ 0 ], top, b[ 1 ] + d[ 1 ] ], [ b[ 0 ] + d[ 0 ], top + PARAPET_H, b[ 1 ] + d[ 1 ] ], [ a[ 0 ] + d[ 0 ], top + PARAPET_H, a[ 1 ] + d[ 1 ] ], [ d[ 0 ], 0, d[ 1 ] ] );
				kit.quadFacing( [ a[ 0 ], top + PARAPET_H, a[ 1 ] ], [ b[ 0 ], top + PARAPET_H, b[ 1 ] ], [ b[ 0 ] + d[ 0 ], top + PARAPET_H, b[ 1 ] + d[ 1 ] ], [ a[ 0 ] + d[ 0 ], top + PARAPET_H, a[ 1 ] + d[ 1 ] ], [ 0, 1, 0 ] );

			}

			// colliders: an oriented box per footprint (walkable top for the walk-level towers)
			const obb = orientedBox( poly );
			this.colliders.addBox( new Vector3( obb.cx, ( top + base ) / 2, obb.cz ), new Vector3( obb.hx, ( top - base ) / 2, obb.hz ), obb.yaw, { walkable: true, solid: true, tag: 'tower' } );
			this.towerTops.push( { name: t.name, x: cx, z: cz, top, walkable } );

		}

	}

	// Flights of steps up from the streets: against the inner face, running along the wall, where the
	// walk is 2-6 m above the ground inside and nothing is built in the way; spread round the circuit
	_stairs() {

		const T = this.terrain;
		const wl = this.curtain;
		if ( ! wl ) return;
		const S = wl.samples;
		const cands = [];
		for ( let i = 20; i < S.length - 20; i += 3 ) {

			const p = S[ i ];
			if ( p.gate ) continue;
			// Porta da Vila has its own way up
			if ( this.portaDaVila && this.portaDaVila.gates.some( ( g ) => Math.hypot( p.x - g.x, p.z - g.z ) < 40 ) ) continue;
			const fx = p.x - p.nx * 2.0, fz = p.z - p.nz * 2.0; // the stair's line, just inside
			const rise = p.y - T.heightAt( fx, fz );
			if ( rise < 1.6 || rise > 6.5 ) continue;
			cands.push( { i, rise } );

		}

		const chosen = [];
		const SPACING = 80;
		// prefer the gates (stairs by them in the real town), then the lowest rises
		const near = ( i ) => T.gates.some( ( g ) => Math.hypot( S[ i ].x - g.x, S[ i ].z - g.z ) < 25 );
		cands.sort( ( a, b ) => ( near( b.i ) - near( a.i ) ) || ( a.rise - b.rise ) );
		for ( const c of cands ) {

			if ( chosen.some( ( o ) => Math.abs( S[ o.i ].s - S[ c.i ].s ) < SPACING ) ) continue;
			for ( const dir of [ - 1, 1 ] ) {

				const st = this._stairAt( c.i, dir, true );
				if ( st ) {

					chosen.push( { i: c.i, dir } );
					break;

				}

			}

		}

		for ( const c of chosen ) this._stairAt( c.i, c.dir, false );

	}

	// a flight whose top lands beside walk sample i, descending along the wall in direction dir
	// (+1 = toward increasing s). check: only test the footprint.
	_stairAt( i, dir, check ) {

		const T = this.terrain, kit = this.kit;
		const S = this.curtain.samples;
		const p = S[ i ];
		const width = 1.5, run = 0.32;
		const off = W / 2 + width / 2 + 0.02; // centre line, inside the inner face
		// walk down the wall until the ground meets the tread height
		const steps = [];
		let y = p.y, along = 0;
		while ( true ) {

			if ( steps.length > 45 ) return null; // too tall a flight: the ground falls away along the wall

			// the wall line at arc length p.s + dir * ( along + run / 2 ): the middle of this step
			const f = i + dir * ( along + run / 2 ) / PIECE;
			const k0 = Math.floor( f ), t = f - k0;
			const a = S[ k0 ], b = S[ k0 + 1 ];
			if ( ! a || ! b || a.gate || b.gate ) return null;
			const q = { x: a.x + ( b.x - a.x ) * t, z: a.z + ( b.z - a.z ) * t, nx: a.nx, nz: a.nz, tx: a.tx, tz: a.tz };
			// only along straight-ish stretches (on a bend the wall's pieces crowd the flight)
			if ( a.tx * p.tx + a.tz * p.tz < Math.cos( 0.3 ) ) return null;
			const cx = q.x - q.nx * off, cz = q.z - q.nz * off;
			const g = T.heightAt( cx, cz );
			if ( y - g < 0.12 ) break;
			// the walk beside the flight must not be lower than the step (a flight rising under the walk)
			if ( steps.length > 0 && a.y < y - 0.05 && Math.abs( a.y - y ) > STEP_RISE * 2 ) return null;
			steps.push( { x: cx, z: cz, y, g, q } );
			y -= STEP_RISE;
			along += run;

		}

		if ( steps.length < 4 ) return null;
		if ( check ) {

			for ( const st of steps ) {

				const near = this.buildingIndex.nearest( st.x, st.z, 1.0 );
				if ( near ) return null;
				for ( const b of OSM.buildings ) {

					if ( Math.abs( b.pts[ 0 ][ 0 ] - st.x ) > 40 || Math.abs( b.pts[ 0 ][ 1 ] - st.z ) > 40 ) continue;
					if ( pointInPolygon( st.x, st.z, b.pts ) ) return null;

				}

			}

			return steps;

		}

		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 1, 0.98, 0.95 ];
		for ( let s = 0; s < steps.length; s ++ ) {

			const st = steps[ s ];
			const q = st.q;
			const yaw = Math.atan2( - q.tz, q.tx );
			const bottom = st.g - 0.6;
			const h = st.y - bottom;
			// each step a solid block from the ground to its tread (the run is along the wall)
			const cx = st.x, cz = st.z;
			kit.box( cx, bottom + h / 2, cz, run + 0.02, h, width, yaw, 'bottom' );
			this.colliders.addBox( new Vector3( cx, bottom + h / 2, cz ), new Vector3( run / 2 + 0.01, h / 2, width / 2 ), yaw, { walkable: true, tag: 'stair' } );

		}

		this.stairs.push( { x: steps[ 0 ].x, z: steps[ 0 ].z, top: steps[ 0 ].y, bottom: steps[ steps.length - 1 ], n: steps.length, steps: steps.map( ( st ) => ( { x: st.x, z: st.z, y: st.y } ) ) } );
		return steps;

	}

}

// minimum-area-ish oriented box of a polygon: the box aligned with its longest edge
export function orientedBox( poly ) {

	let best = null;
	for ( let i = 0; i < poly.length; i ++ ) {

		const a = poly[ i ], b = poly[ ( i + 1 ) % poly.length ];
		const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
		if ( L < 0.3 ) continue;
		const ux = ( b[ 0 ] - a[ 0 ] ) / L, uz = ( b[ 1 ] - a[ 1 ] ) / L;
		let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
		for ( const q of poly ) {

			const lx = q[ 0 ] * ux + q[ 1 ] * uz, lz = - q[ 0 ] * uz + q[ 1 ] * ux;
			x0 = Math.min( x0, lx ); x1 = Math.max( x1, lx ); z0 = Math.min( z0, lz ); z1 = Math.max( z1, lz );

		}

		const area = ( x1 - x0 ) * ( z1 - z0 );
		if ( ! best || area < best.area ) {

			const lcx = ( x0 + x1 ) / 2, lcz = ( z0 + z1 ) / 2;
			best = { area, cx: lcx * ux - lcz * uz, cz: lcx * uz + lcz * ux, hx: ( x1 - x0 ) / 2, hz: ( z1 - z0 ) / 2, ux, uz, yaw: Math.atan2( - uz, ux ) };

		}

	}

	return best;

}
