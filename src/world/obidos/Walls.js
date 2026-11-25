import { Group, Mesh, Vector3, Color } from '../../engine/index.js';
import { MeshKit } from './MeshKit.js';
import { mulberry32, smoothstep, lerp } from '../../util/Noise.js';
import { OSM, resample, pointInPolygon, polygonArea, SegmentIndex, segmentDistance } from './Geo.js';
import { PV_ALLEY, VALE_STEPS, ORNELAS_MARKERS, SANTA_MARIA_CHAPEL } from '../TerrainData.js';

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
const LOW_MERLON = 0.5; // the merlons round Porta da Vila's void, lower than the curtain's
const MERLON_PITCH = 1.85;
const PIECE = 0.6;
const STEP_RISE = 0.18;
// Porta do Vale, where the street crosses the curtain, and the curtain's own line round the torreão left of
// it (outside), from the corner where it juts out to past the gate
const VALE_GATE = [ 97.4, - 37.3 ];
// the tower there (photos references/...-porta-nordeste-1, -img-4396; OSM has only the curtain's line round
// it): square, well over the curtain, crenellated; its outer faces 1.4 m out from that line, the Oratório
// inside it
const VALE_TOWER = { name: 'Torre da Porta do Vale', extra: 5, pts: [ [ 87.9, - 27.44 ], [ 94.54, - 24.11 ], [ 99.78, - 34.82 ], [ 98.09, - 35.67 ], [ 96.3, - 35 ], [ 93.9, - 34.2 ], [ 87.9, - 35.8 ], [ 85.6, - 32.1 ], [ 87.9, - 27.44 ] ],
	// its north side, towards the house over the gate, is open: the walk climbs onto it there; and its west
	// side, where the curtain from the south comes up level with it
	open: [ [ 99.78, - 34.82 ], [ 98.09, - 35.67 ], [ 96.3, - 35 ], [ 93.9, - 34.2 ], [ 87.9, - 35.8 ], null, [ 85.6, - 32.1 ], [ 87.9, - 27.44 ] ] };
const VALE_TORREAO = [ [ 86.5, - 29.7 ], [ 93.9, - 26 ], [ 97.9, - 34.2 ], [ 96.3, - 35 ], [ 97.4, - 37.3 ], [ 99.8, - 42.2 ] ];
const FOOT = 2.0; // the faces go this far below the ground
// Porta da Vila's town and west walls (after OSM way 475653576): east end (at the curtain), inner arch,
// corner, curtain
const PORTA_DA_VILA = [ [ - 46.95, 225.42 ], [ - 51.1, 225 ], [ - 61.2, 223.9 ], [ - 61.8, 233.3 ] ]; // from the curtain's corner
const PV_TOWER = 13.2; // Porta da Vila's tower: its four walls' walk this high over its floor
const PV_EAST_FACE = - 48.6; // the tower's east side (the curtain): its face on the void
const PV_FLIGHT = 2.3; // the L-shaped flight's width, as in the photo (references/...-duasescadas)
const clamp01 = ( v ) => Math.min( 1, Math.max( 0, v ) );
const segDist = ( x, z, a, b ) => segmentDistance( x, z, a, b )[ 0 ];

// a bar of iron into kit from a to b ([ x, y, z ]), w thick (square in section)
function ironBar( kit, a, b, w ) {

	const dx = b[ 0 ] - a[ 0 ], dz = b[ 2 ] - a[ 2 ], l = Math.hypot( dx, dz );
	const vert = l < 1e-4;
	// (a vertical bar: any horizontal side will do)
	const ux = vert ? 1 : dx / l, uz = vert ? 0 : dz / l;
	const sx = - uz * w / 2, sz = ux * w / 2, h = w / 2;
	const c = ( p, i, j ) => vert ? [ p[ 0 ] + sx * i + ux * h * j, p[ 1 ], p[ 2 ] + sz * i + uz * h * j ] : [ p[ 0 ] + sx * i, p[ 1 ] + h * j, p[ 2 ] + sz * i ];
	const ax = vert ? [ 0, Math.sign( b[ 1 ] - a[ 1 ] ), 0 ] : [ ux, 0, uz ];
	const up = vert ? [ ux, 0, uz ] : [ 0, 1, 0 ];
	kit.quadFacing( c( a, - 1, 1 ), c( b, - 1, 1 ), c( b, 1, 1 ), c( a, 1, 1 ), up );
	kit.quadFacing( c( a, - 1, - 1 ), c( b, - 1, - 1 ), c( b, 1, - 1 ), c( a, 1, - 1 ), up.map( ( v ) => - v ) );
	kit.quadFacing( c( a, 1, - 1 ), c( b, 1, - 1 ), c( b, 1, 1 ), c( a, 1, 1 ), [ sx, 0, sz ] );
	kit.quadFacing( c( a, - 1, - 1 ), c( b, - 1, - 1 ), c( b, - 1, 1 ), c( a, - 1, 1 ), [ - sx, 0, - sz ] );
	kit.quadFacing( c( a, - 1, - 1 ), c( a, 1, - 1 ), c( a, 1, 1 ), c( a, - 1, 1 ), ax.map( ( v ) => - v ) );
	kit.quadFacing( c( b, - 1, - 1 ), c( b, 1, - 1 ), c( b, 1, 1 ), c( b, - 1, 1 ), ax );

}
const lin = ( c ) => c.map( ( v ) => ( v <= 0.04045 ? v / 12.92 : ( ( v + 0.055 ) / 1.055 ) ** 2.4 ) );

export class Walls {

	constructor( { scene, terrain, colliders, materials } ) {

		this.terrain = terrain;
		this.colliders = colliders;
		this.group = new Group();
		this.group.name = 'Walls';
		this.kit = new MeshKit();
		this.kit.color = [ 1, 1, 1 ];
		this.stairs = [];
		this.clearLines = []; // [{ pts, clear }]: houses keep this far from these lines (the town's streets)
		this.towerTops = [];
		this.lights = []; // lanterns (for LocalLights)
		this.walkLines = [];
		this.buildingIndex = new SegmentIndex( OSM.buildings.map( ( b ) => b.pts ), 12 );

		// Porta da Vila's outer arch is narrower than the street, so it clears the tower's west wall
		const portaDaVila = terrain.gates.find( ( g ) => g.street === 'Rua Porta da Vila' );
		// and is pointed (photo references/...-portadavila)
		if ( portaDaVila ) Object.assign( portaDaVila, { half: 1.7, pointed: 1.6 } );
		// Porta Este is a narrow pointed doorway, 1.4 m wide and about 3.8 m high (photos
		// references/...-deforaportaeste, -deforaportaeste2); the wall's pieces leave a wider gap, which
		// _portaEste closes down to it with masonry
		const portaEste = terrain.portaEste && terrain.portaEste.gate;
		// seen from the town it is a taller round arch as wide as the gap, the doorway set back in it (photo
		// references/...-portaeste3)
		if ( portaEste ) Object.assign( portaEste, { half: 0.6, pointed: 1.6, spring: 2.7, fit: true, opening: 0.7, inner: { spring: 3.15, depth: 1.5 } } );
		// Porta do Vale, the north-east gate (photo references/...-porta-nordeste-1): a low basket arch, about
		// 3 m wide, springing at 2.9 m and rising 0.85 m more, right beside the tower's side (OSM's crossing
		// is 0.7 m too far south: the tower would hide its left edge)
		const portaDoVale = terrain.gates.find( ( g ) => Math.hypot( g.x - VALE_GATE[ 0 ], g.z - VALE_GATE[ 1 ] ) < 2 );
		if ( portaDoVale ) Object.assign( portaDoVale, { x: portaDoVale.x + 0.43 * 0.7, z: portaDoVale.z - 0.9 * 0.7, half: 1.4, spring: 2.9, flat: 0.85 } );
		// the curtain round the town; on Porta da Vila's tower (its outer and east sides) it stands as high
		// as the tower's town wall
		const wall = { ...terrain.wall, pts: terrain.wall.pts.map( ( p ) => ( { ...p } ) ) };
		this._pvCurtainCorner( wall );
		// left of Porta do Vale (outside) the curtain juts out round the tower there (_towers builds it), its
		// corners sharp; the 2 m profile cut them
		this._curtainRun( wall, VALE_TORREAO );
		const tower = wall.pts.filter( ( p ) => p.x > - 61.5 && p.x < - 46 && p.z > 226 && p.z < 236.5 );
		if ( tower.length ) {

			const top = terrain.heightAt( - 51.1, 225 ) + PV_TOWER, s1 = Math.max( ...tower.map( ( p ) => p.s ) );
			this.pvTop = top;
			// east of it (on along the curtain) it comes down to the walk
			for ( const p of wall.pts ) if ( p.s >= Math.min( ...tower.map( ( q ) => q.s ) ) ) p.top = Math.max( p.top, top - Math.max( 0, p.s - s1 ) / 2.5 );

		}

		// west of it the walk goes on level with the tower past the head of the L-shaped flight (its landing
		// joins them), then climbs in big steps (36 cm every 2.4 m) until it meets the curtain's own rise
		const westOfTower = ( samples ) => {

			if ( this.pvTop === undefined ) return;
			const on = samples.filter( ( p ) => p.x > - 61.5 && p.x < - 46 && p.z > 226 && p.z < 236.5 );
			for ( const p of on ) p.top = Math.max( p.top, this.pvTop ); // (the profile's points are sparse by the gate)
			const s0 = Math.min( ...on.map( ( p ) => p.s ) );
			const LEVEL = 4.4, RISE = 0.36, RUN = 2.4;
			for ( const p of samples.filter( ( q ) => q.s < s0 ).sort( ( a, b ) => b.s - a.s ) ) {

				const d = s0 - p.s, y = this.pvTop + ( d < LEVEL ? 0 : RISE * Math.ceil( ( d - LEVEL ) / RUN ) );
				if ( p.top >= y ) break;
				p.top = y;

			}

		};
		// its corners round Porta da Vila's east side, and on along the stretch north-east of it, are sharp:
		// the profile's normals, smoothed over a few metres, twist the faces there and open holes
		// on the tower its town side, round the void inside, has a crenellated parapet too, with low merlons
		// and on from the tower's north-east corner, as far as the house leaning on it inside ends, a low
		// guard wall on its town side, the walk a ramp (no steps) and the walls sloping with it
		const NE = ( p ) => p.x > - 46.6 && p.x < - 20.5 && p.z > 193 && p.z < 226.5;
		const onTower = ( p ) => p.x > - 61.5 && p.x < - 46.6 && p.z > 226.7 && p.z < 236.5 ? 'void' : NE( p ) ? 'low' : null; // (the void from the town wall's face)
		// over Rua da Porta da Senhora da Graça, north from Porta Este, the curtain stands a little higher than
		// the ground alone gives it (photo references/...-img-4394), easing back at both ends
		const senhoraDaGraca = ( samples ) => {

			const RAISE = 1.3;
			for ( const p of samples ) if ( p.x > 70 && p.x < 90 ) {

				p.raised = RAISE * clamp01( ( 53 - p.z ) / 5 ) * clamp01( ( p.z - 14 ) / 6 );
				p.top += p.raised;

			}

		};
		// on from Porta do Vale's way out the curtain stands as high as the block there, its merlons level with
		// the block's top (photo references/...-1703-img-4410), coming down further on
		const valeExit = ( samples ) => {

			if ( ! portaDoVale ) return;
			// (the hall's frame and height as _valePassage works them out)
			const g = portaDoVale, tx = 0.4315, tz = - 0.9021, nx = 0.9021, nz = 0.4315, R = 1.93;
			let hi = - Infinity;
			for ( const [ u, v ] of [ [ - R, 1.4 ], [ - R, 7 ], [ 0, 7 ], [ 4.5, 1.4 ], [ 4.5, 7 ] ] ) hi = Math.max( hi, terrain.heightAt( g.x + tx * u - nx * v, g.z + tz * u - nz * v ) );
			const walk = hi + 7.45 - PARAPET_H - MERLON_H;
			// and along the house's outer side the walk climbs in steps to the tower's top, its north side open
			// to it (no parapet there): the way on round the house to the curtain south of it
			const tower = VALE_TOWER.pts.slice( 0, - 1 ), n = tower.length;
			const cx = tower.reduce( ( a, q ) => a + q[ 0 ], 0 ) / n, cz = tower.reduce( ( a, q ) => a + q[ 1 ], 0 ) / n;
			let near = null;
			for ( const p of samples ) if ( ! near || Math.hypot( p.x - cx, p.z - cz ) < Math.hypot( near.x - cx, near.z - cz ) ) near = p;
			const towerTop = this.valeTowerTop = Math.round( near.top / STEP_RISE ) * STEP_RISE + VALE_TOWER.extra;
			const U_TOWER = - 1.2, U_WALK = 8;
			for ( const p of samples ) {

				const u = ( p.x - g.x ) * tx + ( p.z - g.z ) * tz, v = ( p.x - g.x ) * nx + ( p.z - g.z ) * nz;
				if ( u < U_TOWER - 2.5 || u > 22 || Math.abs( v ) > 4 || pointInPolygon( p.x, p.z, tower ) ) continue;
				const y = u < U_WALK ? towerTop + ( walk - towerTop ) * clamp01( ( u - U_TOWER ) / ( U_WALK - U_TOWER ) ) : walk - ( walk - p.top ) * clamp01( ( u - 13 ) / 9 ) ** 1.5;
				if ( y > p.top ) {

					p.raised = ( p.raised || 0 ) + y - p.top;
					p.top = y;

				}

			}

			// the curtain coming up from the south reaches the tower's west side as high as its top, climbing
			// to it over the last 24 m
			const Z_TOWER = - 30.3;
			for ( const p of samples ) {

				const d = p.z - Z_TOWER;
				if ( Math.abs( p.x - 86.5 ) > 2 || d < 0 || d > 26 || pointInPolygon( p.x, p.z, tower ) ) continue;
				const y = towerTop - ( towerTop - p.top ) * clamp01( ( d - 2 ) / 22 );
				if ( y > p.top ) {

					p.raised = ( p.raised || 0 ) + y - p.top;
					p.top = y;

				}

			}

		};
		const adjust = ( samples ) => {

			westOfTower( samples );
			senhoraDaGraca( samples );
			valeExit( samples );

		};
		this.curtain = this._wallLine( wall, terrain.gates, 0.37, { sharp: [ [ - 50.5, 190, - 18, 236.5 ], [ 92, - 44, 101, - 24 ] ], corners: VALE_TORREAO.slice( 1, 4 ), adjust, town: onTower, ramp: NE } );
		// houses keep off that stretch of the curtain (the house leaning on it overlapped its town half): its
		// line run backwards, so the town is on the left
		const ne = this.curtain.samples.filter( NE ).sort( ( a, b ) => b.s - a.s );
		if ( ne.length > 1 ) this.clearLines.push( { pts: ne.map( ( p ) => [ p.x, p.z ] ), clear: W / 2 + 0.15 } );
		if ( portaDaVila ) this._portaDaVila( portaDaVila );
		if ( portaDaVila ) this._passoPortal( portaDaVila );
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
		this._portaDaVilaLane();
		this._casaDaMusicaTerrace();
		this._cemiterioWall();
		this._ornelas( materials );
		this._praceta();
		this._portaEste( materials );
		this._beneficiado( materials );
		this._santaMariaSteps( materials );
		this._santaMariaSquare( materials );
		this._santaMariaChurch( materials );
		this._torreLargo( materials );
		this._torreLane( materials );
		this._misericordiaPortal( materials );
		this._senhoraDaGraca( materials );
		this._escadariaBiblioteca( materials );
		this._valePassage( materials );
		// the trees in the garden against the curtain beside Rua Dom João de Ornelas (photo references/...-img-4391)
		this.extraTrees = this.extraTrees || [];
		for ( const [ x, z, kind, scale ] of [ [ 53.6, 118.6, 'garden', 0.95 ], [ 50.4, 120.2, 'olive', 0.9 ], [ 54.6, 116.6, 'garden', 0.42 ], [ 47.6, 120.8, 'garden', 1 ],
			// shrubs under them, the ground planted, and one at the curtain's foot by the drainpipe
			[ 55.3, 118.6, 'garden', 0.45 ], [ 52, 121.2, 'garden', 0.5 ], [ 49.2, 122, 'garden', 0.42 ], [ 51.4, 117.6, 'garden', 0.48 ], [ 46, 119.8, 'garden', 0.45 ], [ 58.7, 114.6, 'garden', 0.32 ],
			// and the one showing over the green gate at the fork (photo references/...-img-4390), in the yard behind it
			[ 87, 74.5, 'olive', 1.25 ],
			// and up the street, in the garden behind the long white wall (photo references/...-img-4386)
			[ 24.6, 136.4, 'garden', 0.55 ], [ 28.6, 133.6, 'garden', 0.8 ], [ 33, 130.7, 'olive', 0.85 ], [ 37.6, 128, 'olive', 1.15 ], [ 42.4, 125.2, 'garden', 0.75 ], [ 22.9, 138.3, 'garden', 0.5 ], [ 21.5, 139.9, 'garden', 0.4 ], [ 23.9, 138.6, 'garden', 0.42 ],
			// the big plane tree past the long cream front's far end (photo references/...-img-4384)
			[ 1.2, 187, 'plane', 1.0 ],
			// and near the top, on the square's edge (photo references/...-img-4383)
			[ - 29.3, 227.6, 'garden', 1.15 ] ] ) this.extraTrees.push( { kind, x, z, scale } );
		// and the worn stones along the curtain's foot there, and the two small marker stones
		{

			const kit = this.kit, r = mulberry32( 4391 ), T = terrain;
			kit.vdata = [ 0.29, 0.7, 0, 0 ];
			const lump = ( x, z, sx, sy, sz, yaw ) => kit.box( x, T.heightAt( x, z ) + sy / 2 - 0.05, z, sx, sy, sz, yaw, 'bottom' );
			for ( let i = 0; i < 10; i ++ ) {

				const x = 59 + r() * 8, z = 110 + ( 66.1 - x ) * 0.4 + 1.7 + r() * 0.5, sz = 0.1 + r() * 0.16, v = 0.85 + r() * 0.2;
				kit.color = [ v * 1.05, v * 0.92, v * 0.72 ];
				lump( x, z, sz * 1.5, sz * 0.8, sz * 1.1, r() * 3 );

			}

			// (their S R panels: Town._ornelasGardenWall)
			kit.color = [ 0.95, 0.88, 0.72 ];
			for ( const [ x, z ] of ORNELAS_MARKERS ) lump( x, z, 0.22, 0.34, 0.18, Math.atan2( 0.806, - 0.592 ) );

		}
		this._ornelasForkStone();
		if ( this.portaDaVila ) this._oratorio( this.portaDaVila.gates[ 1 ], materials );
		this._pvAlley( materials );
		this._casaWing( materials );

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
		// the tower stands well above the curtain (photo references/...-debaixodaportadavila): its town and
		// west walls, like its other two (the curtain's), about 13 m over its floor, from the curtain's line
		const high = inner.y + PV_TOWER;
		for ( const p of prof.pts ) p.top = Math.max( p.top, high );
		// a sharp corner between the town and west walls, so the L-shaped flight fits against both
		// and a low guard wall along their town side (the void's side has the crenellated parapet)
		this.portaDaVila = this._wallLine( prof, [ inner ], 0.37, { sharp: [ [ - 64, 221, - 58.5, 227 ] ], exact: pts, town: () => 'low', lowOuter: true, bare: ( p ) => p.x > PV_EAST_FACE, capStart: false } ); // (its east end runs into the curtain's corner)
		this.portaDaVila.gates = [ outerGate, inner ];

	}

	// The Casa da Música's south wing (OSM 298902328 has it; Town's outline leaves it out), as in the video
	// references/IMG_4350: right against the stepped lane, its blank white wall closing the head of the first
	// leg, where the lane turns left, and running on beside the second leg for a few metres. From the
	// terrace's corner along the first leg (its south side), the head wall, the end, the back; tiled roofs:
	// a lean-to over the strip along the first leg, a gable over the block at its head
	_casaWing( materials ) {

		if ( ! this.laneNorth || ! this.casaOutline ) return;
		const T = this.terrain, plaster = new MeshKit(), roof = new MeshKit();
		const { corner, north, width } = this.laneNorth, FS = this.casaOutline.FS;
		const xE = corner[ 0 ] - width / 2 - 0.15, xW = - 72.3, zS = 223.3, zN = 214.3;
		// the lane's north edge at x (FS is on it)
		const edge = ( x ) => FS[ 1 ] + north.dz / north.dx * ( x - FS[ 0 ] );
		const A = FS, B = [ xE, edge( xE ) ], C = [ xE, zS ], D = [ xW, zS ], E = [ xW, zN ], F = [ FS[ 0 ], zN ];
		const top = T.heightAt( ...B ) + 6.6, base = Math.min( ...[ A, B, C, D ].map( ( q ) => T.heightAt( ...q ) ) ) - 0.8;
		const WHITE = lin( [ 0.93, 0.92, 0.89 ] );
		// a blank whitewashed face from p to q, outward n
		const face = ( p, q, n, seed ) => {

			const L = Math.hypot( q[ 0 ] - p[ 0 ], q[ 1 ] - p[ 1 ] ), gp = T.heightAt( ...p ), gq = T.heightAt( ...q );
			plaster.vdata = [ L, 1, seed, 0 ];
			plaster.color = WHITE;
			plaster.quadFacing( [ p[ 0 ], base, p[ 1 ] ], [ q[ 0 ], base, q[ 1 ] ], [ q[ 0 ], top, q[ 1 ] ], [ p[ 0 ], top, p[ 1 ] ], n,
				[ [ 0, base - gp ], [ L, base - gq ], [ L, top - gq ], [ 0, top - gp ] ] );

		};
		face( A, B, [ 0, 0, 1 ], 0.17 );
		face( B, C, [ 1, 0, 0 ], 0.43 );
		face( C, D, [ 0, 0, 1 ], 0.71 );
		face( D, E, [ - 1, 0, 0 ], 0.29 );
		face( F, A, [ 1, 0, 0 ], 0.57 );
		const solid = ( x0, x1, z0, z1 ) => this.colliders.addBox( new Vector3( ( x0 + x1 ) / 2, ( top + base ) / 2, ( z0 + z1 ) / 2 ), new Vector3( Math.abs( x1 - x0 ) / 2, ( top - base ) / 2, Math.abs( z1 - z0 ) / 2 ), 0, { walkable: false, tag: 'wall' } );
		solid( xW, xE, zN, zS );
		solid( xE, A[ 0 ], zN, Math.max( A[ 1 ], B[ 1 ] ) );

		// the roofs, eaves 25 cm out
		const O = 0.25, V = ( x, y, z ) => [ x, y, z ];
		roof.vdata = [ 0.37, 0.6, 0, 0 ];
		roof.color = [ 1, 1, 1 ];
		const xm = ( xE + xW ) / 2, yr = top + 1.3, s1 = Math.hypot( ( xE - xW ) / 2 + O, 1.3 ), Lz = zS - zN + 2 * O;
		roof.quadFacing( V( xE + O, top - 0.1, zN - O ), V( xE + O, top - 0.1, zS + O ), V( xm, yr, zS + O ), V( xm, yr, zN - O ), [ 0, 1, 0 ], [ [ 0, s1 ], [ Lz, s1 ], [ Lz, 0 ], [ 0, 0 ] ] );
		roof.quadFacing( V( xW - O, top - 0.1, zN - O ), V( xW - O, top - 0.1, zS + O ), V( xm, yr, zS + O ), V( xm, yr, zN - O ), [ 0, 1, 0 ], [ [ 0, s1 ], [ Lz, s1 ], [ Lz, 0 ], [ 0, 0 ] ] );
		plaster.vdata = [ 0, 0, 0.53, 4 ];
		plaster.color = WHITE;
		for ( const [ z, n ] of [ [ zS, 1 ], [ zN, - 1 ] ] ) plaster.quadFacing( V( xE, top, z ), V( xW, top, z ), V( xm, yr - 0.05, z ), V( xm, yr - 0.05, z ), [ 0, 0, n ] );
		const zl = Math.max( A[ 1 ], B[ 1 ] ), s2 = Math.hypot( zl - zN + O, 0.9 ), Lx = A[ 0 ] - xE + O;
		roof.quadFacing( V( xE, top + 0.8, zN ), V( A[ 0 ] + O, top + 0.8, zN ), V( A[ 0 ] + O, top - 0.1, zl + O ), V( xE, top - 0.1, zl + O ), [ 0, 1, 0 ], [ [ 0, 0 ], [ Lx, 0 ], [ Lx, s2 ], [ 0, s2 ] ] );
		plaster.quadFacing( V( A[ 0 ], top, zN ), V( A[ 0 ], top, zl ), V( A[ 0 ], top + 0.8, zN ), V( A[ 0 ], top + 0.8, zN ), [ 1, 0, 0 ] );

		for ( const [ k, mat, name ] of [ [ plaster, materials.plaster, 'casa-wing' ], [ roof, materials.roof, 'casa-wing-roof' ] ] ) {

			const mesh = new Mesh( k.build(), mat );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

		this.casaWing = [ A, B, C, D, E, F ];

	}

	// no trees on the lane by Porta da Vila's flight, nor in the Casa da Música's wing (Trees asks)
	treeFree( x, z ) {

		if ( this.lane && this.lane.some( ( st ) => Math.hypot( st.x - x, st.z - z ) < 3.5 ) ) return true;
		return !! this.casaWing && pointInPolygon( x, z, this.casaWing );

	}

	// The narrow way on from the lane by Porta da Vila's flight (the video references/IMG_4350, after OSM's
	// garden walls 299071660 and 299071694): south-west along the curtain between it and a garden's wall,
	// then right between two gardens' walls; whitewashed, a yellow barra along their foot, the gardens'
	// trees leaning over, low kerbs of grey stone across the setts where it steps up
	_pvAlley( materials ) {

		const T = this.terrain, kit = this.kit, plaster = new MeshKit();
		const H = 3.4, TH = 0.4;
		// a wall along pts, H over the ground, its barra following the ground
		const wall = ( pts, seed ) => {

			for ( let i = 0; i + 1 < pts.length; i ++ ) {

				const a = pts[ i ], c = pts[ i + 1 ], L = Math.hypot( c[ 0 ] - a[ 0 ], c[ 1 ] - a[ 1 ] );
				const ux = ( c[ 0 ] - a[ 0 ] ) / L, uz = ( c[ 1 ] - a[ 1 ] ) / L, nx = - uz, nz = ux;
				// (each piece runs on past its ends by half the wall's thickness, closing the corners)
				const A = [ a[ 0 ] - ux * TH / 2, a[ 1 ] - uz * TH / 2 ], C = [ c[ 0 ] + ux * TH / 2, c[ 1 ] + uz * TH / 2 ];
				const ga = T.heightAt( ...a ), gc = T.heightAt( ...c ), base = Math.min( ga, gc ) - 0.6, ta = ga + H, tc = gc + H;
				// (the seed picks the barra's height: about 0.65 m, as in the video)
				plaster.vdata = [ L + TH, 1, ( seed + i * 3 ) / 13.7 + 0.015, 0 ];
				plaster.color = lin( [ 0.76, 0.6, 0.27 ] );
				for ( const s of [ - 1, 1 ] ) {

					const o = s * TH / 2, P = ( q, y ) => [ q[ 0 ] + nx * o, y, q[ 1 ] + nz * o ];
					plaster.quadFacing( P( A, base ), P( C, base ), P( C, tc ), P( A, ta ), [ nx * s, 0, nz * s ],
						[ [ 0, base - ga ], [ L + TH, base - gc ], [ L + TH, H ], [ 0, H ] ] );

				}

				const Q = ( q, o, y ) => [ q[ 0 ] + nx * o, y, q[ 1 ] + nz * o ];
				plaster.quadFacing( Q( A, - TH / 2, ta ), Q( C, - TH / 2, tc ), Q( C, TH / 2, tc ), Q( A, TH / 2, ta ), [ 0, 1, 0 ] );
				if ( i === 0 ) plaster.quadFacing( Q( A, - TH / 2, base ), Q( A, TH / 2, base ), Q( A, TH / 2, ta ), Q( A, - TH / 2, ta ), [ - ux, 0, - uz ] );
				if ( i === pts.length - 2 ) plaster.quadFacing( Q( C, - TH / 2, base ), Q( C, TH / 2, base ), Q( C, TH / 2, tc ), Q( C, - TH / 2, tc ), [ ux, 0, uz ] );
				const top = Math.max( ta, tc );
				this.colliders.addBox( new Vector3( ( a[ 0 ] + c[ 0 ] ) / 2, ( top + base ) / 2, ( a[ 1 ] + c[ 1 ] ) / 2 ), new Vector3( ( L + TH ) / 2, ( top - base ) / 2, TH / 2 ), Math.atan2( - uz, ux ), { walkable: false, tag: 'wall' } );

			}

		};
		// the garden on the right going up (its wall a little in from OSM's line, which leaves the way along
		// the curtain too narrow), and the one on the left past the turn, its wall from the curtain
		wall( [ [ - 75.6, 232.3 ], [ - 76.7, 233.6 ], [ - 84.1, 238.2 ], [ - 89.6, 235.9 ], [ - 95.0, 233.3 ], [ - 102.6, 227.5 ] ], 17 );
		wall( [ [ - 82.3, 242.9 ], [ - 98.6, 236.4 ] ], 41 );
		this.extraTrees = this.extraTrees || [];
		for ( const [ x, z, kind, scale ] of [ [ - 80.2, 231.4, 'garden', 0.9 ], [ - 86.4, 234.2, 'olive', 0.85 ], [ - 92.3, 231.2, 'garden', 1.0 ], [ - 98.6, 228.4, 'garden', 0.85 ], [ - 88.5, 243.6, 'garden', 0.95 ], [ - 95.2, 240.6, 'olive', 0.8 ] ] ) this.extraTrees.push( { kind, x, z, scale } );

		// the kerbs, every 1.9 m along the way, each one long stone, level; narrower along the curtain
		kit.color = [ 0.74, 0.73, 0.7 ];
		let walked = 0, next = 1.2, n = 0;
		for ( let i = 0; i + 1 < PV_ALLEY.length; i ++ ) {

			const a = PV_ALLEY[ i ], c = PV_ALLEY[ i + 1 ], L = Math.hypot( c[ 0 ] - a[ 0 ], c[ 1 ] - a[ 1 ] );
			const ux = ( c[ 0 ] - a[ 0 ] ) / L, uz = ( c[ 1 ] - a[ 1 ] ) / L, yaw = Math.atan2( - uz, ux ), w = i < 2 ? 1.5 : 2.9;
			for ( ; next < walked + L; next += 1.9 ) {

				const d = next - walked, x = a[ 0 ] + ux * d, z = a[ 1 ] + uz * d;
				// (its top a few cm over the ground in front of it, at its middle)
				const top = T.heightAt( x - ux * 0.15, z - uz * 0.15 ) + 0.07;
				let lo = Infinity;
				for ( const r of [ - 1, 0, 1 ] ) lo = Math.min( lo, T.heightAt( x - uz * w / 2 * r, z + ux * w / 2 * r ) );
				kit.vdata = [ 0.53 + n * 0.11, 0.7, 0, 0 ];
				kit.box( x, ( top + lo - 0.2 ) / 2, z, 0.24, top - lo + 0.2, w, yaw, 'bottom' );
				n ++;

			}

			walked += L;

		}

		const mesh = new Mesh( plaster.build(), materials.plaster );
		mesh.name = 'pv-alley';
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.staticVelocity = true;
		this.group.add( mesh );

	}

	// The oratory in Porta da Vila's tower, on the east wall, to the right as you come in through the
	// outer arch (photos references/...-debaixodaportadavila, -entreportas4): a bay hung on the wall from
	// the inner arch's wall to the outer one, a little above the inner arch's head, on three corbels of
	// pale stone. A broad, low arch of pale stone across its front, whitewashed spandrels with grey
	// triangles, a cornice and a lean-to of tiles; inside, a balustrade of stone posts and iron, azulejos
	// on the walls, a painted vault and an altarpiece with a crucifix in a niche. Lanterns on curled
	// brackets either side of the arch and one lower down. Below it the wall is bare stone.
	_oratorio( gate, materials ) {

		const kit = this.kit;
		// the curtain's line on the tower's east side, its normal into the tower, along it (south)
		let at = null;
		const near = ( p ) => Math.hypot( p.x + 47.5, p.z - 230.1 );
		for ( const p of this.curtain.samples ) if ( ! at || near( p ) < near( at ) ) at = p;
		const sg = at.nx < 0 ? 1 : - 1, nx = at.nx * sg, nz = at.nz * sg, tx = nz, tz = - nx;
		const yaw = Math.atan2( - tz, tx );
		// u along the wall, v out from the wall's face into the tower
		const P = ( u, v ) => [ at.x + tx * u + nx * ( W / 2 + v ), at.z + tz * u + nz * ( W / 2 + v ) ];
		const V = ( u, y, v ) => {

			const q = P( u, v );
			return [ q[ 0 ], y, q[ 1 ] ];

		};
		const box = ( k, u0, u1, v0, v1, y0, y1, skip ) => {

			const c = P( ( u0 + u1 ) / 2, ( v0 + v1 ) / 2 );
			k.box( c[ 0 ], ( y0 + y1 ) / 2, c[ 1 ], u1 - u0, y1 - y0, v1 - v0, yaw, skip );

		};
		// from the inner arch's wall (north) to the outer one (south): their faces, a little into each
		const along = ( x, z ) => ( x - at.x ) * tx + ( z - at.z ) * tz;
		const uL = along( - 49, 226.15 ), uR = along( - 49, 234.25 ), D = 2.3, END = 0.25;
		const uc = ( uL + uR ) / 2, half = ( uR - uL ) / 2 - END;
		// heights: the floor a little above the inner arch's head
		const yB = gate.y + 4.6, yS = yB + 1.8;
		const rise = 2.6, r = ( half * half + rise * rise ) / ( 2 * rise ), cy = yS + rise - r; // the arch: a segment
		const th = Math.atan2( yS - cy, half );
		const yF = yS + rise + 0.6, yE = yF + 0.32, yR = yE + 0.65, y0 = yB - 0.3; // the cornice, the eaves, the roof's back, the floor's underside
		const plaster = new MeshKit(), roof = new MeshKit(), lamps = new MeshKit();
		const WHITE = [ 6, 1, 0.53, 0 ], TILES = [ yB, yS, 0.53, 2 ], VAULT = [ 0, 0, 0.53, 3 ], PAINT = [ 0, 0, 0.53, 4 ];
		const GREY = lin( [ 0.58, 0.6, 0.61 ] ), STONE = lin( [ 0.88, 0.84, 0.74 ] );
		const out = [ nx, 0, nz ], N = 20;
		const arc = ( rr, k ) => {

			const a = Math.PI - th - ( Math.PI - 2 * th ) * k / N;
			return [ uc + rr * Math.cos( a ), cy + rr * Math.sin( a ), a ];

		};
		// the whole bay is out of reach, but solid, so nothing walks into it from the wall walk
		const cb = P( uc, D / 2 );
		this.colliders.addBox( new Vector3( cb[ 0 ], ( y0 + yR ) / 2, cb[ 1 ] ), new Vector3( ( uR - uL ) / 2, ( yR - y0 ) / 2, D / 2 + 0.15 ), yaw, { walkable: false, tag: 'oratorio' } );

		// the floor, its front a moulding of pale stone, on three corbels
		plaster.vdata = WHITE;
		box( plaster, uL, uR, 0, D, y0, yB );
		plaster.vdata = PAINT;
		plaster.color = STONE;
		box( plaster, uL, uR, D - 0.05, D + 0.12, y0 - 0.05, yB );
		for ( const u of [ uc - 2.4, uc, uc + 2.4 ] ) {

			box( plaster, u - 0.2, u + 0.2, 0, D - 0.1, y0 - 0.3, y0, 'bottom' );
			box( plaster, u - 0.15, u + 0.15, 0, D - 0.45, y0 - 0.75, y0 - 0.3, 'bottom' );

		}

		// the ends: azulejos on the walls either side, up to the springing, and short piers of stone in front
		for ( const [ u, s ] of [ [ uL, 1 ], [ uR, - 1 ] ] ) {

			plaster.vdata = TILES;
			box( plaster, Math.min( u, u + s * 0.02 ), Math.max( u, u + s * 0.02 ), 0, D, yB, yS, 'bottom' );
			plaster.vdata = PAINT;
			plaster.color = STONE;
			box( plaster, Math.min( u, u + s * ( END + 0.12 ) ), Math.max( u, u + s * ( END + 0.12 ) ), D - 0.1, D + 0.05, yB, yS + 0.08, 'bottom' );

		}

		// the front above the springing: whitewashed spandrels and the band of pale stone round the arch
		const RO = r + 0.22, [ eL, fL ] = arc( RO, 0 ), [ eR, fR ] = arc( RO, N );
		plaster.vdata = WHITE;
		plaster.quadFacing( V( uL, yS, D ), V( eL, yS, D ), V( eL, yF, D ), V( uL, yF, D ), out );
		plaster.quadFacing( V( eR, yS, D ), V( uR, yS, D ), V( uR, yF, D ), V( eR, yF, D ), out );
		for ( let k = 0; k < N; k ++ ) {

			const [ ua, ya ] = arc( RO, k ), [ ub, yb ] = arc( RO, k + 1 );
			plaster.vdata = WHITE;
			plaster.quadFacing( V( ua, ya, D ), V( ub, yb, D ), V( ub, yF, D ), V( ua, yF, D ), out, [ [ ua, ya ], [ ub, yb ], [ ub, yF ], [ ua, yF ] ] );
			const [ ia, ja ] = arc( r, k ), [ ib, jb, m ] = arc( r, k + 0.5 ), [ ic, jc ] = arc( r, k + 1 );
			plaster.vdata = PAINT;
			plaster.color = STONE;
			plaster.quadFacing( V( ia, ja, D + 0.05 ), V( ic, jc, D + 0.05 ), V( ub, yb, D + 0.05 ), V( ua, ya, D + 0.05 ), out );
			plaster.quadFacing( V( ia, ja, D - 0.15 ), V( ic, jc, D - 0.15 ), V( ic, jc, D + 0.05 ), V( ia, ja, D + 0.05 ), [ - Math.cos( m ) * tx, - Math.sin( m ), - Math.cos( m ) * tz ] );
			// the vault, painted, and the lunette of azulejos under it on the wall
			plaster.vdata = VAULT;
			plaster.quadFacing( V( ia, ja, 0 ), V( ic, jc, 0 ), V( ic, jc, D - 0.15 ), V( ia, ja, D - 0.15 ), [ - Math.cos( m ) * tx, - Math.sin( m ), - Math.cos( m ) * tz ],
				[ [ r * k / N * 3, 0 ], [ r * ( k + 1 ) / N * 3, 0 ], [ r * ( k + 1 ) / N * 3, D ], [ r * k / N * 3, D ] ] );
			plaster.vdata = TILES;
			plaster.quadFacing( V( ia, yS, 0.02 ), V( ic, yS, 0.02 ), V( ic, jc, 0.02 ), V( ia, ja, 0.02 ), out, [ [ ia, yS ], [ ic, yS ], [ ic, jc ], [ ia, ja ] ] );

		}

		// the gaps between the ring's ends and the springing, the keystone, grey triangles in the spandrels
		plaster.vdata = PAINT;
		plaster.color = STONE;
		box( plaster, uL, eL + 0.05, D - 0.1, D + 0.05, yS, fL, 'bottom' );
		box( plaster, eR - 0.05, uR, D - 0.1, D + 0.05, yS, fR, 'bottom' );
		box( plaster, uc - 0.2, uc + 0.2, D - 0.05, D + 0.12, yS + rise - 0.15, yS + rise + 0.45 );
		plaster.color = GREY;
		for ( const s of [ - 1, 1 ] ) {

			const u0 = s < 0 ? uL + 0.3 : uR - 0.3, u1 = u0 - s * 1.3, ya = yF - 0.18;
			plaster.quadFacing( V( u0, ya, D + 0.01 ), V( u1, ya, D + 0.01 ), V( u0, ya - 0.9, D + 0.01 ), V( u0, ya - 0.9, D + 0.01 ), out );

		}

		// azulejos on the wall behind the balcony, the cornice, and the lean-to of tiles back to the wall
		plaster.vdata = TILES;
		box( plaster, uL, uR, 0, 0.02, yB, yS );
		plaster.vdata = PAINT;
		plaster.color = STONE;
		box( plaster, uL, uR, D - 0.1, D + 0.12, yF - 0.08, yF + 0.1 );
		box( plaster, uL, uR, D - 0.1, D + 0.28, yF + 0.1, yE );
		const vE = D + 0.45;
		roof.vdata = [ 0.71, 0.6, 0, 0 ];
		roof.color = [ 1, 1, 1 ];
		const slope = Math.hypot( vE, yR - yE );
		roof.quadFacing( V( uL, yR, 0 ), V( uR, yR, 0 ), V( uR, yE, vE ), V( uL, yE, vE ), [ 0, 1, 0 ],
			[ [ 0, 0 ], [ uR - uL, 0 ], [ uR - uL, slope ], [ 0, slope ] ] );
		plaster.vdata = WHITE;
		plaster.quadFacing( V( uL, yE - 0.06, D + 0.28 ), V( uR, yE - 0.06, D + 0.28 ), V( uR, yE - 0.06, vE ), V( uL, yE - 0.06, vE ), [ 0, - 1, 0 ] );
		plaster.quadFacing( V( uL, yE - 0.06, vE ), V( uR, yE - 0.06, vE ), V( uR, yE, vE ), V( uL, yE, vE ), out );
		// the roof's sides, against the two walls (in case of a gap)
		for ( const [ u, f ] of [ [ uL, - 1 ], [ uR, 1 ] ] ) plaster.quadFacing( V( u, yF, 0 ), V( u, yE, vE ), V( u, yR, 0 ), V( u, yR, 0 ), [ tx * f, 0, tz * f ] );

		// the balustrade along the front: posts of pale stone, iron between them, a stone rail on top
		const rail = D - 0.2, rh = 1.0, bL = uL + END + 0.12, bR = uR - END - 0.12;
		const posts = 6;
		plaster.vdata = PAINT;
		plaster.color = STONE;
		for ( let i = 0; i <= posts; i ++ ) {

			const u = bL + 0.1 + ( bR - bL - 0.2 ) * i / posts;
			box( plaster, u - 0.1, u + 0.1, rail - 0.1, rail + 0.1, yB, yB + rh - 0.06, 'bottom' );

		}

		box( plaster, bL, bR, rail - 0.11, rail + 0.11, yB + rh - 0.06, yB + rh, 'bottom' );
		kit.vdata = [ 0.29, 0.2, 0, 0 ];
		kit.color = [ 0.07, 0.07, 0.07 ]; // iron
		box( kit, bL, bR, rail - 0.015, rail + 0.015, yB + 0.1, yB + 0.14 );
		box( kit, bL, bR, rail - 0.015, rail + 0.015, yB + rh - 0.2, yB + rh - 0.16 );
		for ( let u = bL + 0.08; u < bR; u += 0.11 ) box( kit, u - 0.01, u + 0.01, rail - 0.01, rail + 0.01, yB, yB + rh - 0.06 );

		// the altarpiece: a table, two columns on pedestals, an entablature and a pediment with a cross,
		// the niche between the columns (dark, round-headed) with the crucifix
		plaster.vdata = PAINT;
		plaster.color = STONE;
		box( plaster, uc - 0.75, uc + 0.75, 0.02, 0.6, yB, yB + 0.95 );
		for ( const s of [ - 1, 1 ] ) {

			box( plaster, uc + s * 0.72 - 0.16, uc + s * 0.72 + 0.16, 0.02, 0.32, yB + 0.95, yB + 1.3 );
			box( plaster, uc + s * 0.72 - 0.1, uc + s * 0.72 + 0.1, 0.06, 0.26, yB + 1.3, yB + 2.75 );

		}

		box( plaster, uc - 0.6, uc + 0.6, 0.02, 0.12, yB + 0.95, yB + 2.75 ); // the niche's frame
		box( plaster, uc - 1.0, uc + 1.0, 0.02, 0.34, yB + 2.75, yB + 3.0 );
		[ [ 1.6, 0.14 ], [ 1.1, 0.14 ], [ 0.6, 0.12 ] ].reduce( ( y, [ w, h ] ) => ( box( plaster, uc - w / 2, uc + w / 2, 0.02, 0.22, y, y + h ), y + h ), yB + 3.0 );
		box( plaster, uc - 0.04, uc + 0.04, 0.1, 0.18, yB + 3.4, yB + 3.75 ); // the cross on the pediment
		box( plaster, uc - 0.13, uc + 0.13, 0.1, 0.18, yB + 3.56, yB + 3.63 );
		kit.vdata = [ 0.29, 0, 0, 0 ];
		kit.color = [ 0.32, 0.22, 0.14 ]; // the niche's warm, shadowed hollow
		box( kit, uc - 0.42, uc + 0.42, 0.12, 0.13, yB + 1.05, yB + 2.3 );
		[ [ 0.7, 0.14 ], [ 0.42, 0.12 ] ].reduce( ( y, [ w, h ] ) => ( box( kit, uc - w / 2, uc + w / 2, 0.12, 0.13, y, y + h ), y + h ), yB + 2.3 );
		kit.color = [ 0.12, 0.08, 0.05 ]; // the cross, dark wood
		box( kit, uc - 0.03, uc + 0.03, 0.18, 0.23, yB + 1.05, yB + 2.2 );
		box( kit, uc - 0.26, uc + 0.26, 0.18, 0.23, yB + 1.86, yB + 1.92 );
		kit.color = [ 1.3, 1.2, 1.0 ]; // the figure
		box( kit, uc - 0.05, uc + 0.05, 0.23, 0.28, yB + 1.4, yB + 1.86 );
		box( kit, uc - 0.22, uc + 0.22, 0.23, 0.26, yB + 1.8, yB + 1.85 );
		kit.color = [ 1.4, 0.5, 0.7 ]; // flowers on the altar
		for ( const u of [ uc - 0.45, uc, uc + 0.45 ] ) box( kit, u - 0.1, u + 0.1, 0.25, 0.45, yB + 0.95, yB + 1.2 );

		// lanterns: on curled iron brackets either side of the arch, and one lower on the outer arch's wall
		const warm = new Color( 1.0, 0.66, 0.36 );
		const lantern = ( lx, ly, lz, ax, az, len ) => {

			lamps.vdata = [ 0, 0, 0, 0 ];
			lamps.box( lx - ax * len / 2, ly + 0.36, lz - az * len / 2, len, 0.04, 0.04, Math.atan2( - az, ax ) );
			lamps.box( lx - ax * len * 0.6, ly + 0.2, lz - az * len * 0.6, 0.04, 0.32, 0.04, Math.atan2( - az, ax ) );
			lamps.box( lx, ly + 0.27, lz, 0.34, 0.07, 0.34, yaw );
			lamps.box( lx, ly + 0.36, lz, 0.14, 0.12, 0.14, yaw );
			lamps.box( lx, ly - 0.27, lz, 0.24, 0.06, 0.24, yaw );
			lamps.vdata = [ 1, 0, 0, 0 ];
			lamps.box( lx, ly, lz, 0.28, 0.48, 0.28, yaw, 'top bottom' );
			this.lights.push( { position: new Vector3( lx, ly - 0.05, lz ), color: warm, intensity: 8, range: 14, kind: 'lantern', flicker: 0.05 } );

		};
		for ( const [ u, s ] of [ [ uL, 1 ], [ uR, - 1 ] ] ) {

			const [ x, z ] = P( u + s * 0.55, D + 0.55 );
			lantern( x, yS - 0.15, z, nx, nz, 0.7 );

		}

		const [ lx, lz ] = P( uR - 0.45, 0.7 );
		lantern( lx, yB - 1.6, lz, - tx, - tz, 0.45 );

		for ( const [ k, mat, name, shadow ] of [ [ plaster, materials.plaster, 'oratorio', true ], [ roof, materials.roof, 'oratorio-roof', true ], [ lamps, materials.lantern, 'oratorio-lanterns', false ] ] ) {

			const mesh = new Mesh( k.build(), mat );
			mesh.name = name;
			mesh.castShadow = shadow;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// The tower's north-east corner, after the views: the curtain along the tower's east side runs on north
	// to the town wall's line, and from there straight on east to meet its own line again, where the OSM
	// way bulges south (profile points 519-522, kept apart by their positions here). The profile is
	// edited in place: the bulge's points out, the corner and the straight run in, arc lengths again.
	_pvCurtainCorner( wall ) {

		const P = wall.pts;
		const near = ( x, z ) => P.findIndex( ( p ) => Math.hypot( p.x - x, p.z - z ) < 0.5 );
		const i0 = near( - 47.13, 227.67 ), i1 = near( - 41, 224.86 ); // the bulge's first point, its way out
		if ( i0 < 0 || i1 < 0 || i1 <= i0 ) return;
		const run = [ [ - 46.95, 225.42 ], [ - 44.97, 225.23 ], [ - 42.98, 225.05 ] ];
		const a = P[ i0 - 1 ], b = P[ i1 ];
		const pts = run.map( ( [ x, z ], k ) => ( { ...a, x, z, top: a.top + ( b.top - a.top ) * ( k + 1 ) / ( run.length + 1 ) } ) );
		P.splice( i0, i1 - i0, ...pts );
		// arc lengths, and the normals along the new stretch (outward, as the profile's)
		for ( let i = 1; i < P.length; i ++ ) P[ i ].s = P[ i - 1 ].s + Math.hypot( P[ i ].x - P[ i - 1 ].x, P[ i ].z - P[ i - 1 ].z );
		for ( let i = i0 - 1; i <= i0 + run.length; i ++ ) {

			const p = P[ i ], q = P[ i - 1 ], r = P[ i + 1 ];
			let dx = r.x - q.x, dz = r.z - q.z;
			const L = Math.hypot( dx, dz ) || 1;
			dx /= L; dz /= L;
			Object.assign( p, { dx, dz, nx: dz * wall.outward, nz: - dx * wall.outward } );

		}

		wall.length = P[ P.length - 1 ].s;

	}

	// Porta do Vale's covered passage (photos references/...-porta-nordeste-1, -img-4402, -altar and the
	// ceiling from inside; OSM's building passage): one tall whitewashed hall behind the curtain, running
	// north from the Oratório at its south end to an arch out into the town. In through the gate on its
	// east side, a foot of rough stone along the west wall ahead and a balcony window high in it. A coved
	// ceiling of boards (flat in the middle, sloping to the walls) on battens with two iron ties, a small
	// barred window high in each side by the chapel, a lantern hung in front of it; at the north end, over
	// the way out (an arch of rough stone), a narrow loft of dark wood on raking struts. The chapel:
	// pilasters on pink bases, an arch with a pink keystone and an entablature round its opening, a stone
	// cornice under it over a sunk panel, a tall iron grille; inside, under a vault, the altar with a cross,
	// the retable (columns on pink pedestals, a niche of azulejos with the image, a broken pediment and a
	// cartouche). A block of masonry round it all, its top over the wall walk.
	_valePassage( materials ) {

		const g = this.terrain.gates.find( ( q ) => Math.hypot( q.x - VALE_GATE[ 0 ], q.z - VALE_GATE[ 1 ] ) < 2 );
		if ( ! g || ! g.frame ) return;
		const T = this.terrain, kit = this.kit, f = g.frame;
		// u along the curtain, north (to the way out); v from its line into the town
		const sg = f.tx * 0.44 - f.tz * 0.9 > 0 ? 1 : - 1, tx = f.tx * sg, tz = f.tz * sg, nx = f.nx, nz = f.nz;
		const P = ( u, v ) => [ g.x + tx * u - nx * v, g.z + tz * u - nz * v ];
		const V3 = ( u, y, v ) => {

			const q = P( u, v );
			return [ q[ 0 ], y, q[ 1 ] ];

		};
		const ground = ( u, v ) => T.heightAt( ...P( u, v ) );
		const yaw = Math.atan2( - tz, tx );
		const alongU = [ tx, 0, tz ], intoV = [ - nx, 0, - nz ];
		const dir = ( a, b ) => [ a[ 0 ] * b, a[ 1 ] * b, a[ 2 ] * b ];
		const north = alongU, south = dir( alongU, - 1 ), west = intoV, east = dir( intoV, - 1 );
		// the hall from the curtain's back (V0) to its west wall (V2), from the chapel's wall (u = -R) to its
		// end wall (UE to U2); the walls TH thick
		// (the hall is wide: photo references/...-img-4407; the way out a vaulted passage 2.5 m through the end
		// wall: -img-4408)
		const R = g.R, V0 = W / 2, V2 = 7.0, VM = ( V0 + V2 ) / 2, UE = 4.5, U2 = UE + 2.5, TH = 1.2;
		let gHi = - Infinity, gLo = Infinity;
		for ( const [ u, v ] of [ [ - R, V0 ], [ - R, V2 ], [ 0, V2 ], [ UE, V0 ], [ UE, V2 ] ] ) {

			gHi = Math.max( gHi, ground( u, v ) ); gLo = Math.min( gLo, ground( u, v ) );

		}

		let walk = - Infinity;
		for ( const p of this.curtain.samples ) if ( p.gate === g ) walk = Math.max( walk, p.y );
		// the walls' height S (where the coved ceiling springs), its flat middle C
		// (the block about 8.5 m over the street at the way out: photo references/...-img-4408)
		const S = gHi + 6.15, C = S + 1.0, top = C + 0.3, base = gLo - 0.8;
		const crown = g.y + g.spring + g.flat;
		// the way out, VE in (where OSM's passage comes out); a path of big slabs runs to it (Town lays them)
		const VE = 5.7 - R;
		// (out of it the path bends right, down the street: photo references/...-img-4408)
		this.valePath = [ P( - 0.6, VE ), P( U2, VE ), P( U2 + 0.9, VE - 0.25 ), P( U2 + 1.8, VE - 0.8 ), P( U2 + 2.8, VE - 1.1 ), P( U2 + 4, VE - 1.0 ) ];
		const cw = V2 - V0, cove = [ [ V0, S ], [ V0 + 0.3 * cw, C ], [ V2 - 0.3 * cw, C ], [ V2, S ] ];
		const coveY = ( v ) => {

			for ( let k = 0; k + 1 < cove.length; k ++ ) if ( v <= cove[ k + 1 ][ 0 ] ) return cove[ k ][ 1 ] + ( cove[ k + 1 ][ 1 ] - cove[ k ][ 1 ] ) * ( v - cove[ k ][ 0 ] ) / ( cove[ k + 1 ][ 0 ] - cove[ k ][ 0 ] );
			return S;

		};

		// the chapel: its opening hwC either side of VM, from the cornice (yF) to the pilasters' capitals (spA,
		// where its arch springs); inside, deeper than the wall, a taller vault (springing at spR) back to uB
		const gC = ground( - R, VM ), yF = gC + 2.5, hwC = 1.15, spA = yF + 2.12, spR = spA + 0.6, uW = - R - TH, uB = uW - 1.8;

		// the masonry
		const box = ( k, u0, u1, v0, v1, y0, y1, skip ) => {

			const c = P( ( u0 + u1 ) / 2, ( v0 + v1 ) / 2 );
			k.box( c[ 0 ], ( y0 + y1 ) / 2, c[ 1 ], u1 - u0, y1 - y0, v1 - v0, yaw, skip );

		};
		const solid = ( u0, u1, v0, v1, y0, y1, walkable = false ) => {

			const c = P( ( u0 + u1 ) / 2, ( v0 + v1 ) / 2 );
			this.colliders.addBox( new Vector3( c[ 0 ], ( y0 + y1 ) / 2, c[ 1 ] ), new Vector3( ( u1 - u0 ) / 2, ( y1 - y0 ) / 2, ( v1 - v0 ) / 2 ), yaw, { walkable, tag: 'wall' } );

		};
		const mass = ( u0, u1, v0, v1, y0, y1, collide = true ) => {

			box( kit, u0, u1, v0, v1, y0, y1 );
			if ( collide ) solid( u0, u1, v0, v1, y0, y1 );

		};
		kit.vdata = [ 0.41, 0.8, 0, 0 ];
		kit.color = [ 1, 1, 1 ];
		mass( uW, U2, V2, V2 + TH, base, S ); // west
		if ( walk - 0.2 < S ) mass( uW, U2, V0 - 0.6, V0, walk - 0.2, S ); // east, over the curtain's walk (it climbs past S to the tower)
		// the chapel's wall, round its opening
		mass( uW, - R, V0, V2 + TH, base, yF );
		mass( uW, - R, V0, VM - hwC, yF, S );
		mass( uW, - R, VM + hwC, V2 + TH, yF, S );
		mass( uW, - R, VM - hwC, VM + hwC, spA + hwC, S, false );
		// the chapel's own masonry behind it
		const cs = hwC + 0.8;
		mass( uB - 0.8, uW, VM - cs, VM + cs, base, yF );
		mass( uB - 0.8, uB, VM - cs, VM + cs, yF, S, false );
		mass( uB, uW, VM - cs, VM - hwC, yF, S, false );
		mass( uB, uW, VM + hwC, VM + cs, yF, S, false );
		if ( S > spR + hwC ) mass( uB, uW, VM - hwC, VM + hwC, spR + hwC, S, false );
		// the roof over it all
		box( kit, uB - 0.8, U2, V0 - 0.6, V2 + TH, S, top, 'bottom' );
		solid( uB - 0.8, U2, V0 - 0.6, V2 + TH, S, top, true );

		const plaster = new MeshKit(), lamps = new MeshKit(), tiles = new MeshKit();
		// and on it a gabled roof of tiles, its ridge along the hall, its white gable set back behind the way
		// out's stone face (photo references/...-1703-img-4410)
		{

			const r0 = uB - 0.5, r1 = U2 - 1.1, e0 = V0 - 0.3, e1 = V2 + TH - 0.3, vr = ( e0 + e1 ) / 2, yr = top + 1.6;
			const slope = Math.hypot( vr - e0, yr - top ), L = r1 - r0;
			tiles.vdata = [ 0.71, 0.6, 0, 0 ];
			tiles.color = [ 1, 1, 1 ];
			tiles.quadFacing( V3( r0, top, e0 ), V3( r1, top, e0 ), V3( r1, yr, vr ), V3( r0, yr, vr ), [ 0, 1, 0 ], [ [ 0, slope ], [ L, slope ], [ L, 0 ], [ 0, 0 ] ] );
			tiles.quadFacing( V3( r0, top, e1 ), V3( r1, top, e1 ), V3( r1, yr, vr ), V3( r0, yr, vr ), [ 0, 1, 0 ], [ [ 0, slope ], [ L, slope ], [ L, 0 ], [ 0, 0 ] ] );
			plaster.vdata = [ 0, 0, 0.53, 4 ];
			plaster.color = lin( [ 0.93, 0.92, 0.89 ] );
			plaster.quadFacing( V3( r1, top - 0.05, e0 ), V3( r1, top - 0.05, e1 ), V3( r1, yr, vr ), V3( r1, yr, vr ), north );
			plaster.quadFacing( V3( r0, top - 0.05, e0 ), V3( r0, top - 0.05, e1 ), V3( r0, yr, vr ), V3( r0, yr, vr ), south );

		}
		const WOOD = lin( [ 0.88, 0.58, 0.38 ] ), BEAM = lin( [ 0.48, 0.4, 0.32 ] ), CREAM = lin( [ 0.9, 0.87, 0.8 ] ), PINK = lin( [ 0.82, 0.5, 0.42 ] ), STONE = lin( [ 0.72, 0.7, 0.64 ] ), FOOT = lin( [ 0.52, 0.5, 0.47 ] );
		const paint = ( c ) => {

			plaster.vdata = [ 0, 0, 0.53, 4 ];
			plaster.color = c;

		};
		const wood = ( c, seed = 0.3 ) => {

			plaster.vdata = [ 0, 0, seed, 5 ];
			plaster.color = c;

		};
		lamps.vdata = [ 0, 0, 0, 0 ];
		const E = 0.01;

		// whitewash over a grey foot, between a and b ([ u, v ]) from y0 (the floor, if null) up to y1
		const wash = ( a, b, y0, y1, nrm ) => {

			// (heights over the floor at each end, so the foot follows it)
			const fa = ground( ...a ), fb = ground( ...b ), ga = y0 ?? fa - 0.3, gb = y0 ?? fb - 0.3, L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
			const ya = typeof y1 === 'function' ? y1( a ) : y1, yb = typeof y1 === 'function' ? y1( b ) : y1;
			plaster.vdata = [ L, 0, 0.47, 0 ];
			plaster.color = FOOT;
			plaster.quadFacing( V3( a[ 0 ], ga, a[ 1 ] ), V3( b[ 0 ], gb, b[ 1 ] ), V3( b[ 0 ], yb, b[ 1 ] ), V3( a[ 0 ], ya, a[ 1 ] ), nrm,
				[ [ 0, ga - fa ], [ L, gb - fb ], [ L, yb - fb ], [ 0, ya - fa ] ] );

		};
		// a wall across the hall (at u, facing nrm) from V0 to V2, up to the ceiling, with an arched hole: half
		// width a about vh, springing at ya, its sill at ys (the floor, if null)
		const archWall = ( u, nrm, vh, a, ya, ys, outer ) => {

			const vs = [ V0, cove[ 1 ][ 0 ], cove[ 2 ][ 0 ], V2, vh - a, vh + a ];
			for ( let k = 1; k < 16; k ++ ) vs.push( vh - a + 2 * a * k / 16 );
			vs.sort( ( p, q ) => p - q );
			const archY = ( v ) => ya + Math.sqrt( Math.max( 0, a * a - ( v - vh ) ** 2 ) );
			for ( let k = 0; k + 1 < vs.length; k ++ ) {

				const va = vs[ k ], vb = vs[ k + 1 ];
				if ( vb - va < 1e-4 ) continue;
				const open = Math.abs( ( va + vb ) / 2 - vh ) < a;
				if ( ! open ) wash( [ u, va ], [ u, vb ], null, ( q ) => coveY( q[ 1 ] ), nrm );
				else {

					// over the arch to the ceiling, and under it to the sill
					const L = vb - va;
					plaster.vdata = [ L, 0, 0.47, 0 ];
					plaster.color = FOOT;
					plaster.quadFacing( V3( u, archY( va ), va ), V3( u, archY( vb ), vb ), V3( u, coveY( vb ), vb ), V3( u, coveY( va ), va ), nrm, [ [ 0, 9 ], [ L, 9 ], [ L, 9 ], [ 0, 9 ] ] );
					if ( ys !== null ) wash( [ u, va ], [ u, vb ], null, ys, nrm );
					if ( outer ) outer( va, vb, archY( va ), archY( vb ) );

				}

			}

		};

		// the west wall, a foot of rough stone along it; the east wall, the curtain's back, over the gate
		wash( [ - R, V2 - E ], [ UE, V2 - E ], null, S, east );
		wash( [ R, V0 + E ], [ UE, V0 + E ], null, S, west );
		plaster.vdata = [ 2 * R, 0, 0.47, 0 ];
		plaster.color = FOOT;
		plaster.quadFacing( V3( - R, crown, V0 + E ), V3( R, crown, V0 + E ), V3( R, S, V0 + E ), V3( - R, S, V0 + E ), west, [ [ 0, 5 ], [ 2 * R, 5 ], [ 2 * R, 9 ], [ 0, 9 ] ] );
		kit.vdata = [ 0.53, 0.5, 0, 0 ];
		for ( let u = - R; u < UE - 1e-3; u += 1 ) {

			const u1 = Math.min( UE, u + 1 ), ga = ground( u, V2 ), gb = ground( u1, V2 );
			kit.quadFacing( V3( u, ga - 0.3, V2 - 0.03 ), V3( u1, gb - 0.3, V2 - 0.03 ), V3( u1, gb + 0.45, V2 - 0.03 ), V3( u, ga + 0.45, V2 - 0.03 ), east );

		}

		// the balcony window high in the west wall, across from the gate: an arch of carved stone with a pink
		// keystone over a dark door, a stone sill, a railing of wrought iron
		{

			const back = ( u0, u1, y0, y1, k = 0.015 ) => plaster.quadFacing( V3( u0, y0, V2 - k ), V3( u1, y0, V2 - k ), V3( u1, y1, V2 - k ), V3( u0, y1, V2 - k ), east );
			const ub = 0.35, gB = ground( 0, V2 ), sill = gB + 2.4, hw = 0.95, spring = sill + 1.15, ro = 0.95, ri = 0.75;
			paint( lin( [ 0.78, 0.77, 0.74 ] ) );
			back( ub - ri, ub + ri, sill, spring, 0.016 );
			for ( let k = 0; k < 12; k ++ ) {

				const t0 = Math.PI * k / 12, t1 = Math.PI * ( k + 1 ) / 12, p = ( r, t ) => V3( ub + r * Math.cos( t ), spring + r * Math.sin( t ), V2 - 0.016 );
				plaster.quadFacing( p( 0, t0 ), p( ri, t0 ), p( ri, t1 ), p( 0, t1 ), east );

			}

			paint( lin( [ 0.08, 0.08, 0.08 ] ) );
			back( ub - 0.3, ub + 0.3, sill, sill + 1.5, 0.02 );
			paint( STONE );
			for ( let k = 0; k < 12; k ++ ) {

				const t0 = Math.PI * k / 12, t1 = Math.PI * ( k + 1 ) / 12, p = ( r, t ) => V3( ub + r * Math.cos( t ), spring + r * Math.sin( t ), V2 - 0.04 );
				plaster.quadFacing( p( ri, t0 ), p( ro, t0 ), p( ro, t1 ), p( ri, t1 ), east );

			}

			box( plaster, ub - ro, ub - ri, V2 - 0.04, V2, sill, spring );
			box( plaster, ub + ri, ub + ro, V2 - 0.04, V2, sill, spring );
			box( plaster, ub - hw - 0.25, ub + hw + 0.25, V2 - 0.3, V2, sill - 0.14, sill );
			paint( PINK );
			box( plaster, ub - 0.13, ub + 0.13, V2 - 0.1, V2, spring + ri - 0.05, spring + ro + 0.12 );
			const vr = V2 - 0.27;
			for ( const y of [ sill + 0.05, sill + 0.55, sill + 1.05 ] ) ironBar( lamps, V3( ub - hw, y, vr ), V3( ub + hw, y, vr ), 0.025 );
			for ( let u = ub - hw; u <= ub + hw + 1e-3; u += 0.19 ) ironBar( lamps, V3( u, sill, vr ), V3( u, sill + 1.05, vr ), 0.018 );
			for ( const u of [ ub - hw, ub + hw ] ) ironBar( lamps, V3( u, sill + 0.05, V2 ), V3( u, sill + 0.05, vr ), 0.025 );

		}

		// a small barred window high in each side wall by the chapel
		for ( const [ vf, nrm, s ] of [ [ V2 - E, east, - 1 ], [ V0 + E, west, 1 ] ] ) {

			const uw = - R + 0.7, yw = S - 1.1, d = ( k ) => vf + s * k;
			const rect = ( hu, hy, k ) => plaster.quadFacing( V3( uw - hu, yw - hy, d( k ) ), V3( uw + hu, yw - hy, d( k ) ), V3( uw + hu, yw + hy, d( k ) ), V3( uw - hu, yw + hy, d( k ) ), nrm );
			paint( CREAM );
			rect( 0.38, 0.45, 0.005 );
			paint( lin( [ 0.95, 0.95, 0.93 ] ) );
			rect( 0.24, 0.31, 0.01 );
			for ( const k of [ - 1, 0, 1 ] ) ironBar( lamps, V3( uw + k * 0.08, yw - 0.31, d( 0.03 ) ), V3( uw + k * 0.08, yw + 0.31, d( 0.03 ) ), 0.02 );
			for ( const k of [ - 1, 1 ] ) ironBar( lamps, V3( uw - 0.24, yw + k * 0.1, d( 0.03 ) ), V3( uw + 0.24, yw + k * 0.1, d( 0.03 ) ), 0.02 );

		}

		// the coved ceiling over the whole hall: boards along it, battens across every 0.45 m, two iron ties
		let acc = 0;
		for ( let k = 0; k + 1 < cove.length; k ++ ) {

			const [ va, ya ] = cove[ k ], [ vb, yb ] = cove[ k + 1 ], L = Math.hypot( vb - va, yb - ya );
			let mv = - ( yb - ya ), my = vb - va;
			if ( my > 0 ) { mv = - mv; my = - my; }
			const nl = Math.hypot( mv, my ), nrm = [ intoV[ 0 ] * mv / nl, my / nl, intoV[ 2 ] * mv / nl ];
			wood( WOOD );
			plaster.quadFacing( V3( - R, ya, va ), V3( UE, ya, va ), V3( UE, yb, vb ), V3( - R, yb, vb ), nrm, [ [ acc, - R ], [ acc, UE ], [ acc + L, UE ], [ acc + L, - R ] ] );
			acc += L;
			wood( lin( [ 0.76, 0.5, 0.32 ] ), 0.5 );
			const o = [ nrm[ 0 ] * 0.05, nrm[ 1 ] * 0.05, nrm[ 2 ] * 0.05 ], add = ( p ) => [ p[ 0 ] + o[ 0 ], p[ 1 ] + o[ 1 ], p[ 2 ] + o[ 2 ] ];
			for ( let u = - R + 0.3; u < UE - 0.1; u += 0.45 ) {

				const a0 = V3( u - 0.035, ya, va ), a1 = V3( u + 0.035, ya, va ), b0 = V3( u - 0.035, yb, vb ), b1 = V3( u + 0.035, yb, vb );
				plaster.quadFacing( add( a0 ), add( a1 ), add( b1 ), add( b0 ), nrm, [ [ 0, 0 ], [ 0.07, 0 ], [ 0.07, L ], [ 0, L ] ] );
				plaster.quadFacing( a0, add( a0 ), add( b0 ), b0, south );
				plaster.quadFacing( a1, add( a1 ), add( b1 ), b1, north );

			}

		}

		for ( const u of [ - R + 1.6, R + 0.2 ] ) ironBar( lamps, V3( u, S + 0.1, V0 ), V3( u, S + 0.1, V2 ), 0.025 );

		// at the north end, over the way out, a narrow loft of dark wood (photo references/...-img-4406): beams
		// across under its boards, a plank along its edge on two raking struts down to stone corbels in the side
		// walls, a railing of plain square balusters; over it, high in the end wall, a small barred window
		const yL = ground( U2, VE ) + 5.2, uJ = UE - 2.0;
		wood( lin( [ 0.42, 0.3, 0.22 ] ), 0.6 );
		plaster.quadFacing( V3( uJ, yL, V0 ), V3( UE, yL, V0 ), V3( UE, yL, V2 ), V3( uJ, yL, V2 ), [ 0, - 1, 0 ], [ [ V0, uJ ], [ V0, UE ], [ V2, UE ], [ V2, uJ ] ] );
		plaster.quadFacing( V3( uJ, yL + 0.12, V0 ), V3( UE, yL + 0.12, V0 ), V3( UE, yL + 0.12, V2 ), V3( uJ, yL + 0.12, V2 ), [ 0, 1, 0 ], [ [ V0, uJ ], [ V0, UE ], [ V2, UE ], [ V2, uJ ] ] );
		wood( BEAM, 0.8 );
		box( plaster, uJ, uJ + 0.25, V0, V2, yL - 0.3, yL + 0.15 );
		for ( const u of [ uJ + 0.6, uJ + 1.1, uJ + 1.6 ] ) box( plaster, u - 0.1, u + 0.1, V0, V2, yL - 0.22, yL );
		for ( const v of [ V0 + 0.14, V2 - 0.14 ] ) ironBar( plaster, V3( uJ + 1.5, yL - 1.15, v ), V3( uJ + 0.12, yL - 0.28, v ), 0.22 );
		paint( lin( [ 0.85, 0.82, 0.74 ] ) );
		for ( const v of [ V0 + 0.15, V2 - 0.15 ] ) box( plaster, uJ + 1.3, uJ + 1.8, v - 0.15, v + 0.15, yL - 1.45, yL - 1.15 );
		wood( lin( [ 0.4, 0.28, 0.2 ] ), 0.4 );
		for ( let v = V0 + 0.12; v < V2 - 0.05; v += 0.21 ) box( plaster, uJ + 0.1, uJ + 0.16, v - 0.03, v + 0.03, yL + 0.15, yL + 1.0 );
		box( plaster, uJ + 0.06, uJ + 0.2, V0, V2, yL + 1.0, yL + 1.07 );
		solid( uJ, UE, V0, V2, yL - 0.3, yL + 0.15, true );
		{

			const yw = yL + 2.3, d = UE - 0.015, rect = ( hv, hy, k ) => plaster.quadFacing( V3( d - k, yw - hy, VM - hv ), V3( d - k, yw - hy, VM + hv ), V3( d - k, yw + hy, VM + hv ), V3( d - k, yw + hy, VM - hv ), south );
			paint( CREAM );
			rect( 0.38, 0.4, 0 );
			paint( lin( [ 0.95, 0.95, 0.93 ] ) );
			rect( 0.27, 0.29, 0.005 );
			for ( const k of [ - 1, 0, 1 ] ) ironBar( lamps, V3( d - 0.03, yw - 0.29, VM + k * 0.09 ), V3( d - 0.03, yw + 0.29, VM + k * 0.09 ), 0.02 );
			for ( const k of [ - 1, 1 ] ) ironBar( lamps, V3( d - 0.03, yw + k * 0.1, VM - 0.27 ), V3( d - 0.03, yw + k * 0.1, VM + 0.27 ), 0.02 );

		}

		// lanterns hung on chains: in front of the chapel, and in front of the loft
		const lantern = ( u, v, yl ) => {

			const [ lx, lz ] = P( u, v );
			ironBar( lamps, [ lx, coveY( v ), lz ], [ lx, yl + 0.4, lz ], 0.02 );
			lamps.vdata = [ 0, 0, 0, 0 ];
			lamps.box( lx, yl + 0.27, lz, 0.38, 0.06, 0.38, yaw + 0.5 );
			lamps.box( lx, yl + 0.35, lz, 0.14, 0.1, 0.14, yaw + 0.5 );
			lamps.box( lx, yl - 0.27, lz, 0.26, 0.06, 0.26, yaw + 0.5 );
			lamps.vdata = [ 1, 0, 0, 0 ];
			lamps.box( lx, yl, lz, 0.32, 0.48, 0.32, yaw + 0.5, 'top bottom' );
			lamps.vdata = [ 0, 0, 0, 0 ];
			this.lights.push( { position: new Vector3( lx, yl - 0.05, lz ), color: new Color( 1.0, 0.66, 0.36 ), intensity: 8, range: 12, kind: 'lantern', flicker: 0.04 } );

		};
		lantern( - R + 1.4, VM, spA + hwC + 0.3 );
		lantern( uJ - 0.7, VM, yL + 1.5 );

		// the chapel's wall, its opening from the cornice up into the arch
		archWall( - R + E, north, VM, hwC, spA, yF );
		// a cornice of stone under the opening, a sunk panel below it
		const front = ( v0, v1, y0, y1, d0, d1 ) => box( plaster, - R + d0, - R + d1, v0, v1, y0, y1 );
		paint( STONE );
		front( V0 + 0.15, V2 - 0.15, yF - 0.18, yF, 0, 0.32 );
		front( V0 + 0.25, V2 - 0.25, yF - 0.32, yF - 0.18, 0, 0.2 );
		paint( lin( [ 0.8, 0.79, 0.75 ] ) );
		const p0 = VM - 1.45, p1 = VM + 1.45, q0 = gC + 0.45, q1 = yF - 0.55;
		front( p0, p1, q0, q0 + 0.06, 0, 0.03 );
		front( p0, p1, q1 - 0.06, q1, 0, 0.03 );
		front( p0, p0 + 0.06, q0, q1, 0, 0.03 );
		front( p1 - 0.06, p1, q0, q1, 0, 0.03 );
		// the pilasters, on pink bases, their capitals, the arch with its keystone, the entablature
		const ent = spA + hwC + 0.45;
		for ( const s of [ - 1, 1 ] ) {

			const vp = VM + s * ( hwC + 0.26 );
			paint( PINK );
			front( vp - 0.28, vp + 0.28, yF, yF + 0.4, 0, 0.22 );
			paint( STONE );
			front( vp - 0.22, vp + 0.22, yF + 0.4, spA - 0.2, 0, 0.14 );
			front( vp - 0.3, vp + 0.3, spA - 0.2, spA, 0, 0.22 );
			front( vp - 0.2, vp + 0.2, spA, ent, 0, 0.1 );

		}

		for ( let k = 0; k < 16; k ++ ) {

			const t0 = Math.PI * k / 16, t1 = Math.PI * ( k + 1 ) / 16, p = ( r, t ) => V3( - R + 0.1, spA + r * Math.sin( t ), VM + r * Math.cos( t ) );
			plaster.quadFacing( p( hwC, t0 ), p( hwC + 0.3, t0 ), p( hwC + 0.3, t1 ), p( hwC, t1 ), north );

		}

		paint( PINK );
		front( VM - 0.15, VM + 0.15, spA + hwC - 0.05, ent, 0, 0.16 );
		paint( STONE );
		front( VM - hwC - 0.55, VM + hwC + 0.55, ent, ent + 0.3, 0, 0.12 );
		front( VM - hwC - 0.65, VM + hwC + 0.65, ent + 0.3, ent + 0.45, 0, 0.24 );
		// the tall iron grille in front of it
		const ug = - R + 0.32, g0 = VM - hwC - 0.05, g1 = VM + hwC + 0.05, gt = yF + 2.0;
		for ( let v = g0; v <= g1 + 1e-3; v += 0.11 ) ironBar( lamps, V3( ug, yF, v ), V3( ug, gt, v ), 0.018 );
		for ( const y of [ yF + 0.05, yF + 0.2, yF + 1.25, gt - 0.15, gt ] ) ironBar( lamps, V3( ug, y, g0 ), V3( ug, y, g1 ), 0.025 );
		for ( let v = g0 + 0.11; v < g1; v += 0.22 ) for ( const y of [ yF + 0.55, gt - 0.5 ] ) {

			// loops between the bars
			ironBar( lamps, V3( ug, y - 0.2, v ), V3( ug, y, v + 0.055 ), 0.012 );
			ironBar( lamps, V3( ug, y, v + 0.055 ), V3( ug, y + 0.2, v ), 0.012 );

		}

		for ( let v = g0; v <= g1 + 1e-3; v += 0.33 ) ironBar( lamps, V3( ug, gt, v ), V3( ug, gt + 0.12, v ), 0.02 );
		solid( - R, ug + 0.05, g0, g1, yF, gt );

		// inside: the floor, whitewashed sides and vaults (the opening's through the wall, the chapel's taller)
		paint( STONE );
		plaster.quadFacing( V3( uB, yF, VM - hwC ), V3( - R, yF, VM - hwC ), V3( - R, yF, VM + hwC ), V3( uB, yF, VM + hwC ), [ 0, 1, 0 ] );
		const inner = ( u0, u1, sp ) => {

			plaster.vdata = [ 1, 0, 0.47, 0 ];
			plaster.color = lin( [ 0.85, 0.84, 0.8 ] );
			for ( const s of [ - 1, 1 ] ) plaster.quadFacing( V3( u0, yF, VM + s * hwC ), V3( u1, yF, VM + s * hwC ), V3( u1, sp, VM + s * hwC ), V3( u0, sp, VM + s * hwC ), dir( intoV, - s ), [ [ u0, 9 ], [ u1, 9 ], [ u1, 9 ], [ u0, 9 ] ] );
			for ( let k = 0; k < 16; k ++ ) {

				const t0 = Math.PI * k / 16, t1 = Math.PI * ( k + 1 ) / 16, tm = ( t0 + t1 ) / 2;
				const p = ( u, t ) => V3( u, sp + hwC * Math.sin( t ), VM + hwC * Math.cos( t ) );
				plaster.quadFacing( p( u0, t0 ), p( u1, t0 ), p( u1, t1 ), p( u0, t1 ), [ - intoV[ 0 ] * Math.cos( tm ), - Math.sin( tm ), - intoV[ 2 ] * Math.cos( tm ) ], [ [ u0, 9 ], [ u1, 9 ], [ u1, 9 ], [ u0, 9 ] ] );

			}

		};
		inner( uW, - R, spA );
		inner( uB, uW, spR );
		// the band between the two vaults, facing in
		for ( let k = 0; k < 16; k ++ ) {

			const t0 = Math.PI * k / 16, t1 = Math.PI * ( k + 1 ) / 16;
			const p = ( y, t ) => V3( uW, y + hwC * Math.sin( t ), VM + hwC * Math.cos( t ) );
			plaster.quadFacing( p( spA, t0 ), p( spR, t0 ), p( spR, t1 ), p( spA, t1 ), south, [ [ 0, 9 ], [ 0, 9 ], [ 0, 9 ], [ 0, 9 ] ] );

		}

		// the back wall, up into the vault
		const bw = uB + E;
		plaster.vdata = [ 2 * hwC, 0, 0.47, 0 ];
		plaster.color = lin( [ 0.85, 0.84, 0.8 ] );
		plaster.quadFacing( V3( bw, yF, VM - hwC ), V3( bw, yF, VM + hwC ), V3( bw, spR, VM + hwC ), V3( bw, spR, VM - hwC ), north, [ [ 0, 9 ], [ 2 * hwC, 9 ], [ 2 * hwC, 9 ], [ 0, 9 ] ] );
		for ( let k = 0; k < 16; k ++ ) {

			const t0 = Math.PI * k / 16, t1 = Math.PI * ( k + 1 ) / 16;
			plaster.quadFacing( V3( bw, spR, VM ), V3( bw, spR + hwC * Math.sin( t0 ), VM + hwC * Math.cos( t0 ) ), V3( bw, spR + hwC * Math.sin( t1 ), VM + hwC * Math.cos( t1 ) ), V3( bw, spR, VM ), north, [ [ 0, 9 ], [ 0, 9 ], [ 0, 9 ], [ 0, 9 ] ] );

		}

		// the retable against it: on a base, two columns on pink pedestals, between them a niche of azulejos
		// with the image; an entablature, a broken pediment and a cartouche over it. The altar before it, a
		// cross on its front, flowers and candles on it
		const rb = ( v0, v1, y0, y1, d0, d1 ) => box( plaster, uB + d0, uB + d1, v0, v1, y0, y1 );
		paint( STONE );
		rb( VM - hwC + 0.08, VM + hwC - 0.08, yF, yF + 1.2, 0, 0.3 );
		for ( const s of [ - 1, 1 ] ) {

			const vc = VM + s * 0.72;
			paint( PINK );
			rb( vc - 0.17, vc + 0.17, yF + 1.2, yF + 1.55, 0, 0.45 );
			paint( STONE );
			rb( vc - 0.11, vc + 0.11, yF + 1.55, yF + 2.75, 0.12, 0.36 );
			for ( let y = yF + 1.75; y < yF + 2.7; y += 0.3 ) rb( vc - 0.125, vc + 0.125, y, y + 0.04, 0.11, 0.37 );
			rb( vc - 0.17, vc + 0.17, yF + 2.75, yF + 2.9, 0, 0.45 );
			// the broken pediment's ends, rising outward to scrolls
			rb( vc - 0.25 + s * 0.05, vc + 0.25 + s * 0.05, yF + 3.08, yF + 3.18, 0, 0.35 );
			rb( vc - 0.1 + s * 0.15, vc + 0.1 + s * 0.15, yF + 3.18, yF + 3.4, 0, 0.3 );
			paint( PINK );
			rb( vc - 0.1 + s * 0.15, vc + 0.1 + s * 0.15, yF + 3.22, yF + 3.32, 0.3, 0.32 );

		}

		paint( STONE );
		rb( VM - 1.0, VM + 1.0, yF + 2.9, yF + 3.08, 0, 0.5 );
		rb( VM - 0.22, VM + 0.22, yF + 3.08, yF + 3.65, 0, 0.18 );
		paint( PINK );
		rb( VM - 0.12, VM + 0.12, yF + 3.25, yF + 3.5, 0.18, 0.2 );
		// the niche: its arch of stone round azulejos, the image of Our Lady in it
		const nh = 0.42, ny = yF + 2.25, nd = 0.02;
		paint( STONE );
		for ( let k = 0; k < 12; k ++ ) {

			const t0 = Math.PI * k / 12, t1 = Math.PI * ( k + 1 ) / 12, p = ( r, t ) => V3( uB + 0.04, ny + r * Math.sin( t ), VM + r * Math.cos( t ) );
			plaster.quadFacing( p( nh, t0 ), p( nh + 0.12, t0 ), p( nh + 0.12, t1 ), p( nh, t1 ), north );

		}

		plaster.vdata = [ yF + 1.2, yF + 2.7, 0.61, 2 ];
		plaster.color = [ 1, 1, 1 ];
		plaster.quadFacing( V3( uB + nd, yF + 1.2, VM - nh ), V3( uB + nd, yF + 1.2, VM + nh ), V3( uB + nd, ny, VM + nh ), V3( uB + nd, ny, VM - nh ), north, [ [ VM - nh, yF + 1.2 ], [ VM + nh, yF + 1.2 ], [ VM + nh, ny ], [ VM - nh, ny ] ] );
		for ( let k = 0; k < 12; k ++ ) {

			const t0 = Math.PI * k / 12, t1 = Math.PI * ( k + 1 ) / 12, p = ( t ) => V3( uB + nd, ny + nh * Math.sin( t ), VM + nh * Math.cos( t ) );
			plaster.quadFacing( V3( uB + nd, ny, VM ), p( t0 ), p( t1 ), V3( uB + nd, ny, VM ), north, [ [ VM, ny ], [ VM + nh * Math.cos( t0 ), ny + nh * Math.sin( t0 ) ], [ VM + nh * Math.cos( t1 ), ny + nh * Math.sin( t1 ) ], [ VM, ny ] ] );

		}

		paint( lin( [ 0.22, 0.3, 0.55 ] ) );
		rb( VM - 0.13, VM + 0.13, yF + 1.25, yF + 1.95, 0.08, 0.28 );
		paint( lin( [ 0.75, 0.2, 0.18 ] ) );
		rb( VM - 0.08, VM + 0.08, yF + 1.45, yF + 1.9, 0.27, 0.3 );
		paint( lin( [ 0.85, 0.7, 0.58 ] ) );
		rb( VM - 0.055, VM + 0.055, yF + 1.95, yF + 2.07, 0.14, 0.24 );
		paint( lin( [ 0.85, 0.66, 0.25 ] ) );
		rb( VM - 0.07, VM + 0.07, yF + 2.07, yF + 2.13, 0.13, 0.25 );
		// the altar
		paint( STONE );
		rb( VM - 0.75, VM + 0.75, yF, yF + 0.95, 0.3, 1.0 );
		rb( VM - 0.8, VM + 0.8, yF + 0.95, yF + 1.0, 0.27, 1.05 );
		paint( lin( [ 0.6, 0.58, 0.54 ] ) );
		rb( VM - 0.03, VM + 0.03, yF + 0.2, yF + 0.75, 1.0, 1.02 );
		rb( VM - 0.17, VM + 0.17, yF + 0.55, yF + 0.61, 1.0, 1.02 );
		for ( const [ dv, c ] of [ [ - 0.6, [ 0.75, 0.35, 0.6 ] ], [ - 0.42, [ 0.45, 0.4, 0.75 ] ], [ 0.42, [ 0.9, 0.55, 0.7 ] ], [ 0.6, [ 0.95, 0.95, 0.9 ] ] ] ) {

			paint( lin( [ 0.25, 0.42, 0.2 ] ) );
			rb( VM + dv - 0.02, VM + dv + 0.02, yF + 1.0, yF + 1.22, 0.55, 0.59 );
			paint( lin( c ) );
			rb( VM + dv - 0.09, VM + dv + 0.09, yF + 1.2, yF + 1.36, 0.48, 0.66 );

		}

		paint( lin( [ 0.95, 0.94, 0.88 ] ) );
		for ( const dv of [ - 0.22, 0.22 ] ) rb( VM + dv - 0.025, VM + dv + 0.025, yF + 1.0, yF + 1.3, 0.55, 0.6 );

		// out through the end wall (photos references/...-img-4406, -img-4408): on the hall's side a round arch
		// with a ring of rough dark stone, its jambs down to the floor; through the wall a vault widening to the
		// outer opening, broad and low, in the plain stone face of the block
		const vE = VE, gE = ground( U2, vE ), a = R - 0.35, ya = gE + 2.5, a2 = a + 0.3, ya2 = gE + 3.0, r2 = 0.6;
		const lo = ( v ) => ground( UE, v ) - 0.3, loOut = ( v ) => ground( U2, v ) - 0.3;
		const rough = () => {

			kit.vdata = [ 0.67, 0.35, 0, 0 ];
			kit.color = lin( [ 0.78, 0.72, 0.64 ] );

		};
		const plain = () => {

			kit.vdata = [ 0.41, 0.8, 0, 0 ];
			kit.color = [ 1, 1, 1 ];

		};
		archWall( UE, south, vE, a, ya, null );
		for ( const [ v0, v1 ] of [ [ V0, vE - a ], [ vE + a, V2 ] ] ) solid( UE, U2, v0, v1, base, S );
		// the vault and its jambs, from the inner arch to the outer
		rough();
		const IN = ( t ) => [ vE + a * Math.cos( t ), ya + a * Math.sin( t ) ], OUT = ( t ) => [ vE + a2 * Math.cos( t ), ya2 + r2 * Math.sin( t ) ];
		for ( let k = 0; k < 16; k ++ ) {

			const t0 = Math.PI * k / 16, t1 = Math.PI * ( k + 1 ) / 16, tm = ( t0 + t1 ) / 2;
			const [ i0v, i0y ] = IN( t0 ), [ i1v, i1y ] = IN( t1 ), [ o0v, o0y ] = OUT( t0 ), [ o1v, o1y ] = OUT( t1 );
			kit.quadFacing( V3( UE, i0y, i0v ), V3( UE, i1y, i1v ), V3( U2, o1y, o1v ), V3( U2, o0y, o0v ), [ - intoV[ 0 ] * Math.cos( tm ), - Math.sin( tm ), - intoV[ 2 ] * Math.cos( tm ) ],
				[ [ t0 * 1.6, UE ], [ t1 * 1.6, UE ], [ t1 * 1.6, U2 ], [ t0 * 1.6, U2 ] ] );

		}

		for ( const s of [ - 1, 1 ] ) {

			const vi = vE + s * a, vo = vE + s * a2;
			kit.quadFacing( V3( UE, lo( vi ), vi ), V3( U2, loOut( vo ), vo ), V3( U2, ya2, vo ), V3( UE, ya, vi ), dir( intoV, - s ) );
			// the jamb's stones on the hall's side, wider at the foot
			box( kit, UE - 0.05, UE, Math.min( vi, vi + s * 0.4 ), Math.max( vi, vi + s * 0.4 ), lo( vi ), lo( vi ) + 1.1 );
			box( kit, UE - 0.05, UE, Math.min( vi, vi + s * 0.32 ), Math.max( vi, vi + s * 0.32 ), lo( vi ) + 1.1, ya );

		}

		for ( let k = 0; k < 16; k ++ ) {

			const t0 = Math.PI * k / 16, t1 = Math.PI * ( k + 1 ) / 16, r0 = a, r1 = a + 0.34;
			const p = ( r, t ) => V3( UE - 0.05, ya + r * Math.sin( t ), vE + r * Math.cos( t ) );
			kit.quadFacing( p( r0, t0 ), p( r1, t0 ), p( r1, t1 ), p( r0, t1 ), south );

		}

		// the block's north face round the outer opening
		plain();
		const vs = [ V0, V2, vE - a2, vE + a2 ];
		for ( let k = 1; k < 16; k ++ ) vs.push( vE - a2 + 2 * a2 * k / 16 );
		vs.sort( ( p, q ) => p - q );
		const holeY = ( v ) => ya2 + r2 * Math.sqrt( Math.max( 0, 1 - ( ( v - vE ) / a2 ) ** 2 ) );
		for ( let k = 0; k + 1 < vs.length; k ++ ) {

			const va = vs[ k ], vb = vs[ k + 1 ], open = Math.abs( ( va + vb ) / 2 - vE ) < a2;
			// (one texture across the face: u along it, v the height)
			const ya0 = open ? holeY( va ) : loOut( va ), yb0 = open ? holeY( vb ) : loOut( vb );
			kit.quadFacing( V3( U2, ya0, va ), V3( U2, yb0, vb ), V3( U2, S, vb ), V3( U2, S, va ), north, [ [ - va, ya0 ], [ - vb, yb0 ], [ - vb, S ], [ - va, S ] ] );

		}

		// outside, a flight of steps along the block's north face, from the street before the way out up to the
		// lane past its north-west corner (photo references/...-img-4408; TerrainData shapes the ground under
		// it: VALE_STEPS, valeStepsAt): cobbled treads with fronts of pale stone; past the treads' outer ends
		// their fronts bend round to meet in pairs, cobbled ramps curving between them
		if ( T.valeSteps ) {

			const Vs = VALE_STEPS, { level } = T.valeSteps, N = Vs.N, half = N / 2, tread = Vs.run / N, dvc = ( N - 1 ) / 2 * tread, Wd = Vs.width;
			const W3 = ( a, b, y ) => [ Vs.o[ 0 ] + Vs.n[ 0 ] * a + Vs.t[ 0 ] * b, y, Vs.o[ 1 ] + Vs.n[ 1 ] * a + Vs.t[ 1 ] * b ];
			const up = [ Vs.n[ 0 ], 0, Vs.n[ 1 ] ], yawS = Math.atan2( - Vs.n[ 1 ], Vs.n[ 0 ] );
			const COBBLE = lin( [ 0.66, 0.65, 0.62 ] ), NOSE = lin( [ 0.86, 0.84, 0.78 ] );
			kit.vdata = [ 0.29, 0.6, 0, 0 ];
			// the straight treads
			for ( let k = 1; k <= N; k ++ ) {

				const a0 = ( k - 1 ) * tread, a1 = k * tread, y = level( k ), foot = level( k - 1 ) - 0.3;
				kit.color = COBBLE;
				kit.quadFacing( W3( a0, 0.02, y ), W3( a1, 0.02, y ), W3( a1, Wd, y ), W3( a0, Wd, y ), [ 0, 1, 0 ], [ [ a0, 0 ], [ a1, 0 ], [ a1, Wd ], [ a0, Wd ] ] );
				kit.color = NOSE;
				kit.quadFacing( W3( a0, 0.02, y + 0.005 ), W3( a0 + 0.14, 0.02, y + 0.005 ), W3( a0 + 0.14, Wd, y + 0.005 ), W3( a0, Wd, y + 0.005 ), [ 0, 1, 0 ] );
				kit.quadFacing( W3( a0, 0.02, foot ), W3( a0, Wd, foot ), W3( a0, Wd, y ), W3( a0, 0.02, y ), dir( up, - 1 ), [ [ 0, foot ], [ Wd, foot ], [ Wd, y ], [ 0, y ] ] );
				const c = W3( ( a0 + a1 ) / 2, Wd / 2, 0 );
				this.colliders.addBox( new Vector3( c[ 0 ], ( y + foot ) / 2, c[ 2 ] ), new Vector3( tread / 2, ( y - foot ) / 2, Wd / 2 ), yawS, { walkable: true, tag: 'stair' } );

			}

			// round the curves: f from the way out's side (0) to the lane's (1); rho( k ) the curve joining fronts
			// k and N + 1 - k; inside b curves the ramp from step b's level to step N - b's
			const rho = ( k ) => k < 1 ? dvc + Vs.apron : k > half ? 0 : dvc - ( k - 1 ) * tread;
			const ramp = ( b, f ) => level( b ) + ( level( N - b ) - level( b ) ) * f;
			const at = ( f, r, y ) => W3( dvc - r * Math.cos( Math.PI * f ), Wd + Vs.stretch * r * Math.sin( Math.PI * f ), y );
			const SEG = 24;
			for ( let j = 0; j < SEG; j ++ ) {

				const f0 = j / SEG, f1 = ( j + 1 ) / SEG, fm = ( f0 + f1 ) / 2;
				const out = [ Vs.t[ 0 ] * Math.sin( Math.PI * fm ) / Vs.stretch - Vs.n[ 0 ] * Math.cos( Math.PI * fm ), 0, Vs.t[ 1 ] * Math.sin( Math.PI * fm ) / Vs.stretch - Vs.n[ 1 ] * Math.cos( Math.PI * fm ) ];
				for ( let b = 0; b <= half; b ++ ) {

					const ri = rho( b + 1 ), ro = rho( b );
					kit.color = COBBLE;
					kit.quadFacing( at( f0, ri, ramp( b, f0 ) ), at( f1, ri, ramp( b, f1 ) ), at( f1, ro, ramp( b, f1 ) ), at( f0, ro, ramp( b, f0 ) ), [ 0, 1, 0 ] );
					if ( b === 0 ) continue;
					// the curve between band b - 1 (outside) and b: its face towards the lower side, its top edge pale
					const ya = [ ramp( b - 1, f0 ), ramp( b, f0 ) ], yb = [ ramp( b - 1, f1 ), ramp( b, f1 ) ];
					const lo0 = Math.min( ...ya ) - 0.05, hi0 = Math.max( ...ya ), lo1 = Math.min( ...yb ) - 0.05, hi1 = Math.max( ...yb );
					if ( hi0 - lo0 < 0.07 && hi1 - lo1 < 0.07 ) continue;
					const sgn = ramp( b, fm ) > ramp( b - 1, fm ) ? 1 : - 1;
					kit.color = NOSE;
					kit.quadFacing( at( f0, ro, lo0 ), at( f1, ro, lo1 ), at( f1, ro, hi1 ), at( f0, ro, hi0 ), dir( out, sgn ) );

				}

			}

		}

		// on the block's west face, along the lane (photo references/...-img-4410): a doorway in a frame of
		// dressed stone, its door dark wood
		{

			const vf = V2 + TH + 0.02, ud = - 2.0, gd = ground( ud, vf );
			const face = ( u0, u1, y0, y1, k ) => plaster.quadFacing( V3( u0, y0, vf + k ), V3( u1, y0, vf + k ), V3( u1, y1, vf + k ), V3( u0, y1, vf + k ), west );
			paint( lin( [ 0.7, 0.66, 0.58 ] ) );
			face( ud - 0.85, ud + 0.85, gd - 0.3, gd + 2.75, 0 );
			paint( lin( [ 0.16, 0.11, 0.08 ] ) );
			face( ud - 0.6, ud + 0.6, gd - 0.3, gd + 2.45, 0.01 );

		}

		// across the lane, the old garden wall (OSM's): weathered white over a red foot, trees over it
		{

			const lane = ( q ) => T.heightAt( q[ 0 ], q[ 1 ] );
			this._oldWall( plaster, [ 89.1, - 46.8 ], [ 80.7, - 26.8 ], 1, lane, 3.2, 2.8, 41, false, { foot: lin( [ 0.55, 0.16, 0.12 ] ), ivy: false } );
			this._oldWall( plaster, [ 83.3, - 48.8 ], [ 89.1, - 46.8 ], 1, lane, 3.0, 3.2, 43, false, { foot: lin( [ 0.55, 0.16, 0.12 ] ), ivy: false } );
			this.extraTrees = this.extraTrees || [];
			for ( const [ x, z, kind, scale ] of [ [ 86.2, - 44.2, 'garden', 0.9 ], [ 84.6, - 39.5, 'olive', 0.75 ], [ 83.3, - 34.5, 'garden', 0.8 ], [ 81.6, - 30.2, 'olive', 0.7 ] ] ) this.extraTrees.push( { kind, x, z, scale } );

		}

		plain();

		for ( const [ k, mat, name, shadow ] of [ [ plaster, materials.plaster, 'vale-passage', true ], [ tiles, materials.roof, 'vale-passage-roof', true ], [ lamps, materials.lantern, 'vale-passage-iron', false ] ] ) {

			const mesh = new Mesh( k.build(), mat );
			mesh.name = name;
			mesh.castShadow = shadow;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// Replace the profile's points between the ones nearest run's ends with run itself (the wall's own
	// corners), at most 2 m apart, the tops eased between theirs.
	_curtainRun( wall, run ) {

		const P = wall.pts;
		const nearest = ( [ x, z ] ) => P.reduce( ( b, p, i ) => ( Math.hypot( p.x - x, p.z - z ) < Math.hypot( P[ b ].x - x, P[ b ].z - z ) ? i : b ), 0 );
		const i0 = nearest( run[ 0 ] ), i1 = nearest( run[ run.length - 1 ] );
		if ( i1 - i0 < 2 ) return;
		const line = [ run[ 0 ] ];
		for ( let k = 1; k < run.length; k ++ ) {

			const a = run[ k - 1 ], b = run[ k ], m = Math.ceil( Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) / 2 );
			for ( let j = 1; j <= m; j ++ ) line.push( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * j / m, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * j / m ] );

		}

		const a = P[ i0 ], b = P[ i1 ];
		const pts = line.map( ( [ x, z ], k ) => ( { ...a, x, z, top: a.top + ( b.top - a.top ) * k / ( line.length - 1 ) } ) );
		P.splice( i0, i1 - i0 + 1, ...pts );
		for ( let i = 1; i < P.length; i ++ ) P[ i ].s = P[ i - 1 ].s + Math.hypot( P[ i ].x - P[ i - 1 ].x, P[ i ].z - P[ i - 1 ].z );
		for ( let i = Math.max( 1, i0 ); i <= Math.min( P.length - 2, i0 + pts.length ); i ++ ) {

			const p = P[ i ], q = P[ i - 1 ], r = P[ i + 1 ];
			let dx = r.x - q.x, dz = r.z - q.z;
			const L = Math.hypot( dx, dz ) || 1;
			dx /= L; dz /= L;
			Object.assign( p, { dx, dz, nx: dz * wall.outward, nz: - dx * wall.outward } );

		}

		wall.length = P[ P.length - 1 ].s;

	}

	// The chapel portal on Porta da Vila's outer face, right of the arch (the Passo da Porta da Vila, as in
	// the photo): a frame of pale stone round an arched wooden door, a cornice, a pediment with scrolls,
	// two finials and a cross, three steps in front. The dressed stone is smooth, so Town builds it with the
	// houses' plaster (this.passo); the door and the steps are built here.
	_passoPortal( gate ) {

		const T = this.terrain, kit = this.kit;
		// the curtain's line here runs east, out is south; the portal 4.8 m right of the arch's centre
		const dx = 0.997, dz = 0.077, nx = - dz, nz = dx; // along, out
		const yaw = Math.atan2( - dz, dx );
		const u0 = 4.8, face = W / 2;
		const P = ( u, v ) => [ gate.x + dx * u + nx * ( face + v ), gate.z + dz * u + nz * ( face + v ) ];
		const g0 = T.heightAt( ...P( u0, 2 ) );
		this.passo = [];
		const part = ( u, v, y0, sx, sy, sz, solid = true, walk = false, dressed = false ) => {

			const c = P( u0 + u, v + sz / 2 );
			if ( dressed ) this.passo.push( { x: c[ 0 ], y: y0 + sy / 2, z: c[ 1 ], sx, sy, sz, yaw } );
			else kit.box( c[ 0 ], y0 + sy / 2, c[ 1 ], sx, sy, sz, yaw, 'bottom' );
			if ( solid ) this.colliders.addBox( new Vector3( c[ 0 ], y0 + sy / 2, c[ 1 ] ), new Vector3( sx / 2, sy / 2, sz / 2 ), yaw, { walkable: walk, tag: walk ? 'stair' : 'portal' } );

		};
		kit.vdata = [ 0.41, 0.15, 0, 0 ];
		part( 0, - 0.2, g0 - 0.6, 4, 6.1, 0.6, true, false, true ); // the frame, from below the ground to the cornice
		part( 0, - 0.2, g0 + 5.5, 4.5, 0.3, 0.85, true, false, true ); // the cornice
		part( 0, - 0.2, g0 + 5.8, 2.6, 0.75, 0.55, false, false, true ); // the pediment
		for ( const s of [ - 1, 1 ] ) {

			part( s * 1.45, - 0.2, g0 + 5.8, 0.45, 0.45, 0.6, false, false, true ); // its scrolls
			part( s * 1.95, - 0.1, g0 + 5.8, 0.3, 0.75, 0.3, false, false, true ); // a finial
			part( s * 1.95, - 0.1, g0 + 6.55, 0.18, 0.2, 0.18, false, false, true );

		}

		part( 0, - 0.1, g0 + 6.55, 0.15, 1.2, 0.15, false, false, true ); // the cross
		part( 0, - 0.1, g0 + 7.25, 0.75, 0.15, 0.15, false, false, true );
		// the door: dark wood, its round head in steps
		kit.color = [ 0.18, 0.11, 0.07 ];
		part( 0, 0.4, g0 + 0.45, 1.8, 2.75, 0.04, false );
		[ [ 1.65, 0.25 ], [ 1.35, 0.25 ], [ 0.85, 0.25 ] ].reduce( ( y, [ w, h ] ) => ( part( 0, 0.4, y, w, h, 0.04, false ), y + h ), g0 + 3.2 );
		// three steps up to it
		kit.color = [ 0.98, 0.95, 0.88 ];
		for ( let i = 0; i < 3; i ++ ) part( 0, 0.4 + ( 2 - i ) * 0.4, g0 - 0.6, 4.4 - i * 0.3, 0.6 + 0.15 * ( i + 1 ), 0.4, true, true );

	}

	// The L-shaped flight at Porta da Vila (OSM way 314791407): from the street just through the inner
	// arch, up along the tower's town wall to a landing at the corner, then along its west wall to the
	// wall walk. Built from the top down, against the outer faces of the two walls: the first flight from
	// the street comes to half the wall's height at the landing, the second goes on up to the walk; broad,
	// steep and dark with wear, as in the photo.
	_portaDaVilaStairs() {

		const wl = this.portaDaVila;
		if ( ! wl ) return;
		const T = this.terrain, kit = this.kit;
		const width = PV_FLIGHT, run = 0.3, off = W / 2 + width / 2 + 0.02;
		// the two legs' centre lines: the walls' lines moved off their town faces
		const shift = ( a, b ) => {

			const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ], L = Math.hypot( dx, dz );
			const nx = - dz / L, nz = dx / L; // the town side of a -> b (north wall east to west, west wall north to south)
			return { a: [ a[ 0 ] + nx * off, a[ 1 ] + nz * off ], dx: dx / L, dz: dz / L, nx, nz };

		};
		const [ , a, b, c ] = PORTA_DA_VILA;
		const north = shift( a, b ), west = shift( b, c );
		// the corner where the two centre lines meet
		const det = north.dx * west.dz - north.dz * west.dx;
		const k = ( ( west.a[ 0 ] - north.a[ 0 ] ) * west.dz - ( west.a[ 1 ] - north.a[ 1 ] ) * west.dx ) / det;
		const corner = [ north.a[ 0 ] + north.dx * k, north.a[ 1 ] + north.dz * k ];
		// the top: beside the walk, short of the curtain's town face
		const topZ = 232.3;
		const tk = ( topZ - corner[ 1 ] ) / west.dz;
		const top = [ corner[ 0 ] + west.dx * tk, corner[ 1 ] + west.dz * tk ];
		let walkY = 0, bd = Infinity;
		for ( const p of wl.samples ) {

			const d = Math.hypot( p.x - top[ 0 ], p.z - top[ 1 ] );
			if ( d < bd ) {

				bd = d;
				walkY = p.y;

			}

		}

		// the two legs in whole steps of about `run`, one rise all the way from the walk down to the street
		// just left of the inner arch
		const dEnd = ( - 53.4 - corner[ 0 ] ) / - north.dx;
		const gEnd = T.heightAt( corner[ 0 ] - north.dx * dEnd, corner[ 1 ] - north.dz * dEnd );
		const lenW = tk - width / 2, lenN = dEnd - width / 2;
		const nW = Math.max( 1, Math.round( lenW / run ) ), nN = Math.max( 1, Math.round( lenN / run ) );
		// the first flight (the north leg, from the street) comes to half the wall's height at the landing,
		// the second (the west leg) on up to the walk
		const yMid = ( walkY + gEnd ) / 2;
		let rise = ( walkY - yMid ) / nW;
		const steps = [];
		let y = walkY;
		const put = ( x, z, dx, dz, len ) => {

			steps.push( { x, z, y, g: T.heightAt( x, z ), yaw: Math.atan2( - dz, dx ), len } );
			y -= rise;

		};
		// west leg, down toward the corner; the landing; north leg, down to the street
		for ( let i = 0; i < nW; i ++ ) {

			const d = ( i + 0.5 ) * lenW / nW;
			put( top[ 0 ] - west.dx * d, top[ 1 ] - west.dz * d, west.dx, west.dz, lenW / nW );

		}

		rise = ( yMid - gEnd - 0.15 ) / nN;
		put( corner[ 0 ], corner[ 1 ], north.dx, north.dz, width );
		for ( let i = 0; i < nN; i ++ ) {

			const d = width / 2 + ( i + 0.5 ) * lenN / nN;
			put( corner[ 0 ] - north.dx * d, corner[ 1 ] - north.dz * d, north.dx, north.dz, lenN / nN );

		}

		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 0.62, 0.6, 0.56 ]; // old, dark stone
		for ( const st of steps ) {

			const bottom = st.g - 0.6, h = st.y - bottom;
			kit.box( st.x, bottom + h / 2, st.z, st.len + 0.02, h, width, st.yaw, 'bottom' );
			this.colliders.addBox( new Vector3( st.x, bottom + h / 2, st.z ), new Vector3( st.len / 2 + 0.01, h / 2, width / 2 ), st.yaw, { walkable: true, tag: 'stair' } );

		}

		// at the head, a landing on to the curtain's town face, level with the walks (the tower's and the
		// curtain's beside it), closing the gap between the flight and the curtain
		const cw = this._nearestWalk( top[ 0 ], top[ 1 ] + 2, 4 );
		if ( cw ) {

			const p = cw.p, face = [ p.x - p.nx * W / 2, p.z - p.nz * W / 2 ];
			const d1 = ( face[ 0 ] - top[ 0 ] ) * west.dx + ( face[ 1 ] - top[ 1 ] ) * west.dz + 0.3, d0 = run / 2 - 0.02;
			if ( d1 > d0 ) {

				const c = [ top[ 0 ] + west.dx * ( d0 + d1 ) / 2, top[ 1 ] + west.dz * ( d0 + d1 ) / 2 ];
				const bottom = T.heightAt( c[ 0 ], c[ 1 ] ) - 0.6, yaw = Math.atan2( - west.dz, west.dx );
				kit.box( c[ 0 ], ( walkY + bottom ) / 2, c[ 1 ], d1 - d0, walkY - bottom, width, yaw, 'bottom' );
				this.colliders.addBox( new Vector3( c[ 0 ], ( walkY + bottom ) / 2, c[ 1 ] ), new Vector3( ( d1 - d0 ) / 2, ( walkY - bottom ) / 2, width / 2 ), yaw, { walkable: true, tag: 'stair' } );

			}

		}

		this.stairs.push( { x: steps[ 0 ].x, z: steps[ 0 ].z, top: steps[ 0 ].y, bottom: steps[ steps.length - 1 ], n: steps.length, steps: steps.map( ( st ) => ( { x: st.x, z: st.z, y: st.y } ) ) } );

	}

	// The stepped lane beside the L-shaped flight at Porta da Vila: from a little over two metres past the
	// inner arch it follows the flight round the tower, in low steps of pale stone (up to 16 cm), three
	// short then two long, over and over; about 5 m short of the curtain it becomes a sloping path that
	// turns right along the curtain.
	_portaDaVilaLane() {

		if ( ! this.portaDaVila ) return;
		const T = this.terrain, kit = this.kit;
		const width = 3;
		const off = W / 2 + PV_FLIGHT + 0.04 + width / 2; // the L-shaped flight between it and the tower
		// a centre line beside a wall line a -> b, on side s (+ 1: to the left of a -> b on the map)
		const beside = ( a, b, s, d ) => {

			const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ], L = Math.hypot( dx, dz );
			return { a: [ a[ 0 ] - dz / L * s * d, a[ 1 ] + dx / L * s * d ], dx: dx / L, dz: dz / L };

		};
		const meet = ( l, m ) => {

			const k = ( ( m.a[ 0 ] - l.a[ 0 ] ) * m.dz - ( m.a[ 1 ] - l.a[ 1 ] ) * m.dx ) / ( l.dx * m.dz - l.dz * m.dx );
			return [ l.a[ 0 ] + l.dx * k, l.a[ 1 ] + l.dz * k ];

		};
		const at = ( p, l, d ) => [ p[ 0 ] + l.dx * d, p[ 1 ] + l.dz * d ];
		const [ , a, b, c ] = PORTA_DA_VILA;
		const north = beside( a, b, 1, off ), west = beside( b, c, 1, off ); // walking up: west, then south
		// the curtain west of the tower (westward); the lane runs along it inside the flight's top
		const curtain = beside( [ - 60.8, 234.7 ], [ - 72, 233.7 ], 1, W / 2 + width / 2 + 0.02 );
		const corner = meet( north, west ), turn = meet( west, curtain );
		const startX = - 55.05; // a little over two metres past the arch

		const steps = [];
		let y = - Infinity;
		const put = ( p, l, len, rise, w = width ) => {

			const g = T.heightAt( p[ 0 ], p[ 1 ] ), ahead = T.heightAt( p[ 0 ] + l.dx * len / 2, p[ 1 ] + l.dz * len / 2 );
			y = y === - Infinity ? ahead + 0.12 : y + Math.min( rise[ 1 ], Math.max( rise[ 0 ], ahead + 0.08 - y ) );
			steps.push( { x: p[ 0 ], z: p[ 1 ], y, g: Math.min( g, ahead ), yaw: Math.atan2( - l.dz, l.dx ), len, w } );

		};
		// the first leg (the video references/IMG_4350 and the screenshots): ten steps in even rises up to a
		// landing level with the Casa da Música's terrace, where its gateway opens, their treads all alike but
		// the first's, whose front runs on the diagonal (further down on the flight's side); then even steps
		// on to the corner's landing
		const KERB = 0.26; // the kerb along a step's front
		const ROWS = [ 0, 0, 0, 1 ]; // (the stone material's setts in rows, in the colours of the ground's)
		const casa = this.casaOutline = this._casaOutline( { corner, north, width } ), yT = casa.yT;
		const sAt = ( x ) => ( x - corner[ 0 ] ) / north.dx; // up the leg from the corner (below it, negative)
		const block = ( p, l, len, yy, w = width ) => {

			const g = Math.min( T.heightAt( p[ 0 ] - l.dx * len / 2, p[ 1 ] - l.dz * len / 2 ), T.heightAt( p[ 0 ] + l.dx * len / 2, p[ 1 ] + l.dz * len / 2 ) );
			const st = { x: p[ 0 ], z: p[ 1 ], y: yy, g, yaw: Math.atan2( - l.dz, l.dx ), len, w };
			steps.push( st );
			y = yy;
			return st;

		};
		const sF = sAt( startX ), sL0 = sAt( - 59.03 ), sL1 = sAt( - 61.01 ), N1 = 10;
		const D1 = 0.76, SKEW = 0.5, t1 = ( sL0 - sF - D1 ) / ( N1 - 1 ), south = [ north.dz, - north.dx ];
		// (the first: a block whose front is the diagonal, reaching back under the second step; the rises
		// counted from the ground at its front, the street's highest there)
		const Fs = at( corner, north, sF - SKEW ), Fn = at( corner, north, sF + SKEW );
		Fs[ 0 ] += south[ 0 ] * width / 2; Fs[ 1 ] += south[ 1 ] * width / 2;
		Fn[ 0 ] -= south[ 0 ] * width / 2; Fn[ 1 ] -= south[ 1 ] * width / 2;
		const g0 = Math.max( T.heightAt( ...Fs ), T.heightAt( ...Fn ), T.heightAt( ...at( corner, north, sF ) ) ), rise1 = ( yT - g0 ) / ( N1 + 1 );
		const dL = Math.hypot( Fn[ 0 ] - Fs[ 0 ], Fn[ 1 ] - Fs[ 1 ] ), fx = ( Fn[ 0 ] - Fs[ 0 ] ) / dL, fz = ( Fn[ 1 ] - Fs[ 1 ] ) / dL;
		const up1 = fz * north.dx - fx * north.dz > 0 ? { dx: fz, dz: - fx } : { dx: - fz, dz: fx }, D = ( D1 + SKEW ) * ( up1.dx * north.dx + up1.dz * north.dz );
		block( [ ( Fs[ 0 ] + Fn[ 0 ] ) / 2 + up1.dx * D / 2, ( Fs[ 1 ] + Fn[ 1 ] ) / 2 + up1.dz * D / 2 ], up1, D, g0 + rise1, dL );
		for ( let k = 1; k < N1; k ++ ) block( at( corner, north, sF + D1 + ( k - 0.5 ) * t1 ), north, t1, g0 + rise1 * ( k + 1 ) );
		this.laneGate = block( at( corner, north, ( sL0 + sL1 ) / 2 ), north, sL1 - sL0, yT );
		// (five, then the corner's landing and the diagonal step: six; their treads tilted up with the climb,
		// half of each rise in the tread, so the risers stay low)
		// (spread up to just short of the diagonal step's front, which crosses the lane's middle at the corner)
		const N2 = 5, sEnd = - 0.6, t2 = ( sEnd - sL1 ) / N2;
		const yC = Math.max( yT + 0.06 * ( N2 + 1 ), T.heightAt( ...corner ) + 0.08 ), rise2 = ( yC - yT ) / N2;
		for ( let k = 1; k <= N2; k ++ ) block( at( corner, north, sL1 + ( k - 0.5 ) * t2 ), north, t2, yT + rise2 * ( k - 0.5 ) ).slope = rise2 / 2;
		// the corner's landing tilted on at the treads' tilt from the last step's back, with no riser between
		const tilt = rise2 / 2 / ( t2 - KERB ), yL = yT + rise2 * N2, cl = width / 2 - sEnd, cSlope = Math.min( 0.3, tilt * cl );
		block( at( corner, north, ( sEnd + width / 2 ) / 2 ), north, cl, yL ).slope = cSlope;
		y = yL + cSlope;
		// (its top at p)
		const landingY = ( p ) => yL + cSlope * clamp01( ( ( p[ 0 ] - corner[ 0 ] ) * north.dx + ( p[ 1 ] - corner[ 1 ] ) * north.dz - sEnd ) / cl );
		// the second leg (the video references/IMG_4350): a strip of steps 2.2 m wide up the middle, banks of
		// setts sloping up either side (TerrainData shapes them), its steps short and high enough to keep up with
		// the ground; by the curtain they turn round to it in a fan, then go on along it
		// (its strip 1 m wide, right against the Casa da Música's white wall (_casaWing: its face 15 cm off
		// the lane's edge); round the turn it runs along the curtain with a bank of setts between it and the
		// curtain, as drawn on the screenshot)
		const LEG2 = 1, PATTERN2 = [ 0.9, 0.75, 1.0 ];
		const shift = ( l, nx, nz, d ) => ( { a: [ l.a[ 0 ] + nx * d, l.a[ 1 ] + nz * d ], dx: l.dx, dz: l.dz } );
		// (straight along the wing's face, which runs due south, 3 cm off it: following the lane's own line,
		// which leans a little west, it ran into the wall)
		const leg = { a: [ corner[ 0 ] - width / 2 - 0.15 + LEG2 / 2 + 0.03, corner[ 1 ] ], dx: 0, dz: 1 };
		const along = shift( curtain, curtain.dz, - curtain.dx, - 0.6 ); // away from the curtain (north)
		const turn2 = meet( leg, along );
		let k2 = 0;
		const flight2 = ( from, l, length ) => {

			for ( let d = 0; d < length - 0.2; k2 ++ ) {

				const len = Math.min( PATTERN2[ k2 % PATTERN2.length ], length - d );
				put( at( from, l, d + len / 2 ), l, len, [ 0.06, 0.36 ], LEG2 );
				steps[ steps.length - 1 ].strip = true;
				d += len;

			}

		};
		// on the corner's landing one more step, its front on the diagonal from the white wall's corner toward
		// the flight's outer corner (as marked on the screenshots), but only to the lane's middle; from its end a
		// ramp down onto the landing; then the strip from its back
		const fc = [ corner[ 0 ] + width / 2 - 0.05, corner[ 1 ] + width / 2 + 0.55 ], wc = [ corner[ 0 ] - width / 2 - 0.15, corner[ 1 ] - width / 2 - 0.3 ];
		const eL = Math.hypot( wc[ 0 ] - fc[ 0 ], wc[ 1 ] - fc[ 1 ] ), ex = ( wc[ 0 ] - fc[ 0 ] ) / eL, ez = ( wc[ 1 ] - fc[ 1 ] ) / eL;
		const up = { dx: ez, dz: - ex }, STEP1 = 0.8; // (across the diagonal, up the lane)
		const M = [ ( fc[ 0 ] + wc[ 0 ] ) / 2, ( fc[ 1 ] + wc[ 1 ] ) / 2 ];
		put( [ ( M[ 0 ] + wc[ 0 ] ) / 2 + up.dx * STEP1 / 2, ( M[ 1 ] + wc[ 1 ] ) / 2 + up.dz * STEP1 / 2 ], up, STEP1, [ 0.06, 0.24 ], eL / 2 );
		steps[ steps.length - 1 ].strip = true;
		{

			// the ramp: from the step's end, its top, down along the diagonal to the landing's top 1.3 m on
			const RAMP = 1.3, yd = y;
			const Ef = M, Eb = [ M[ 0 ] + up.dx * STEP1, M[ 1 ] + up.dz * STEP1 ];
			const Rf = [ M[ 0 ] - ex * RAMP, M[ 1 ] - ez * RAMP ], Rb = [ Eb[ 0 ] - ex * RAMP, Eb[ 1 ] - ez * RAMP ];
			const yR = ( p ) => landingY( p ) + 0.005, V = ( p, yy ) => [ p[ 0 ], yy, p[ 1 ] ];
			const lo = Math.min( yR( Rf ), yR( Rb ) ) - 0.3;
			kit.vdata = ROWS;
			kit.color = [ 1, 1, 1 ];
			kit.quadFacing( V( Ef, lo ), V( Rf, lo ), V( Rf, yR( Rf ) ), V( Ef, yd ), [ - up.dx, 0, - up.dz ] );
			kit.quadFacing( V( Eb, lo ), V( Rb, lo ), V( Rb, yR( Rb ) ), V( Eb, yd ), [ up.dx, 0, up.dz ] );
			const A = V( Ef, yd + 0.004 ), B = V( Eb, yd + 0.004 ), C = V( Rb, yR( Rb ) ), D = V( Rf, yR( Rf ) );
			kit.quadFacing( A, B, C, D, [ 0, 1, 0 ], [ [ 0, 0 ], [ STEP1, 0 ], [ STEP1, RAMP ], [ 0, RAMP ] ] );
			// (walkable: in three pieces, each as high as its upper end's middle)
			const yaw = Math.atan2( ez, - ex );
			for ( let k = 0; k < 3; k ++ ) {

				const f = ( k + 0.5 ) / 3, c = [ M[ 0 ] - ex * RAMP * f + up.dx * STEP1 / 2, M[ 1 ] - ez * RAMP * f + up.dz * STEP1 / 2 ];
				const top = yd + ( yR( c ) - yd ) * ( k / 3 ), bot = lo;
				this.colliders.addBox( new Vector3( c[ 0 ], ( top + bot ) / 2, c[ 1 ] ), new Vector3( RAMP / 6 + 0.01, ( top - bot ) / 2, STEP1 / 2 ), yaw, { walkable: true, tag: 'stair' } );

			}

		}
		const FAN = 0.7, start = meet( leg, { a: [ fc[ 0 ] + up.dx * STEP1, fc[ 1 ] + up.dz * STEP1 ], dx: ex, dz: ez } );
		const legFrom = steps.length;
		flight2( start, leg, ( turn2[ 1 ] - start[ 1 ] ) / leg.dz - FAN * 1.5 );
		// (its first three steps one long tread instead, a ramp (as marked on the screenshot))
		{

			const first = steps.splice( legFrom, 3 ), L3 = first.reduce( ( a, st ) => a + st.len, 0 ), y0 = steps[ legFrom - 1 ].y;
			const c = at( start, leg, L3 / 2 );
			steps.splice( legFrom, 0, { x: c[ 0 ], z: c[ 1 ], y: y0, g: Math.min( ...first.map( ( st ) => st.g ) ), yaw: first[ 0 ].yaw, len: L3, w: LEG2, strip: true } );

		}
		// (three steps, each turned a little further, the middle one on the turn)
		const a0 = Math.atan2( leg.dz, leg.dx );
		let da = Math.atan2( along.dz, along.dx ) - a0;
		while ( da > Math.PI ) da -= 2 * Math.PI;
		while ( da < - Math.PI ) da += 2 * Math.PI;
		for ( const [ f, p ] of [ [ 0.2, at( turn2, leg, - FAN ) ], [ 0.5, turn2 ], [ 0.8, at( turn2, along, FAN ) ] ] ) {

			const a = a0 + da * f;
			put( p, { dx: Math.cos( a ), dz: Math.sin( a ) }, FAN, [ 0.06, 0.24 ], LEG2 + 0.2 );
			steps[ steps.length - 1 ].strip = true;

		}

		flight2( at( turn2, along, FAN * 1.5 ), along, 5 );
		// the strip is part of the ground, not a stair on it: each tread lies on the ground's own slope, a few cm
		// over it, tilted a little less than it, so a riser of 6 cm comes at each joint
		for ( let i = 1; i < steps.length; i ++ ) {

			const st = steps[ i ], prev = steps[ i - 1 ];
			if ( ! st.strip ) continue;
			if ( st.w === eL / 2 ) continue; // (not the diagonal step: the landing sets its height)
			const dx = Math.cos( st.yaw ) * st.len / 2, dz = - Math.sin( st.yaw ) * st.len / 2, base = prev.y + ( prev.slope ?? 0 );
			const y0 = Math.max( T.heightAt( st.x - dx, st.z - dz ) + 0.07, base ), y1 = Math.max( y0, T.heightAt( st.x + dx, st.z + dz ) + 0.01 );
			st.y = y0;
			st.slope = y1 - y0;

		}

		// each step a kerb of grey stone along its front and setts behind it (the video references/IMG_4350):
		// the step's block grey, and over its top, behind the kerb, the setts in rows; on the strip of steps and
		// the diagonal one no grey: all the same stones, the kerb a row of long ones
		steps.forEach( ( st, i ) => {

			const bottom = st.g - 0.6, h = st.y - bottom, sw = st.w ?? width, slope = st.slope ?? 0;
			const body = () => {

				kit.vdata = st.strip ? ROWS : [ 0.29 + i * 0.07, 0.7, 0, 0 ];
				kit.color = st.strip ? [ 1, 1, 1 ] : [ 0.74, 0.73, 0.7 ];

			};
			body();
			kit.box( st.x, bottom + h / 2, st.z, st.len + 0.02, h, sw, st.yaw, 'bottom' );
			// (a tilted tread's collider half way up its tilt)
			const hc = h + slope / 2;
			this.colliders.addBox( new Vector3( st.x, bottom + hc / 2, st.z ), new Vector3( st.len / 2 + 0.01, hc / 2, sw / 2 ), st.yaw, { walkable: true, tag: 'stair' } );
			const kerb = i > 0 && st.y - ( steps[ i - 1 ].y + ( steps[ i - 1 ].slope ?? 0 ) ) > 0.04 && st.len > KERB + 0.15 ? KERB : 0;
			const ax = Math.cos( st.yaw ), az = - Math.sin( st.yaw ), cx = Math.sin( st.yaw ), cz = Math.cos( st.yaw );
			const u0 = - st.len / 2 - 0.01 + kerb, u1 = st.len / 2 + 0.01, w0 = - sw / 2, w1 = sw / 2;
			// (behind the kerb the tread rises by slope to its back)
			const lift = ( u ) => slope * Math.max( 0, ( u - u0 ) / ( u1 - u0 ) );
			const at = ( u, w, dy = 0.004 ) => [ st.x + ax * u + cx * w, st.y + lift( u ) + dy, st.z + az * u + cz * w ];
			if ( slope > 0 ) {

				// the wedge under the tilted tread: its sides and back
				const P = ( u, w, top ) => at( u, w, top ? 0 : - lift( u ) );
				body();
				for ( const [ w, n ] of [ [ w0, - 1 ], [ w1, 1 ] ] ) kit.quadFacing( P( u0, w, false ), P( u1, w, false ), P( u1, w, true ), P( u0, w, true ), [ cx * n, 0, cz * n ] );
				kit.quadFacing( P( u1, w0, false ), P( u1, w1, false ), P( u1, w1, true ), P( u1, w0, true ), [ ax, 0, az ] );

			}

			const A = at( u0, w0 ), B = at( u1, w0 ), C = at( u1, w1 ), D = at( u0, w1 );
			kit.vdata = ROWS;
			kit.color = [ 1, 1, 1 ];
			// (the rows across the way up; each tread's own, so they don't line up from one to the next)
			const r0 = i * 0.37, q = ( u, w ) => [ w + r0, u + r0 ];
			kit.quadFacing( A, B, C, D, [ 0, 1, 0 ], [ q( u0, w0 ), q( u1, w0 ), q( u1, w1 ), q( u0, w1 ) ] );
			if ( st.strip && kerb ) {

				const ku = - st.len / 2 - 0.01;
				const k0 = at( ku, w0 ), k1 = at( u0, w0 ), k2 = at( u0, w1 ), k3 = at( ku, w1 );
				// (stones about 40 cm long, the row's depth the kerb's)
				kit.quadFacing( k0, k1, k2, k3, [ 0, 1, 0 ], [ [ w0 * 0.42 + r0, 0 ], [ w0 * 0.42 + r0, 0.15 ], [ w1 * 0.42 + r0, 0.15 ], [ w1 * 0.42 + r0, 0 ] ] );

			}

		} );

		this.lane = steps;
		this.laneNorth = { corner, north, width }; // its first leg, for the Casa da Música's terrace beside it
		// houses keep 2.5 m back from the lane's outer edge (the steps run up it, the tower to their right)
		this.clearLines.push( { pts: steps.map( ( st ) => [ st.x, st.z ] ), clear: width / 2 + 2.5 } );

	}

	// The Casa da Música's terrace (see _casaDaMusicaTerrace): its outline and level, which the lane needs
	// first for its landing. L is the lane's first leg ({ corner, north, width }).
	_casaOutline( L ) {

		const T = this.terrain;
		// the building's east front (Town.OUTLINE), the wall 2.6 m off Rua Direita's centre line, and its
		// south side right against the lane's edge
		const { corner, north, width } = L;
		const edge = ( x ) => {

			const d = ( x - corner[ 0 ] ) / north.dx;
			return [ x, corner[ 1 ] + north.dz * d + north.dx * ( width / 2 + 0.15 ) ];

		};
		const FS = edge( - 60.2 ), FN = [ - 64.4, 195.6 ];
		const WS = edge( - 56.1 ), WK = [ - 58.1, 210.8 ], WN = [ - 60.3, 195.6 ];
		const parts = [ [ FS, WS, WK, [ - 61, 210.8 ] ], [ [ - 61, 210.8 ], WK, WN, FN ] ];
		let gMax = - Infinity, gMin = Infinity;
		for ( const q of parts.flat() ) {

			const g = T.heightAt( q[ 0 ], q[ 1 ] );
			gMax = Math.max( gMax, g );
			gMin = Math.min( gMin, g );

		}

		return { FS, WS, WK, WN, FN, parts, yT: gMax + 0.1, bottom: gMin - 0.8 };

	}

	// The Casa da Música (the Auditório), as in the photos (references/...-duasescadas, -apossaidadaporta2):
	// a terrace runs the length of its east front, a level above Rua Direita, behind a whitewashed wall with
	// a blue band and blue pilasters along the street. Its south side runs right against the stepped lane,
	// and you step onto it from the lane, part way up, through a gateway of two blue piers. The wall is
	// plaster, built with the houses (Town reads this.casaTerrace).
	_casaDaMusicaTerrace() {

		if ( ! this.casaOutline ) return;
		const T = this.terrain, kit = this.kit;
		const { FS, WS, WK, WN, FN, parts, yT, bottom } = this.casaOutline;
		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 1.06, 1.05, 1.02 ];
		for ( const poly of parts ) {

			// the floor (the wall hides its sides), and a collider for it
			kit.quadFacing( ...poly.map( ( q ) => [ q[ 0 ], yT, q[ 1 ] ] ), [ 0, 1, 0 ] );
			const o = orientedBox( poly );
			this.colliders.addBox( new Vector3( o.cx, ( yT + bottom ) / 2, o.cz ), new Vector3( o.hx, ( yT - bottom ) / 2, o.hz ), o.yaw, { walkable: true, tag: 'terrace' } );

		}

		// the way in: from the lane's landing, level with the terrace, through a gateway in the south wall
		const gate = this.laneGate;
		const GW = 1.2, gx0 = gate.x - GW / 2, gx1 = gate.x + GW / 2;

		// the wall along the lane (with the gateway) and the street, for Town; the blue pilasters every 4 m
		// or so, at its corners and either side of the gateway
		const onSouth = ( x ) => [ x, FS[ 1 ] + ( WS[ 1 ] - FS[ 1 ] ) * ( x - FS[ 0 ] ) / ( WS[ 0 ] - FS[ 0 ] ) ];
		const lines = [ [ [ - 60.2, 214.5 ], FS, onSouth( gx0 ) ], [ onSouth( gx1 ), WS, WK, WN, FN ] ]; // from the building's corner
		const piers = [ onSouth( gx0 - 0.25 ), onSouth( gx1 + 0.25 ), WS, WK, WN ];
		for ( const [ p, q ] of [ [ WS, WK ], [ WK, WN ] ] ) {

			const len = Math.hypot( q[ 0 ] - p[ 0 ], q[ 1 ] - p[ 1 ] ), k = Math.round( len / 4 );
			for ( let i = 1; i < k; i ++ ) piers.push( [ p[ 0 ] + ( q[ 0 ] - p[ 0 ] ) * i / k, p[ 1 ] + ( q[ 1 ] - p[ 1 ] ) * i / k ] );

		}

		kit.color = [ 0.13, 0.27, 0.62 ]; // Óbidos blue
		for ( const p of piers ) {

			const g = T.heightAt( p[ 0 ], p[ 1 ] ) - 0.6, h = yT + 1.15 - g;
			kit.box( p[ 0 ], g + h / 2, p[ 1 ], 0.5, h, 0.5, 0, 'bottom' );
			this.colliders.addBox( new Vector3( p[ 0 ], g + h / 2, p[ 1 ] ), new Vector3( 0.25, h / 2, 0.25 ), 0, { walkable: false, tag: 'pier' } );

		}

		this.casaTerrace = { lines, top: yT + 0.9, floor: yT, thick: 0.3, gate: { x: gate.x, z: gate.z, y: gate.y } };

	}

	// The retaining wall between Rua Porta da Vila and Rua do Cemitério above it, south of the square outside
	// the gate (TerrainData shapes the two streets; the wall stands on its line): rubble stone, 0.8 m thick,
	// in metre pieces from below the lower street to a 0.5 m parapet over the upper one.
	_cemiterioWall() {

		const line = this.terrain.cemiterioWall;
		if ( ! line ) return;
		const kit = this.kit, T = this.terrain;
		kit.vdata = [ 0.61, 0.6, 0, 0 ];
		kit.color = [ 1.02, 0.86, 0.62 ];
		for ( let i = 0; i + 1 < line.length; i ++ ) {

			const a = line[ i ], b = line[ i + 1 ];
			const len = Math.hypot( b.x - a.x, b.z - a.z ), n = Math.max( 1, Math.round( len ) );
			const yaw = Math.atan2( - ( b.z - a.z ), b.x - a.x );
			// set half a metre toward the lower street, over the ground's step from one level to the other
			let ox = - ( b.z - a.z ) / len, oz = ( b.x - a.x ) / len;
			const mx = ( a.x + b.x ) / 2, mz = ( a.z + b.z ) / 2;
			if ( T.heightAt( mx + ox * 2, mz + oz * 2 ) > T.heightAt( mx - ox * 2, mz - oz * 2 ) ) {

				ox = - ox;
				oz = - oz;

			}

			for ( let k = 0; k < n; k ++ ) {

				const t = ( k + 0.5 ) / n, x = a.x + ( b.x - a.x ) * t + ox * 0.5, z = a.z + ( b.z - a.z ) * t + oz * 0.5;
				const top = a.top + ( b.top - a.top ) * t, bottom = Math.min( a.low, T.heightAt( x, z ) ) - 0.8;
				kit.box( x, ( top + bottom ) / 2, z, len / n + 0.02, top - bottom, 0.8, yaw );
				this.colliders.addBox( new Vector3( x, ( top + bottom ) / 2, z ), new Vector3( len / n / 2 + 0.01, ( top - bottom ) / 2, 0.4 ), yaw, { walkable: false, tag: 'wall' } );

			}

		}

	}

	// up Rua Dom João de Ornelas from the stone steps (photo references/...-img-4384): the curtain's lowest courses
	// are greyer than the golden stone above, the same stone going over to it between 1.2 and 1.9 m over the
	// street. For the curtain's outer face (_wallLine) between OA and OB: null, or the band and how grey (k)
	_footTone( OA, OB ) {

		const F = this.terrain.ornelasEast?.curtainFoot;
		if ( ! F ) return null;
		const x = ( OA[ 0 ] + OB[ 0 ] ) / 2, z = ( OA[ 1 ] + OB[ 1 ] ) / 2;
		let d = Infinity;
		for ( let i = 0; i + 1 < F.length; i ++ ) d = Math.min( d, segmentDistance( x, z, F[ i ], F[ i + 1 ] )[ 0 ] );
		return d < 1.6 ? { y0: 1.2, y1: 1.9, k: 0.85 } : null;

	}

	// by the fork where Rua Dom João de Ornelas leaves the curtain (photo references/...-img-4390): the stone either
	// side of the green gate (Town._ornelasFork paints the gate), and worn stones along the curtain's foot
	_ornelasForkStone() {

		const kit = this.kit, T = this.terrain, r = mulberry32( 4390 );
		if ( ! T.ornelasEast ) return;
		kit.vdata = [ 0.41, 0.75, 0, 0 ];
		kit.color = [ 1.25, 1.1, 0.88 ]; // (it stands in shade most of the day)
		// on the gate's line, its pillars standing out from the white
		const ux = - 0.126, uz = - 0.992, nx = - 0.992, nz = 0.126, ox = 83.4, oz = 81.4, yaw = Math.atan2( - uz, ux );
		for ( const [ t0, t1 ] of [ [ - 0.05, 0.9 ], [ 5.4, 6.2 ] ] ) {

			const t = ( t0 + t1 ) / 2, x = ox + ux * t + nx * 0.17, z = oz + uz * t + nz * 0.17, g = T.heightAt( x, z );
			kit.box( x, g + 1.1, z, t1 - t0, 3.6, 0.34, yaw, 'bottom' );

		}

		// and the wall on from it to the white wall's end, up to the eave
		{

			const x = 84.7 - 0.55 * 0.12, z = 82.25 + 0.84 * 0.12, L = 3.15;
			kit.box( x, T.heightAt( x, z ) + 0.8, z, L, 5.2, 0.24, Math.atan2( - 0.55, 0.84 ), 'bottom' );

		}

		for ( let i = 0; i < 16; i ++ ) {

			const zr = 96 + r() * 13, x = 67.8 + ( 109 - zr ) * 0.112 + 0.9 + r() * 0.9, s = 0.08 + r() * 0.14, v = 0.8 + r() * 0.2;
			kit.color = [ v * 1.02, v * 0.93, v * 0.76 ];
			kit.box( x, T.heightAt( x, zr ) + s * 0.3 - 0.03, zr, s * 1.5, s * 0.75, s * 1.1, r() * 3, 'bottom' );

		}

	}

	// Rua Dom João de Ornelas, going down from the square outside the gate (TerrainData shapes it), as in the
	// photo: the wall that holds the square up beside the slope, from level with the bollards' end across
	// the street; whitewashed, with a blue band along its foot that follows the street, a
	// step up in its top where a two-armed street lamp stands, bougainvillea spilling over it by the house; a
	// no-entry sign at its start and a pavement of limestone slabs along the street's far side.
	_ornelas( materials ) {

		const o = this.terrain.ornelas;
		if ( ! o ) return;
		const kit = this.kit, T = this.terrain;
		const plaster = new MeshKit(), lamps = new MeshKit();
		// a point d across the street (left, toward the square, positive) at s along it; round the line's
		// bends the across direction is the mean of the two
		const left = ( s ) => {

			const a = o.at( Math.max( 0, s - 0.05 ) ), b = o.at( s + 0.05 );
			const lx = a.lx + b.lx, lz = a.lz + b.lz, l = Math.hypot( lx, lz );
			return [ lx / l, lz / l ];

		};
		const pt = ( s, d ) => {

			const p = o.at( s ), [ lx, lz ] = left( s );
			return [ p.x + lx * d, p.z + lz * d ];

		};
		const yawAt = ( s ) => {

			const p = o.at( s );
			return Math.atan2( - p.dz, p.dx );

		};

		// the square's edge over the slope, as far as the wall: a kerb of setts, its face standing over the street
		const box = ( s0, s1, d0, d1, top, bottom, walkable, tag ) => {

			const sm = ( s0 + s1 ) / 2, [ x, z ] = pt( sm, ( d0 + d1 ) / 2 ), yaw = yawAt( sm );
			kit.box( x, ( top + bottom ) / 2, z, s1 - s0 + 0.02, top - bottom, d1 - d0, yaw, 'bottom' );
			this.colliders.addBox( new Vector3( x, ( top + bottom ) / 2, z ), new Vector3( ( s1 - s0 ) / 2 + 0.01, ( top - bottom ) / 2, ( d1 - d0 ) / 2 ), yaw, { walkable, tag } );

		};
		const a0 = o.WALL_OFF;
		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 0.8, 0.78, 0.74 ]; // grey setts
		for ( let sv = o.S0; sv < o.W_START - 0.01; sv += 1 ) {

			const s1 = Math.min( o.W_START, sv + 1 );
			box( sv, s1, a0, o.HALF + 2.2, o.F + 0.01, o.roadY( s1 ) - 0.5, true, 'praceta' );

		}

		// a step halfway up its face from the street, against the wall's end: a way up onto the square
		box( o.W_START - 0.9, o.W_START, a0 - 0.36, a0 + 0.01, ( o.F + o.roadY( o.W_START ) ) / 2, o.roadY( o.W_START ) - 0.5, true, 'stair' );

		// the wall, whitewashed: its faces built here so the blue band (the plaster's barra) runs along the
		// street's slope, 1.25 m up, rather than level
		const BLUE = lin( [ 0.1, 0.27, 0.78 ] );
		const STEP_AT = o.S_W + 5, topAt = ( s ) => o.F + ( s < STEP_AT ? 1.1 : 1.45 ), TH = 0.6;
		const BAR = 0.75; // v scale on the street side: the barra's 0.95 m becomes 1.25 m
		plaster.color = BLUE;
		plaster.vdata = [ 20, 0, 0.0722, 0 ];
		const cuts = [ o.W_START ];
		for ( let sv = Math.floor( o.W_START ) + 1; sv < o.WALL_END - 0.3; sv += 1 ) cuts.push( sv );
		if ( ! cuts.includes( STEP_AT ) ) cuts.push( STEP_AT );
		cuts.push( o.WALL_END );
		cuts.sort( ( p, q ) => p - q );
		const lowY = ( s ) => Math.min( o.roadY( s ), T.heightAt( ...pt( s, o.WALL_OFF ) ) ) - 0.5;
		for ( let i = 0; i + 1 < cuts.length; i ++ ) {

			const sa = cuts[ i ], sb = cuts[ i + 1 ], top = topAt( ( sa + sb ) / 2 );
			const A = pt( sa, o.WALL_OFF ), B = pt( sb, o.WALL_OFF ), A2 = pt( sa, o.WALL_OFF + TH ), B2 = pt( sb, o.WALL_OFF + TH );
			const ya = lowY( sa ), yb = lowY( sb ), ra = o.roadY( sa ), rb = o.roadY( sb );
			const [ lx, lz ] = left( ( sa + sb ) / 2 );
			// the street face, its band; the square's face (white: v well above the band); the top
			plaster.quadFacing( [ A[ 0 ], ya, A[ 1 ] ], [ B[ 0 ], yb, B[ 1 ] ], [ B[ 0 ], top, B[ 1 ] ], [ A[ 0 ], top, A[ 1 ] ], [ - lx, 0, - lz ],
				[ [ sa, ( ya - ra ) * BAR ], [ sb, ( yb - rb ) * BAR ], [ sb, ( top - rb ) * BAR ], [ sa, ( top - ra ) * BAR ] ] );
			plaster.quadFacing( [ A2[ 0 ], o.F - 0.3, A2[ 1 ] ], [ B2[ 0 ], o.F - 0.3, B2[ 1 ] ], [ B2[ 0 ], top, B2[ 1 ] ], [ A2[ 0 ], top, A2[ 1 ] ], [ lx, 0, lz ],
				[ [ sa, 2 ], [ sb, 2 ], [ sb, top - o.F + 2.3 ], [ sa, top - o.F + 2.3 ] ] );
			plaster.quadFacing( [ A[ 0 ], top, A[ 1 ] ], [ B[ 0 ], top, B[ 1 ] ], [ B2[ 0 ], top, B2[ 1 ] ], [ A2[ 0 ], top, A2[ 1 ] ], [ 0, 1, 0 ],
				[ [ sa, 5 ], [ sb, 5 ], [ sb, 5.6 ], [ sa, 5.6 ] ] );
			// its ends, and the step in its top
			const p = o.at( sa ), q = o.at( sb );
			if ( i === 0 ) plaster.quadFacing( [ A[ 0 ], ya, A[ 1 ] ], [ A2[ 0 ], ya, A2[ 1 ] ], [ A2[ 0 ], top, A2[ 1 ] ], [ A[ 0 ], top, A[ 1 ] ], [ - p.dx, 0, - p.dz ],
				[ [ 0, ( ya - ra ) * BAR ], [ TH, ( ya - ra ) * BAR ], [ TH, ( top - ra ) * BAR ], [ 0, ( top - ra ) * BAR ] ] );
			if ( i + 2 === cuts.length ) plaster.quadFacing( [ B[ 0 ], yb, B[ 1 ] ], [ B2[ 0 ], yb, B2[ 1 ] ], [ B2[ 0 ], top, B2[ 1 ] ], [ B[ 0 ], top, B[ 1 ] ], [ q.dx, 0, q.dz ],
				[ [ 0, ( yb - rb ) * BAR ], [ TH, ( yb - rb ) * BAR ], [ TH, ( top - rb ) * BAR ], [ 0, ( top - rb ) * BAR ] ] );
			if ( sb === STEP_AT ) plaster.quadFacing( [ B[ 0 ], top, B[ 1 ] ], [ B2[ 0 ], top, B2[ 1 ] ], [ B2[ 0 ], topAt( sb + 0.1 ), B2[ 1 ] ], [ B[ 0 ], topAt( sb + 0.1 ), B[ 1 ] ], [ - q.dx, 0, - q.dz ],
				[ [ 0, 5 ], [ TH, 5 ], [ TH, 5.4 ], [ 0, 5.4 ] ] );
			const sm = ( sa + sb ) / 2, [ cx, cz ] = pt( sm, o.WALL_OFF + TH / 2 ), bottom = Math.min( ya, yb );
			this.colliders.addBox( new Vector3( cx, ( top + bottom ) / 2, cz ), new Vector3( ( sb - sa ) / 2 + 0.02, ( top - bottom ) / 2, TH / 2 ), yawAt( sm ), { walkable: false, tag: 'wall' } );

		}

		// a strip of paving behind it, level with the square, over the ground's dip down to the street
		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 0.8, 0.78, 0.74 ];
		for ( let i = 0; i + 1 < cuts.length; i ++ ) {

			const sm = ( cuts[ i ] + cuts[ i + 1 ] ) / 2, len = cuts[ i + 1 ] - cuts[ i ], [ x, z ] = pt( sm, o.WALL_OFF + TH + 0.75 );
			const y = o.F + 0.02, bottom = o.roadY( sm ) - 0.5, yaw = yawAt( sm );
			kit.box( x, ( y + bottom ) / 2, z, len + 0.04, y - bottom, 1.5, yaw, 'bottom' );
			this.colliders.addBox( new Vector3( x, ( y + bottom ) / 2, z ), new Vector3( len / 2 + 0.02, ( y - bottom ) / 2, 0.75 ), yaw, { walkable: true, tag: 'praceta' } );

		}

		// (no raised slabs along the street's far side: on the slope they stepped up it like a flight of stairs;
		// the street's line of white slabs lies flush, Town._ornelasTop)

		// the street lamp on the wall's step: a cast-iron post, two curled arms, two lanterns
		const warm = new Color( 1.0, 0.66, 0.36 );
		{

			const [ x, z ] = pt( STEP_AT + 0.35, o.WALL_OFF + TH / 2 ), y0 = topAt( STEP_AT + 0.35 ), p = o.at( STEP_AT ), yaw = yawAt( STEP_AT );
			lamps.vdata = [ 0, 0, 0, 0 ];
			lamps.box( x, y0 + 0.25, z, 0.34, 0.5, 0.34, yaw ); // the base
			lamps.box( x, y0 + 1.6, z, 0.14, 2.3, 0.14, yaw ); // the post
			lamps.box( x, y0 + 2.8, z, 0.1, 0.12, 0.1, yaw );
			lamps.box( x, y0 + 2.75, z, 1.5, 0.06, 0.06, yaw ); // the arms, along the wall
			for ( const k of [ - 1, 1 ] ) {

				const lx = x + p.dx * k * 0.75, lz = z + p.dz * k * 0.75;
				lamps.box( x + p.dx * k * 0.45, y0 + 2.6, z + p.dz * k * 0.45, 0.05, 0.3, 0.05, yaw ); // the curl under the arm
				lamps.vdata = [ 0, 0, 0, 0 ];
				lamps.box( lx, y0 + 2.81, lz, 0.2, 0.06, 0.2, yaw );
				lamps.box( lx, y0 + 3.36, lz, 0.4, 0.07, 0.4, yaw );
				lamps.box( lx, y0 + 3.46, lz, 0.16, 0.14, 0.16, yaw );
				lamps.vdata = [ 1, 0, 0, 0 ];
				lamps.box( lx, y0 + 3.08, lz, 0.32, 0.5, 0.32, yaw, 'top bottom' );
				this.lights.push( { position: new Vector3( lx, y0 + 3.05, lz ), color: warm, intensity: 10, range: 16, kind: 'lantern', flicker: 0.04 } );

			}

			this.colliders.addBox( new Vector3( x, y0 + 1.6, z ), new Vector3( 0.17, 1.6, 0.17 ), yaw, { walkable: false, tag: 'lamp' } );

		}

		// the no-entry sign at the wall's start, on the square's side, facing the way in; a blue
		// keep-right sign under it
		{

			const s = o.S_W + 0.4, [ x, z ] = pt( s, o.WALL_OFF + TH + 0.35 ), y0 = o.F, p = o.at( s ), yaw = yawAt( s );
			lamps.vdata = [ 0, 0, 0, 0 ];
			lamps.box( x, y0 + 1.4, z, 0.07, 2.8, 0.07, yaw );
			const disc = ( cy, r, color, fx = 0 ) => {

				plaster.color = lin( color );
				plaster.vdata = [ 0, 0, 0.53, 4 ];
				const n = 6;
				for ( let i = 0; i < n; i ++ ) {

					const v0 = - r + 2 * r * i / n, v1 = v0 + 2 * r / n, vm = Math.max( Math.abs( v0 ), Math.abs( v1 ) ) * 0.85;
					const w = 2 * Math.sqrt( Math.max( 0, r * r - vm * vm ) );
					plaster.box( x - p.dx * ( 0.06 + fx ), cy + ( v0 + v1 ) / 2, z - p.dz * ( 0.06 + fx ), 0.03, v1 - v0, w, yaw );

				}

			};
			disc( y0 + 2.45, 0.32, [ 0.78, 0.1, 0.08 ] );
			plaster.color = lin( [ 0.95, 0.95, 0.93 ] );
			plaster.box( x - p.dx * 0.08, y0 + 2.45, z - p.dz * 0.08, 0.02, 0.1, 0.42, yaw ); // its white bar
			disc( y0 + 1.8, 0.24, [ 0.1, 0.3, 0.75 ] );
			plaster.color = lin( [ 0.95, 0.95, 0.93 ] );
			plaster.box( x - p.dx * 0.08, y0 + 1.8, z - p.dz * 0.08, 0.02, 0.06, 0.26, yaw - 0.7 ); // its arrow
			this.colliders.addBox( new Vector3( x, y0 + 1.4, z ), new Vector3( 0.06, 1.4, 0.06 ), yaw, { walkable: false, tag: 'sign' } );

		}

		// bougainvillea over the wall by the house: a mound of magenta flowers and leaves, on the square's
		// side, spilling over the top
		{

			let seed = 7;
			const rnd = () => ( ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647 );
			plaster.vdata = [ 0, 0, 0.53, 4 ];
			// a rounded mound, densest in the middle, a few sprays hanging down the street face
			for ( let i = 0; i < 520; i ++ ) {

				const t = rnd(), s = o.WALL_END - 7 + 6.5 * t, top = topAt( s ), h = 2.2 * Math.sin( Math.PI * t ) ** 0.7;
				const hang = rnd() < 0.18;
				const d = hang ? o.WALL_OFF - 0.08 : o.WALL_OFF + rnd() * 2.4;
				const y = hang ? top - rnd() * 1.1 * Math.sin( Math.PI * t ) : top - 0.2 + h * Math.sqrt( rnd() ) * ( 1 - Math.max( 0, d - o.WALL_OFF - 1.4 ) / 1.5 );
				const [ x, z ] = pt( s, d );
				const leaf = rnd() < 0.35, sz = 0.12 + rnd() * 0.22;
				plaster.color = lin( leaf ? [ 0.18 + rnd() * 0.08, 0.34 + rnd() * 0.08, 0.1 ] : [ 0.78 + rnd() * 0.1, 0.07 + rnd() * 0.08, 0.36 + rnd() * 0.12 ] );
				plaster.box( x, y, z, sz, sz * 0.8, sz, rnd() * 3 );

			}

		}

		for ( const [ k, mat, name, shadow ] of [ [ plaster, materials.plaster, 'ornelas', true ], [ lamps, materials.lantern, 'ornelas-lamps', false ] ] ) {

			const mesh = new Mesh( k.build(), mat );
			mesh.name = name;
			mesh.castShadow = shadow;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// Porta Este (photo references/...-deforaportaeste): round the pointed arch on its outer face, dressed
	// voussoirs and jamb stones of grey limestone; in the passage two low steps of setts; inside, up the
	// cobbled slope (TerrainData shapes it), a broad flight of stone steps with an iron handrail up the
	// middle, between low whitewashed walls with a yellow band along their foot.
	_portaEste( materials ) {

		const pe = this.terrain.portaEste, g = pe && pe.gate;
		if ( ! g || ! g.frame || ! g.R ) return;
		const kit = this.kit, f = g.frame, R = g.R, rr = R * g.pointed, spring = g.y + g.spring;
		const plaster = new MeshKit(), iron = new MeshKit();
		const yawT = Math.atan2( - f.tz, f.tx );
		// the wall line bends a little here: its offset out (along the gate's normal) at a along the wall
		const line = this.curtain.samples.map( ( p ) => [ ( p.x - g.x ) * f.tx + ( p.z - g.z ) * f.tz, ( p.x - g.x ) * f.nx + ( p.z - g.z ) * f.nz ] )
			.filter( ( [ a, d ] ) => Math.abs( a ) < 5 && Math.abs( d ) < 2 ).sort( ( p, q ) => p[ 0 ] - q[ 0 ] );
		const lineD = ( a ) => {

			let k = 0;
			while ( k < line.length - 2 && line[ k + 1 ][ 0 ] < a ) k ++;
			const [ a0, d0 ] = line[ k ], [ a1, d1 ] = line[ k + 1 ];
			return d0 + ( d1 - d0 ) * clamp01( ( a - a0 ) / ( a1 - a0 ) );

		};
		// a point a along the wall from the gate's centre, d out from the wall line
		const onFace = ( a, d ) => {

			const dd = d + lineD( a );
			return [ g.x + f.tx * a + f.nx * dd, g.z + f.tz * a + f.nz * dd ];

		};
		const GREY = [ 0.92, 0.88, 0.8 ], PROUD = 0.06, FACE = pe.FACE;

		// the gap the wall's pieces leave, closed down to the doorway: masonry from the floor to the
		// springing (the soffit is level there), from the outer face back to the town side's recess
		const SPLIT = g.inner ? - FACE + g.inner.depth : - FACE, DEEP = FACE - SPLIT;
		if ( g.span > R + 0.01 ) {

			const w = g.span - R, tone = 0.92;
			kit.vdata = [ 0.37, 0.8, 0, 0 ];
			kit.color = [ tone * 1.05, tone * 0.84, tone * 0.56 ];
			for ( const side of [ - 1, 1 ] ) {

				const a = side * ( R + w / 2 ), [ x, z ] = onFace( a, ( SPLIT + FACE ) / 2 ), bottom = Math.min( pe.yOut, pe.y1 ) - 0.8;
				kit.box( x, ( spring + bottom ) / 2, z, w, spring - bottom, DEEP, yawT );
				this.colliders.addBox( new Vector3( x, ( spring + bottom ) / 2, z ), new Vector3( w / 2, ( spring - bottom ) / 2, DEEP / 2 ), yawT, { walkable: false, tag: 'wall' } );

			}

		}

		// a ring of voussoirs round an arch on a face (face +1 outer, -1 inner): each half an arc of radius
		// rr struck from beyond the other jamb (rr = R: round), springing at ys; jamb stones below it
		const voussoirs = ( face, R0, rr0, ys, ring, nv, color, jambW ) => {

			kit.vdata = [ 0.43, 0.35, 0, 0 ];
			kit.color = color;
			const GAP = 0.012, d0 = face * FACE, d1 = face * ( FACE + PROUD );
			const out = [ f.nx * face, 0, f.nz * face ];
			for ( const side of [ - 1, 1 ] ) {

				const c = - side * ( rr0 - R0 ), tMax = Math.acos( ( rr0 - R0 ) / rr0 );
				const pt = ( t, r, d ) => {

					const a = c + side * r * Math.cos( t ), [ x, z ] = onFace( a, d );
					return [ x, ys + r * Math.sin( t ), z ];

				};
				for ( let i = 0; i < nv; i ++ ) {

					const ta = tMax * i / nv + ( i > 0 ? GAP / rr0 : 0 ), tb = tMax * ( i + 1 ) / nv - ( i < nv - 1 ? GAP / rr0 : 0 );
					const ia = pt( ta, rr0, d1 ), ib = pt( tb, rr0, d1 ), oa = pt( ta, rr0 + ring, d1 ), ob = pt( tb, rr0 + ring, d1 );
					const ia0 = pt( ta, rr0, d0 ), ib0 = pt( tb, rr0, d0 ), oa0 = pt( ta, rr0 + ring, d0 ), ob0 = pt( tb, rr0 + ring, d0 );
					const tm = ( ta + tb ) / 2;
					const radial = [ f.tx * side * Math.cos( tm ), Math.sin( tm ), f.tz * side * Math.cos( tm ) ];
					kit.quadFacing( ia, ib, ob, oa, out );
					kit.quadFacing( ia0, ib0, ib, ia, radial.map( ( v ) => - v ) );
					kit.quadFacing( oa0, ob0, ob, oa, radial );
					// the joints: the arc's tangent at each end (pointing up the arch), backwards at the start
					const along = ( t ) => [ - f.tx * side * Math.sin( t ), Math.cos( t ), - f.tz * side * Math.sin( t ) ];
					kit.quadFacing( ia0, oa0, oa, ia, along( ta ).map( ( v ) => - v ) );
					kit.quadFacing( ib0, ob0, ob, ib, along( tb ) );

				}

				// the jamb stones below the springing, long and short in turn, flush with the opening
				for ( let y = g.y, k = 0; y < ys - 0.05; k ++ ) {

					const h = Math.min( ys - y, k % 2 ? 0.5 : 0.62 ), w = k % 2 ? jambW[ 0 ] : jambW[ 1 ];
					const [ x, z ] = onFace( side * ( R0 + w / 2 ), face * ( FACE + PROUD / 2 ) );
					kit.box( x, y + h / 2, z, w - 0.02, h - 0.02, PROUD, yawT );
					y += h;

				}

			}

		};
		voussoirs( 1, R, rr, spring, 0.38, 5, GREY, [ 0.36, 0.6 ] );
		// on the town side, golden: the round arch over the recess
		if ( g.inner ) voussoirs( - 1, g.span, g.span, g.y + g.inner.spring, 0.42, 6, [ 1.02, 0.84, 0.56 ], [ 0.4, 0.62 ] );

		// the passage: two low steps of grey setts, each with a nosing of pale stone
		const passage = ( s0, s1, top, half ) => {

			const sm = ( s0 + s1 ) / 2, [ x, z ] = onFace( 0, - sm );
			kit.vdata = [ 0.29, 0.6, 0, 0 ];
			kit.color = [ 0.8, 0.78, 0.74 ];
			kit.box( x, top - 0.3, z, 2 * half + 0.1, 0.6, s1 - s0, yawT );
			this.colliders.addBox( new Vector3( x, top - 0.3, z ), new Vector3( half + 0.05, 0.3, ( s1 - s0 ) / 2 ), yawT, { walkable: true, tag: 'stair' } );
			const [ nx, nz ] = onFace( 0, - s0 - 0.11 );
			kit.vdata = [ 0.43, 0.5, 0, 0 ];
			kit.color = [ 0.95, 0.9, 0.8 ];
			kit.box( nx, top - 0.1 + 0.005, nz, 2 * half + 0.12, 0.2, 0.22, yawT );

		};
		// (the inner one under the recess, as wide as it)
		passage( - FACE, pe.STEP2, pe.y1, R );
		passage( pe.STEP2, FACE + 0.3, pe.y2, g.inner ? g.span : R );

		// outside, two big steps of grey limestone against the wall up to the threshold, wider than the door
		for ( let i = 0; i < 2; i ++ ) {

			const d0 = FACE + i * 0.42, d1 = d0 + ( i ? 0.48 : 0.42 ), top = pe.yOut + pe.OUT_RISE * ( 2 - i ), bottom = pe.yOut - 0.5;
			const [ x, z ] = onFace( 0, ( d0 + d1 ) / 2 );
			kit.vdata = [ 0.43, 0.4, 0, 0 ];
			kit.color = [ 0.84, 0.83, 0.79 ];
			kit.box( x, ( top + bottom ) / 2, z, i ? 2.7 : 2.45, top - bottom, d1 - d0 + 0.02, yawT );
			this.colliders.addBox( new Vector3( x, ( top + bottom ) / 2, z ), new Vector3( i ? 1.35 : 1.225, ( top - bottom ) / 2, ( d1 - d0 ) / 2 ), yawT, { walkable: true, tag: 'stair' } );

		}

		// above the door, a white marble plaque in a grey frame, five lines cut in it
		// ("A Virgem Nossa Senhora foi concebida sem peccado original")
		{

			const crown = spring + Math.sqrt( rr * rr - ( rr - R ) * ( rr - R ) );
			const PW = 1.15, PH = 0.72, cy = crown + 1.3 + PH / 2, a = 0;
			const at = ( da, d ) => onFace( a + da, FACE + d );
			const [ x, z ] = at( 0, 0.03 );
			plaster.vdata = [ 0, 0, 0.31, 4 ];
			plaster.color = lin( [ 0.55, 0.56, 0.55 ] );
			plaster.box( x, cy, z, PW + 0.08, PH + 0.08, 0.06, yawT );
			const [ x2, z2 ] = at( 0, 0.065 );
			plaster.color = lin( [ 0.9, 0.9, 0.87 ] );
			plaster.box( x2, cy, z2, PW, PH, 0.02, yawT );
			plaster.color = lin( [ 0.22, 0.22, 0.22 ] );
			const lines = [ 0.62, 0.86, 0.8, 0.88, 0.5 ];
			lines.forEach( ( w, k ) => {

				const [ x3, z3 ] = at( 0, 0.077 );
				plaster.box( x3, cy + PH / 2 - 0.12 - k * 0.12, z3, PW * w, 0.05, 0.006, yawT );

			} );

		}

		// the flight, across the lane between its walls
		const yawAt = ( s ) => {

			const p = pe.at( s );
			return Math.atan2( - p.dz, p.dx );

		};
		const lanePt = ( s, d ) => {

			const p = pe.at( s );
			return [ p.x + p.lx * d, p.z + p.lz * d ];

		};
		const H = pe.HALF;
		for ( let i = 0; i < pe.N; i ++ ) {

			const s0 = pe.SF + i * pe.TREAD, top = pe.surf( pe.SF ) + ( i + 1 ) * pe.RISE, yaw = yawAt( s0 );
			const [ x, z ] = lanePt( s0 + pe.TREAD / 2, 0 ), bottom = top - pe.RISE - 0.6;
			kit.vdata = [ 0.29, 0.6, 0, 0 ];
			kit.color = [ 0.84, 0.82, 0.77 ];
			kit.box( x, ( top + bottom ) / 2, z, pe.TREAD + 0.02, top - bottom, 2 * H, yaw, 'bottom' );
			this.colliders.addBox( new Vector3( x, ( top + bottom ) / 2, z ), new Vector3( pe.TREAD / 2 + 0.01, ( top - bottom ) / 2, H ), yaw, { walkable: true, tag: 'stair' } );
			const [ nx, nz ] = lanePt( s0 + 0.08, 0 );
			kit.vdata = [ 0.43, 0.5, 0, 0 ];
			kit.color = [ 0.95, 0.9, 0.8 ];
			kit.box( nx, top - 0.06 + 0.005, nz, 0.16, 0.12, 2 * H + 0.02, yaw );

		}

		const beam = ( a, b, w ) => ironBar( iron, a, b, w );

		// the handrail up the middle (photo references/...-escadariaportaeste): a round iron bar 0.9 m over
		// the nosings' line on posts with forked heads; at each end it runs on level a little, then turns
		// down into the ground
		iron.vdata = [ 0, 0, 0, 0 ];
		const RAIL = 0.9, BAR_W = 0.045;
		const nose = ( sv ) => pe.surf( Math.min( Math.max( sv, pe.SF ), pe.ST ) );
		const tread = ( sv ) => sv < pe.SF ? pe.surf( sv ) : sv >= pe.ST ? pe.surf( sv ) : pe.surf( pe.SF ) + ( Math.floor( ( sv - pe.SF ) / pe.TREAD ) + 1 ) * pe.RISE;
		const P3 = ( sv, y ) => {

			const [ x, z ] = lanePt( sv, 0 );
			return [ x, y, z ];

		};
		const r0 = pe.SF + 0.1, r1 = pe.ST - 0.1, foot = pe.SF - 0.45, head = pe.ST + 0.4;
		const yR0 = nose( r0 ) + RAIL, yR1 = nose( r1 ) + RAIL;
		beam( P3( r0, yR0 ), P3( r1, yR1 ), BAR_W );
		beam( P3( foot, yR0 ), P3( r0, yR0 ), BAR_W );
		beam( P3( r1, yR1 ), P3( head, yR1 ), BAR_W );
		beam( P3( foot, tread( foot ) - 0.05 ), P3( foot, yR0 + BAR_W / 2 ), BAR_W );
		beam( P3( head, tread( head ) - 0.05 ), P3( head, yR1 + BAR_W / 2 ), BAR_W );
		for ( const sv of [ foot, head ] ) {

			const [ x, z ] = lanePt( sv, 0 ), y0 = tread( sv ), y1 = ( sv === foot ? yR0 : yR1 );
			this.colliders.addBox( new Vector3( x, ( y0 + y1 ) / 2, z ), new Vector3( 0.05, ( y1 - y0 ) / 2, 0.05 ), yawAt( sv ), { walkable: false, tag: 'rail' } );

		}

		const NP = 5;
		for ( let k = 0; k < NP; k ++ ) {

			const sv = r0 + 0.5 + ( r1 - r0 - 1.0 ) * k / ( NP - 1 ), yr = nose( sv ) + RAIL, y0 = tread( sv ), yaw = yawAt( sv );
			const [ x, z ] = lanePt( sv, 0 );
			iron.box( x, ( y0 + yr - 0.12 ) / 2, z, 0.04, yr - 0.12 - y0, 0.04, yaw );
			// the fork: two prongs either side of the bar, joined under it
			iron.box( x, yr - 0.12, z, 0.035, 0.03, 0.15, yaw );
			for ( const side of [ - 1, 1 ] ) {

				const [ px, pz ] = lanePt( sv, side * 0.065 );
				iron.box( px, yr - 0.05, pz, 0.03, 0.15, 0.022, yaw );

			}

			this.colliders.addBox( new Vector3( x, ( y0 + yr ) / 2, z ), new Vector3( 0.05, ( yr - y0 ) / 2, 0.08 ), yaw, { walkable: false, tag: 'rail' } );

		}

		// the lane's walls, whitewashed, a yellow band along their foot that follows the lane (photo
		// references/...-entradaportaeste): on the left a low one with a dark coping, holding up the bed
		// of the plane trees (TerrainData raises it), loose setts heaped at its foot; on the right only
		// beside the flight (the slope below it has an earth verge), tall, holding up the ground behind,
		// with stone quoins at its foot's corner and a stone balustrade along its top
		const YELLOW = lin( [ 0.86, 0.64, 0.17 ] );
		const TH = 0.4, BAR = 1.3; // the band's 0.55 m becomes 0.42 m
		const T = this.terrain;
		const STONE = [ 0.88, 0.85, 0.78 ];
		// the cuts along the lane for things that follow its slope: every metre, and the flight's ends
		const cutsFor = ( s0, s1 ) => {

			const c = [ s0 ];
			for ( let sv = Math.ceil( s0 ); sv < s1 - 0.3; sv ++ ) c.push( sv );
			c.push( pe.SF, pe.ST, s1 );
			return [ ...new Set( c.filter( ( v ) => v >= s0 && v <= s1 ).map( ( v ) => Math.round( v * 1000 ) / 1000 ) ) ].sort( ( p, q ) => p - q );

		};
		// a bar along the lane from sa to sb, d across (centre), w wide, its bottom and top at each end
		const prism = ( k, sa, sb, d, w, ya0, ya1, yb0, yb1 ) => {

			const A = lanePt( sa, d - w / 2 ), B = lanePt( sb, d - w / 2 ), A2 = lanePt( sa, d + w / 2 ), B2 = lanePt( sb, d + w / 2 );
			const p = pe.at( ( sa + sb ) / 2 ), left = [ p.lx, 0, p.lz ];
			k.quadFacing( [ A[ 0 ], ya1, A[ 1 ] ], [ B[ 0 ], yb1, B[ 1 ] ], [ B2[ 0 ], yb1, B2[ 1 ] ], [ A2[ 0 ], ya1, A2[ 1 ] ], [ 0, 1, 0 ] );
			k.quadFacing( [ A[ 0 ], ya0, A[ 1 ] ], [ B[ 0 ], yb0, B[ 1 ] ], [ B2[ 0 ], yb0, B2[ 1 ] ], [ A2[ 0 ], ya0, A2[ 1 ] ], [ 0, - 1, 0 ] );
			k.quadFacing( [ A[ 0 ], ya0, A[ 1 ] ], [ B[ 0 ], yb0, B[ 1 ] ], [ B[ 0 ], yb1, B[ 1 ] ], [ A[ 0 ], ya1, A[ 1 ] ], left.map( ( v ) => - v ) );
			k.quadFacing( [ A2[ 0 ], ya0, A2[ 1 ] ], [ B2[ 0 ], yb0, B2[ 1 ] ], [ B2[ 0 ], yb1, B2[ 1 ] ], [ A2[ 0 ], ya1, A2[ 1 ] ], left );
			k.quadFacing( [ A[ 0 ], ya0, A[ 1 ] ], [ A2[ 0 ], ya0, A2[ 1 ] ], [ A2[ 0 ], ya1, A2[ 1 ] ], [ A[ 0 ], ya1, A[ 1 ] ], [ - p.dx, 0, - p.dz ] );
			k.quadFacing( [ B[ 0 ], yb0, B[ 1 ] ], [ B2[ 0 ], yb0, B2[ 1 ] ], [ B2[ 0 ], yb1, B2[ 1 ] ], [ B[ 0 ], yb1, B[ 1 ] ], [ p.dx, 0, p.dz ] );

		};
		// a stone balustrade along a wall's top (base( s )): a plinth, square balusters close together, a
		// rail; stouter posts at its ends
		const balustrade = ( side, s0, s1, base ) => {

			kit.vdata = [ 0.43, 0.6, 0, 0 ];
			kit.color = [ 0.66, 0.65, 0.6 ]; // grey, lichened
			const d = side * ( H + TH / 2 ), PH = 0.6, cs = cutsFor( s0, s1 );
			for ( let i = 0; i + 1 < cs.length; i ++ ) {

				const sa = cs[ i ], sb = cs[ i + 1 ], ba = base( sa ), bb = base( sb );
				prism( kit, sa, sb, d, 0.3, ba - 0.02, ba + 0.08, bb - 0.02, bb + 0.08 );
				prism( kit, sa, sb, d, 0.32, ba + PH, ba + PH + 0.11, bb + PH, bb + PH + 0.11 );
				const [ cx, cz ] = lanePt( ( sa + sb ) / 2, d ), top = Math.max( ba, bb ) + PH + 0.11, bot = Math.min( ba, bb );
				this.colliders.addBox( new Vector3( cx, ( top + bot ) / 2, cz ), new Vector3( ( sb - sa ) / 2 + 0.02, ( top - bot ) / 2, 0.16 ), yawAt( ( sa + sb ) / 2 ), { walkable: false, tag: 'wall' } );

			}

			for ( let sv = s0 + 0.32; sv < s1 - 0.2; sv += 0.3 ) {

				const [ x, z ] = lanePt( sv, d ), b0 = base( sv ) + 0.08;
				kit.box( x, b0 + ( PH - 0.08 ) / 2, z, 0.11, PH - 0.08, 0.13, yawAt( sv ) );

			}

			for ( const sv of [ s0 + 0.12, s1 - 0.12 ] ) {

				const [ x, z ] = lanePt( sv, d ), b0 = base( sv ) - 0.02;
				kit.box( x, b0 + ( PH + 0.2 ) / 2, z, 0.24, PH + 0.2, 0.34, yawAt( sv ) );

			}

		};
		const wallRun = ( side, s0, s1, topAt, bar = BAR ) => {

			const cs = cutsFor( s0, s1 );
			plaster.color = YELLOW;
			plaster.vdata = [ 20, 0, 0, 0 ];
			for ( let i = 0; i + 1 < cs.length; i ++ ) {

				const sa = cs[ i ], sb = cs[ i + 1 ], ra = pe.surf( sa ), rb = pe.surf( sb ), ta = topAt( sa ), tb = topAt( sb );
				const A = lanePt( sa, side * H ), B = lanePt( sb, side * H ), A2 = lanePt( sa, side * ( H + TH ) ), B2 = lanePt( sb, side * ( H + TH ) );
				const ya = Math.min( ra, T.heightAt( ...A2 ) ) - 0.5, yb = Math.min( rb, T.heightAt( ...B2 ) ) - 0.5;
				const p = pe.at( ( sa + sb ) / 2 ), toLane = [ - p.lx * side, 0, - p.lz * side ];
				const band = ( y, r ) => ( y - r ) * bar;
				plaster.quadFacing( [ A[ 0 ], ya, A[ 1 ] ], [ B[ 0 ], yb, B[ 1 ] ], [ B[ 0 ], tb, B[ 1 ] ], [ A[ 0 ], ta, A[ 1 ] ], toLane,
					[ [ sa, band( ya, ra ) ], [ sb, band( yb, rb ) ], [ sb, band( tb, rb ) ], [ sa, band( ta, ra ) ] ] );
				plaster.quadFacing( [ A2[ 0 ], ya, A2[ 1 ] ], [ B2[ 0 ], yb, B2[ 1 ] ], [ B2[ 0 ], tb, B2[ 1 ] ], [ A2[ 0 ], ta, A2[ 1 ] ], toLane.map( ( v ) => - v ),
					[ [ sa, 2 ], [ sb, 2 ], [ sb, 3 ], [ sa, 3 ] ] );
				plaster.quadFacing( [ A[ 0 ], ta, A[ 1 ] ], [ B[ 0 ], tb, B[ 1 ] ], [ B2[ 0 ], tb, B2[ 1 ] ], [ A2[ 0 ], ta, A2[ 1 ] ], [ 0, 1, 0 ],
					[ [ sa, 5 ], [ sb, 5 ], [ sb, 5.4 ], [ sa, 5.4 ] ] );
				for ( const [ end, sv, y0, r, t, dir ] of [ [ i === 0, sa, ya, ra, ta, - 1 ], [ i + 2 === cs.length, sb, yb, rb, tb, 1 ] ] ) {

					if ( ! end ) continue;
					const E1 = lanePt( sv, side * H ), E2 = lanePt( sv, side * ( H + TH ) ), q = pe.at( sv );
					plaster.quadFacing( [ E1[ 0 ], y0, E1[ 1 ] ], [ E2[ 0 ], y0, E2[ 1 ] ], [ E2[ 0 ], t, E2[ 1 ] ], [ E1[ 0 ], t, E1[ 1 ] ], [ q.dx * dir, 0, q.dz * dir ],
						[ [ 0, band( y0, r ) ], [ TH, band( y0, r ) ], [ TH, band( t, r ) ], [ 0, band( t, r ) ] ] );

				}

				const [ cx, cz ] = lanePt( ( sa + sb ) / 2, side * ( H + TH / 2 ) ), top = Math.max( ta, tb ), bottom = Math.min( ya, yb );
				this.colliders.addBox( new Vector3( cx, ( top + bottom ) / 2, cz ), new Vector3( ( sb - sa ) / 2 + 0.02, ( top - bottom ) / 2, TH / 2 ), yawAt( ( sa + sb ) / 2 ), { walkable: false, tag: 'wall' } );

			}

			return cs;

		};

		// the left wall, its coping, the loose setts; it starts a little way in from the curtain, leaving
		// room for a short flight up to the bed against the curtain's face (photo references/...-portaeste3):
		// five stone steps rising away from the lane, the first standing out into it
		const leftTop = ( sv ) => pe.bedY( sv ) + 0.15;
		const BS0 = FACE + 0.05, BS1 = FACE + 1.15, BN = 5, BTREAD = 0.42;
		{

			const sm = ( BS0 + BS1 ) / 2, r = pe.surf( sm ), yaw = yawAt( sm );
			for ( let k = 0; k < BN; k ++ ) {

				const d0 = H - 0.35 + k * BTREAD, top = r + ( k + 1 ) * pe.BED / BN, bottom = r - 0.4;
				const [ x, z ] = lanePt( sm, d0 + BTREAD / 2 );
				kit.vdata = [ 0.43, 0.5, 0, 0 ];
				kit.color = [ 0.8, 0.79, 0.74 ];
				kit.box( x, ( top + bottom ) / 2, z, BS1 - BS0, top - bottom, BTREAD + 0.01, yaw );
				this.colliders.addBox( new Vector3( x, ( top + bottom ) / 2, z ), new Vector3( ( BS1 - BS0 ) / 2, ( top - bottom ) / 2, BTREAD / 2 ), yaw, { walkable: true, tag: 'stair' } );

			}

		}

		const ls = wallRun( 1, BS1 + 0.1, pe.BED_WALL_END, leftTop ); // (to where the steps catch up with it)
		plaster.vdata = [ 0, 0, 0.41, 4 ];
		plaster.color = lin( [ 0.42, 0.33, 0.27 ] );
		for ( let i = 0; i + 1 < ls.length; i ++ ) {

			// a thin strip following the wall's slope, a little proud of both faces
			const sa = ls[ i ], sb = ls[ i + 1 ], C = 0.06, ya = leftTop( sa ) + C, yb = leftTop( sb ) + C;
			const A = lanePt( sa, H - 0.03 ), B = lanePt( sb, H - 0.03 ), A2 = lanePt( sa, H + TH + 0.03 ), B2 = lanePt( sb, H + TH + 0.03 );
			const p = pe.at( ( sa + sb ) / 2 ), toLane = [ - p.lx, 0, - p.lz ];
			plaster.quadFacing( [ A[ 0 ], ya, A[ 1 ] ], [ B[ 0 ], yb, B[ 1 ] ], [ B2[ 0 ], yb, B2[ 1 ] ], [ A2[ 0 ], ya, A2[ 1 ] ], [ 0, 1, 0 ] );
			plaster.quadFacing( [ A[ 0 ], ya - C - 0.01, A[ 1 ] ], [ B[ 0 ], yb - C - 0.01, B[ 1 ] ], [ B[ 0 ], yb, B[ 1 ] ], [ A[ 0 ], ya, A[ 1 ] ], toLane );
			plaster.quadFacing( [ A2[ 0 ], ya - C - 0.01, A2[ 1 ] ], [ B2[ 0 ], yb - C - 0.01, B2[ 1 ] ], [ B2[ 0 ], yb, B2[ 1 ] ], [ A2[ 0 ], ya, A2[ 1 ] ], toLane.map( ( v ) => - v ) );

		}

		{

			let seed = 11;
			const rnd = () => ( ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647 );
			kit.vdata = [ 0.29, 0.6, 0, 0 ];
			for ( let i = 0; i < 70; i ++ ) {

				const sv = 4.5 + rnd() * 4.5, dd = H - 0.05 - rnd() * rnd() * 0.55, sz = 0.11 + rnd() * 0.08;
				// heaped against the wall: higher close to it
				const [ x, z ] = lanePt( sv, dd ), y = pe.surf( sv ) + sz * 0.3 + rnd() * 0.15 * ( 1 - ( H - dd ) / 0.6 );
				const tone = 0.7 + rnd() * 0.2;
				kit.color = [ tone, tone * 0.98, tone * 0.93 ];
				kit.box( x, y, z, sz, sz * 0.8, sz * ( 0.8 + rnd() * 0.4 ), rnd() * 3 );

			}

		}

		// the right wall beside the flight holds up a flat terrace (TerrainData levels it): its top level
		// with the terrace, so it stands ~3.5 m over the flight's foot, its yellow band tall; the balustrade
		// along its top. At the flight's foot it turns the corner and runs back from the lane, along the
		// verge (photo references/...-muroescadariaportaeste), quoins up the corner, and in front of it a
		// planter with a blue band, plants spilling over, a black gate at its end.
		const TR = pe.TERRACE, RS0 = TR.s0, rightTop = () => TR.y;
		wallRun( - 1, RS0, TR.s1, rightTop, 0.58 );
		balustrade( - 1, RS0, TR.s1, rightTop );

		// a straight wall from P0 to P1 (world xz), thick toward `back` (unit xz), from below the ground to
		// top( t ) (t 0..1 along it); its band (colour) follows the ground at its face
		const straightWall = ( P0, P1, back, top, color, bar, ends = [ true, true ] ) => {

			const L = Math.hypot( P1[ 0 ] - P0[ 0 ], P1[ 1 ] - P0[ 1 ] ), n = Math.max( 1, Math.ceil( L ) );
			const ux = ( P1[ 0 ] - P0[ 0 ] ) / L, uz = ( P1[ 1 ] - P0[ 1 ] ) / L, yaw = Math.atan2( - uz, ux );
			plaster.color = color;
			plaster.vdata = [ 20, 0, 0, 0 ];
			const at = ( t, k ) => [ P0[ 0 ] + ( P1[ 0 ] - P0[ 0 ] ) * t + back[ 0 ] * k, P0[ 1 ] + ( P1[ 1 ] - P0[ 1 ] ) * t + back[ 1 ] * k ];
			const front = [ - back[ 0 ], 0, - back[ 1 ] ];
			for ( let i = 0; i < n; i ++ ) {

				const ta = i / n, tb = ( i + 1 ) / n, A = at( ta, 0 ), B = at( tb, 0 ), A2 = at( ta, TH ), B2 = at( tb, TH );
				const ga = T.heightAt( ...at( ta, - 0.3 ) ), gb = T.heightAt( ...at( tb, - 0.3 ) ), ya = ga - 0.6, yb = gb - 0.6, hA = top( ta ), hB = top( tb );
				const ua = ta * L, ub = tb * L;
				plaster.quadFacing( [ A[ 0 ], ya, A[ 1 ] ], [ B[ 0 ], yb, B[ 1 ] ], [ B[ 0 ], hB, B[ 1 ] ], [ A[ 0 ], hA, A[ 1 ] ], front,
					[ [ ua, ( ya - ga ) * bar ], [ ub, ( yb - gb ) * bar ], [ ub, ( hB - gb ) * bar ], [ ua, ( hA - ga ) * bar ] ] );
				plaster.quadFacing( [ A2[ 0 ], ya, A2[ 1 ] ], [ B2[ 0 ], yb, B2[ 1 ] ], [ B2[ 0 ], hB, B2[ 1 ] ], [ A2[ 0 ], hA, A2[ 1 ] ], front.map( ( v ) => - v ),
					[ [ ua, 3 ], [ ub, 3 ], [ ub, 4 ], [ ua, 4 ] ] );
				plaster.quadFacing( [ A[ 0 ], hA, A[ 1 ] ], [ B[ 0 ], hB, B[ 1 ] ], [ B2[ 0 ], hB, B2[ 1 ] ], [ A2[ 0 ], hA, A2[ 1 ] ], [ 0, 1, 0 ],
					[ [ ua, 5 ], [ ub, 5 ], [ ub, 5.4 ], [ ua, 5.4 ] ] );
				for ( const [ end, t, E, E2, y0, h, g, dir ] of [ [ ends[ 0 ] && i === 0, ta, A, A2, ya, hA, ga, - 1 ], [ ends[ 1 ] && i === n - 1, tb, B, B2, yb, hB, gb, 1 ] ] ) {

					if ( ! end ) continue;
					plaster.quadFacing( [ E[ 0 ], y0, E[ 1 ] ], [ E2[ 0 ], y0, E2[ 1 ] ], [ E2[ 0 ], h, E2[ 1 ] ], [ E[ 0 ], h, E[ 1 ] ], [ ux * dir, 0, uz * dir ],
						[ [ 0, ( y0 - g ) * bar ], [ TH, ( y0 - g ) * bar ], [ TH, ( h - g ) * bar ], [ 0, ( h - g ) * bar ] ] );

				}

				const [ cx, cz ] = at( ( ta + tb ) / 2, TH / 2 ), hi = Math.max( hA, hB ), lo = Math.min( ya, yb );
				this.colliders.addBox( new Vector3( cx, ( hi + lo ) / 2, cz ), new Vector3( L / n / 2 + 0.02, ( hi - lo ) / 2, TH / 2 ), yaw, { walkable: false, tag: 'wall' } );

			}

		};
		// quoins up a corner at P (world xz), on the faces running along u1 and u2 (unit xz, away from the corner)
		const quoins = ( P, u1, u2, y0, y1 ) => {

			kit.vdata = [ 0.43, 0.45, 0, 0 ];
			kit.color = [ 1.02, 0.86, 0.6 ]; // golden limestone, as in the photo
			for ( let y = y0, k = 0; y < y1 - 0.1; k ++ ) {

				const h = Math.min( y1 - 0.02 - y, 0.36 ), wa = k % 2 ? 0.26 : 0.46, wb = k % 2 ? 0.46 : 0.26;
				for ( const [ u, o, w ] of [ [ u1, u2, wa ], [ u2, u1, wb ] ] ) {

					// on the face along u (its outward normal is -o), proud of it
					kit.box( P[ 0 ] + u[ 0 ] * w / 2 - o[ 0 ] * 0.015, y + h / 2, P[ 1 ] + u[ 1 ] * w / 2 - o[ 1 ] * 0.015, w, h - 0.03, 0.03, Math.atan2( - u[ 1 ], u[ 0 ] ) );

				}

				y += h;

			}

		};

		// the wall across the flight's foot, back from the lane along the verge
		const GD = pe.GARDEN, RET = TR.depth, PLANT0 = GD.PLANT0, PLANT_OUT = GD.PLANT_OUT, PLANT1 = RET - 3.4; // its length (the terrace's depth); the planter from PLANT0 along to PLANT1, PLANT_OUT deep
		const p0 = pe.at( RS0 ), along = [ - p0.lx, - p0.lz ], intoT = [ p0.dx, p0.dz ]; // away from the lane; into the terrace
		const C0 = lanePt( RS0, - H ), C1 = [ C0[ 0 ] + along[ 0 ] * RET, C0[ 1 ] + along[ 1 ] * RET ];
		straightWall( C0, C1, intoT, () => TR.y, YELLOW, 0.58, [ false, true ] );
		{

			// its balustrade, level with the terrace: posts and rail as on the flight's side
			kit.vdata = [ 0.43, 0.6, 0, 0 ];
			kit.color = [ 0.66, 0.65, 0.6 ];
			const mid = [ ( C0[ 0 ] + C1[ 0 ] ) / 2 + intoT[ 0 ] * TH / 2, ( C0[ 1 ] + C1[ 1 ] ) / 2 + intoT[ 1 ] * TH / 2 ], yaw = Math.atan2( - along[ 1 ], along[ 0 ] );
			kit.box( mid[ 0 ], TR.y + 0.03, mid[ 1 ], RET, 0.1, 0.3, yaw );
			kit.box( mid[ 0 ], TR.y + 0.655, mid[ 1 ], RET, 0.11, 0.32, yaw );
			for ( let t = 0.3; t < RET - 0.2; t += 0.3 ) {

				const x = C0[ 0 ] + along[ 0 ] * t + intoT[ 0 ] * TH / 2, z = C0[ 1 ] + along[ 1 ] * t + intoT[ 1 ] * TH / 2;
				kit.box( x, TR.y + 0.34, z, 0.11, 0.52, 0.13, yaw );

			}

			this.colliders.addBox( new Vector3( mid[ 0 ], TR.y + 0.35, mid[ 1 ] ), new Vector3( RET / 2, 0.36, 0.16 ), yaw, { walkable: false, tag: 'wall' } );

		}

		quoins( C0, along, intoT, pe.surf( RS0 ) - 0.1, TR.y );

		// on the terrace, a level border of setts along the inside of both walls, over the ground's rise
		// from them (its 1 m texels can't step up right at a wall)
		{

			const BW = 1.0, top = TR.y - 0.04, bottom = TR.y - 1.2;
			kit.vdata = [ 0.29, 0.6, 0, 0 ];
			kit.color = [ 0.8, 0.78, 0.74 ];
			const strip = ( x, z, lx, lz, yaw ) => {

				kit.box( x, ( top + bottom ) / 2, z, lx, top - bottom, lz, yaw, 'bottom' );
				this.colliders.addBox( new Vector3( x, ( top + bottom ) / 2, z ), new Vector3( lx / 2, ( top - bottom ) / 2, lz / 2 ), yaw, { walkable: true, tag: 'terrace' } );

			};
			// along the flight's wall (the lane's frame), in metre lengths as the lane bends a little
			for ( let sv = RS0 + TH; sv < TR.s1 - 0.01; sv += 1 ) {

				const sb = Math.min( TR.s1, sv + 1 ), [ x, z ] = lanePt( ( sv + sb ) / 2, - ( H + TH + BW / 2 ) );
				strip( x, z, sb - sv + 0.02, BW, yawAt( ( sv + sb ) / 2 ) );

			}

			// along the corner wall, back from the lane: wider (the ground rises further in there)
			const BW2 = 1.7, len = RET - TH - BW, c = [ C0[ 0 ] + intoT[ 0 ] * ( TH + BW2 / 2 ) + along[ 0 ] * ( TH + BW + len / 2 ), C0[ 1 ] + intoT[ 1 ] * ( TH + BW2 / 2 ) + along[ 1 ] * ( TH + BW + len / 2 ) ];
			strip( c[ 0 ], c[ 1 ], len, BW2, Math.atan2( - along[ 1 ], along[ 0 ] ) );

		}

		// the planter in front of it: a low wall with a blue band, its top level, plants over it
		const BLUE = lin( [ 0.1, 0.27, 0.78 ] );
		const Q0 = [ C0[ 0 ] + along[ 0 ] * PLANT0 - intoT[ 0 ] * PLANT_OUT, C0[ 1 ] + along[ 1 ] * PLANT0 - intoT[ 1 ] * PLANT_OUT ];
		const Q1 = [ C0[ 0 ] + along[ 0 ] * PLANT1 - intoT[ 0 ] * PLANT_OUT, C0[ 1 ] + along[ 1 ] * PLANT1 - intoT[ 1 ] * PLANT_OUT ];
		const plantTop = T.heightAt( ...Q0 ) + 1.5;
		straightWall( Q0, Q1, intoT, () => plantTop, BLUE, 0.62 );
		// its ends, back to the tall wall
		const S0 = [ C0[ 0 ] + along[ 0 ] * PLANT0, C0[ 1 ] + along[ 1 ] * PLANT0 ];
		straightWall( S0, [ S0[ 0 ] - intoT[ 0 ] * ( PLANT_OUT - TH ), S0[ 1 ] - intoT[ 1 ] * ( PLANT_OUT - TH ) ], along, () => plantTop, BLUE, 0.62, [ false, false ] );
		const S1 = [ C0[ 0 ] + along[ 0 ] * ( PLANT1 - TH ), C0[ 1 ] + along[ 1 ] * ( PLANT1 - TH ) ];
		straightWall( S1, [ S1[ 0 ] - intoT[ 0 ] * ( PLANT_OUT - TH ), S1[ 1 ] - intoT[ 1 ] * ( PLANT_OUT - TH ) ], along.map( ( v ) => - v ), () => plantTop, BLUE, 0.62, [ false, false ] );
		quoins( Q0, along, intoT, T.heightAt( ...Q0 ) - 0.1, plantTop );
		{

			let seed = 23;
			const rnd = () => ( ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647 );
			plaster.vdata = [ 0, 0, 0.53, 4 ];
			for ( let i = 0; i < 260; i ++ ) {

				const t = rnd(), o = 0.1 + rnd() * ( PLANT_OUT - 0.2 ), hang = rnd() < 0.15;
				const x = Q0[ 0 ] + ( Q1[ 0 ] - Q0[ 0 ] ) * t + intoT[ 0 ] * ( hang ? - 0.05 : o ), z = Q0[ 1 ] + ( Q1[ 1 ] - Q0[ 1 ] ) * t + intoT[ 1 ] * ( hang ? - 0.05 : o );
				const y = hang ? plantTop - rnd() * 0.9 : plantTop + rnd() * rnd() * 1.1;
				const sz = 0.12 + rnd() * 0.2, flower = rnd() < 0.08;
				plaster.color = lin( flower ? [ 0.85, 0.35, 0.15 ] : [ 0.16 + rnd() * 0.1, 0.32 + rnd() * 0.12, 0.1 ] );
				plaster.box( x, y, z, sz, sz * 0.8, sz, rnd() * 3 );

			}

		}

		// the garden's wall along the lane: from the planter's lane end to the house, low, whitewashed with
		// a blue band, a gateway past its middle with quoins either side and a small black gate standing open
		{

			const u = intoT.map( ( v ) => - v ), P0 = [ Q0[ 0 ], Q0[ 1 ] ], L = GD.s1 - GD.s0;
			const pt = ( t, o = 0 ) => [ P0[ 0 ] + u[ 0 ] * t + along[ 0 ] * o, P0[ 1 ] + u[ 1 ] * t + along[ 1 ] * o ];
			const groundAt = ( t ) => T.heightAt( ...pt( t, - 0.3 ) );
			const GAP = 1.6, gc = L * 0.55, g0 = gc - GAP / 2, g1 = gc + GAP / 2, WALL_H = 1.45;
			for ( const [ t0, t1, ends ] of [ [ 0, g0, [ false, true ] ], [ g1, L, [ true, false ] ] ] ) {

				straightWall( pt( t0 ), pt( t1 ), along, ( t ) => groundAt( t0 + ( t1 - t0 ) * t ) + WALL_H, BLUE, 0.62, ends );

			}

			// the gateway's quoins, and the gate swung in against the wall
			for ( const t of [ g0, g1 ] ) quoins( pt( t, 0 ), t === g0 ? u.map( ( v ) => - v ) : u, along, groundAt( t ) - 0.1, groundAt( t ) + WALL_H );
			iron.vdata = [ 0, 0, 0, 0 ];
			const y0 = groundAt( gc ), leaf = 1.4, hinge = pt( g1, TH ), open = 1.75;
			const dir = [ - u[ 0 ] * Math.cos( open ) + along[ 0 ] * Math.sin( open ), - u[ 1 ] * Math.cos( open ) + along[ 1 ] * Math.sin( open ) ];
			const mid = [ hinge[ 0 ] + dir[ 0 ] * leaf / 2, hinge[ 1 ] + dir[ 1 ] * leaf / 2 ], yaw = Math.atan2( - dir[ 1 ], dir[ 0 ] );
			iron.box( mid[ 0 ], y0 + 0.95, mid[ 1 ], leaf, 1.7, 0.05, yaw );
			this.colliders.addBox( new Vector3( mid[ 0 ], y0 + 0.95, mid[ 1 ] ), new Vector3( leaf / 2, 0.85, 0.05 ), yaw, { walkable: false, tag: 'gate' } );

		}



		// on the left, past the gap into the bed, the L-shaped wall: level with the flight's top, a pier at its
		// start (its foot yellow, whitewashed, a stone cap and a terracotta urn), along the flight's upper half
		// with the balustrade on it, then turning away from the lane to the house, white with a yellow band on
		// the bed's side; from the street above only its balustrade shows
		{

			const W2 = 0.56, sP = pe.L_START + W2 / 2, [ x, z ] = lanePt( sP, H + TH / 2 ), yaw = yawAt( sP ), r = pe.surf( sP );
			const LTOP = pe.LTOP, bottom = Math.min( r, pe.bedY( sP ) ) - 0.4, top = LTOP + 0.75, band = r + 0.45;
			plaster.vdata = [ 0, 0, 0.27, 4 ];
			plaster.color = YELLOW;
			plaster.box( x, ( bottom + band ) / 2, z, W2, band - bottom, W2, yaw );
			plaster.color = lin( [ 0.93, 0.92, 0.89 ] );
			plaster.box( x, ( band + top ) / 2, z, W2, top - band, W2, yaw, 'bottom' );
			kit.vdata = [ 0.43, 0.6, 0, 0 ];
			kit.color = [ 0.66, 0.65, 0.6 ];
			kit.box( x, top + 0.06, z, W2 + 0.1, 0.12, W2 + 0.1, yaw );
			plaster.color = lin( [ 0.62, 0.33, 0.2 ] );
			plaster.box( x, top + 0.17, z, 0.16, 0.1, 0.16, yaw );
			for ( const turn of [ 0, Math.PI / 4 ] ) plaster.box( x, top + 0.37, z, 0.32, 0.3, 0.32, yaw + turn );
			plaster.box( x, top + 0.55, z, 0.36, 0.06, 0.36, yaw + Math.PI / 8 );
			plaster.color = lin( [ 0.2, 0.3, 0.12 ] );
			plaster.box( x, top + 0.64, z, 0.3, 0.14, 0.3, yaw + 0.3 ); // a plant in it
			this.colliders.addBox( new Vector3( x, ( bottom + top ) / 2, z ), new Vector3( W2 / 2, ( top - bottom ) / 2, W2 / 2 ), yaw, { walkable: false, tag: 'wall' } );

			// along the flight
			const s0 = sP + W2 / 2, s1 = pe.ST + TH;
			wallRun( 1, s0, s1, () => LTOP );
			balustrade( 1, s0, s1, () => LTOP );

			// the turn: from the flight's top away from the lane to the house
			const q = pe.at( pe.ST ), left = [ q.lx, q.lz ], back = [ q.dx, q.dz ];
			const P0 = lanePt( pe.ST, H + TH );
			let len = 10;
			for ( let t = 0.5; t < 14; t += 0.1 ) {

				const px = P0[ 0 ] + left[ 0 ] * t + back[ 0 ] * TH / 2, pz = P0[ 1 ] + left[ 1 ] * t + back[ 1 ] * TH / 2;
				if ( OSM.buildings.some( ( bd ) => Math.abs( bd.pts[ 0 ][ 0 ] - px ) < 40 && Math.abs( bd.pts[ 0 ][ 1 ] - pz ) < 40 && pointInPolygon( px, pz, bd.pts ) ) ) {

					len = t + 0.1;
					break;

				}

			}

			const P1 = [ P0[ 0 ] + left[ 0 ] * len, P0[ 1 ] + left[ 1 ] * len ];
			straightWall( P0, P1, back, () => LTOP, YELLOW, 1.3, [ false, false ] );
			// on the street's side, a level border of setts along it over the ground's rise from the bed
			{

				const BW = 1.0, c = [ ( P0[ 0 ] + P1[ 0 ] ) / 2 + back[ 0 ] * ( TH + BW / 2 ), ( P0[ 1 ] + P1[ 1 ] ) / 2 + back[ 1 ] * ( TH + BW / 2 ) ];
				const yaw2 = Math.atan2( - left[ 1 ], left[ 0 ] ), top2 = LTOP - 0.02, bot2 = LTOP - 1.6;
				kit.vdata = [ 0.29, 0.6, 0, 0 ];
				kit.color = [ 0.8, 0.78, 0.74 ];
				kit.box( c[ 0 ], ( top2 + bot2 ) / 2, c[ 1 ], len + TH, top2 - bot2, BW, yaw2, 'bottom' );
				this.colliders.addBox( new Vector3( c[ 0 ], ( top2 + bot2 ) / 2, c[ 1 ] ), new Vector3( ( len + TH ) / 2, ( top2 - bot2 ) / 2, BW / 2 ), yaw2, { walkable: true, tag: 'terrace' } );

			}
			// its balustrade, level: plinth, rail, balusters
			kit.vdata = [ 0.43, 0.6, 0, 0 ];
			kit.color = [ 0.66, 0.65, 0.6 ];
			const mid = [ ( P0[ 0 ] + P1[ 0 ] ) / 2 + back[ 0 ] * TH / 2, ( P0[ 1 ] + P1[ 1 ] ) / 2 + back[ 1 ] * TH / 2 ], lyaw = Math.atan2( - left[ 1 ], left[ 0 ] );
			kit.box( mid[ 0 ], LTOP + 0.03, mid[ 1 ], len, 0.1, 0.3, lyaw );
			kit.box( mid[ 0 ], LTOP + 0.655, mid[ 1 ], len, 0.11, 0.32, lyaw );
			for ( let t = 0.3; t < len - 0.15; t += 0.3 ) {

				const bx = P0[ 0 ] + left[ 0 ] * t + back[ 0 ] * TH / 2, bz = P0[ 1 ] + left[ 1 ] * t + back[ 1 ] * TH / 2;
				kit.box( bx, LTOP + 0.34, bz, 0.11, 0.52, 0.13, lyaw );

			}

			this.colliders.addBox( new Vector3( mid[ 0 ], LTOP + 0.35, mid[ 1 ] ), new Vector3( len / 2, 0.36, 0.16 ), lyaw, { walkable: false, tag: 'wall' } );

		}

		// the two old plane trees in the bed, and on the square behind the corner wall a garden's trees
		// (Trees grows them)
		this.extraTrees = [ [ 6.5, H + TH + 2.6, 1.0, 'plane' ], [ 11.8, H + TH + 3.2, 0.92, 'plane' ],
			[ RS0 + 3.2, - ( H + 10.5 ), 1.2, 'olive' ], [ RS0 + 6.5, - ( H + 12 ), 1.0, 'cypress' ],
			// in the paved garden in front of the corner wall
			[ GD.s1 - 2.2, - ( GD.front + 2.6 ), 1.1, 'garden' ], [ GD.s0 + 2.0, - ( GD.front + 3.6 ), 1.0, 'garden' ], [ ( GD.s0 + GD.s1 ) / 2, - ( GD.back - 1.6 ), 1.15, 'olive' ] ].map( ( [ sv, dd, scale, kind ] ) => {

			const [ x, z ] = lanePt( sv, dd );
			return { kind, x, z, scale };

		} );

		// outside, the way up to the gate (photo references/...-acessoportaeste; TerrainData shapes the lane): a
		// stone bollard left of the threshold's steps, a low wall along the verge on the left, whitewashed over a
		// yellow foot, plants over it, and at the lane's foot the Chafariz Novo
		{

			const A = pe.ACCESS, at = ( t, d ) => [ A.S[ 0 ] + A.dir[ 0 ] * t + A.left[ 0 ] * d, A.S[ 1 ] + A.dir[ 1 ] * t + A.left[ 1 ] * d ];
			const yawA = Math.atan2( - A.dir[ 1 ], A.dir[ 0 ] );
			// the bollard
			{

				const [ x, z ] = onFace( 1.55, FACE + 0.55 ), y0 = T.heightAt( x, z );
				kit.vdata = [ 0.43, 0.55, 0, 0 ];
				kit.color = [ 0.82, 0.8, 0.74 ];
				kit.box( x, y0 + 0.4, z, 0.34, 1.0, 0.34, yawT );
				kit.box( x, y0 + 0.93, z, 0.3, 0.06, 0.3, yawT + 0.785 );
				this.colliders.addBox( new Vector3( x, y0 + 0.45, z ), new Vector3( 0.17, 0.5, 0.17 ), yawT, { walkable: false, tag: 'bollard' } );

			}

			// the verge's wall (photo references/...-img-4392): straight from the street lamp's corner, clear of the
			// street along the walls, to the corner of Casa da Picva (marked on a screenshot); whitewashed over a
			// yellow foot that follows the ground, its top level, stepping down part way along in four small
			// steps, a coping of brick; an iron street lamp on its corner, the parking yard behind its higher part
			// (TerrainData levels it) with a "P" sign, a garden of tall shrubs behind its lower part
			{

				const W = A.WALL, TW = 0.35, pw = W.point, groundAt = W.ground, L = W.length;
				const toLane = [ - W.n[ 0 ], 0, - W.n[ 1 ] ], yawW = Math.atan2( - W.w[ 1 ], W.w[ 0 ] );
				// its stretches, each with a level top: the higher, the four steps, the lower
				const segs = [ [ 0, W.uS, W.topA ] ];
				for ( let i = 0; i < 4; i ++ ) segs.push( [ W.uS + i * 0.25, W.uS + ( i + 1 ) * 0.25, W.topA - ( i + 1 ) * ( W.topA - W.topB ) / 4 ] );
				segs.push( [ W.uS + 1, L, W.topB ] );
				const BAR = 1.6;
				for ( const [ s0, s1, top ] of segs ) for ( let ua = s0; ua < s1 - 0.01; ua += 1 ) {

					const ub = Math.min( s1, ua + 1 ), ga = groundAt( ua ), gb = groundAt( ub ), ya = ga - 0.6, yb = gb - 0.6;
					const P0 = pw( ua ), P1 = pw( ub ), Q0 = pw( ua, TW ), Q1 = pw( ub, TW );
					plaster.color = YELLOW;
					plaster.vdata = [ 20, 0, 0, 0 ];
					plaster.quadFacing( [ P0[ 0 ], ya, P0[ 1 ] ], [ P1[ 0 ], yb, P1[ 1 ] ], [ P1[ 0 ], top, P1[ 1 ] ], [ P0[ 0 ], top, P0[ 1 ] ], toLane,
						[ [ ua, ( ya - ga ) * BAR ], [ ub, ( yb - gb ) * BAR ], [ ub, ( top - gb ) * BAR ], [ ua, ( top - ga ) * BAR ] ] );
					plaster.quadFacing( [ Q0[ 0 ], ya, Q0[ 1 ] ], [ Q1[ 0 ], yb, Q1[ 1 ] ], [ Q1[ 0 ], top, Q1[ 1 ] ], [ Q0[ 0 ], top, Q0[ 1 ] ], toLane.map( ( v ) => - v ), [ [ ua, 3 ], [ ub, 3 ], [ ub, 4 ], [ ua, 4 ] ] );
					// the brick coping
					plaster.color = lin( [ 0.66, 0.34, 0.22 ] );
					plaster.vdata = [ 0, 0, 0.19, 4 ];
					const [ cx, cz ] = pw( ( ua + ub ) / 2, TW / 2 );
					plaster.box( cx, top + 0.04, cz, ub - ua + 0.01, 0.08, TW + 0.06, yawW );
					this.colliders.addBox( new Vector3( cx, ( top + Math.min( ya, yb ) ) / 2, cz ), new Vector3( ( ub - ua ) / 2 + 0.02, ( top - Math.min( ya, yb ) ) / 2, TW / 2 ), yawW, { walkable: false, tag: 'wall' } );

				}

				// its ends, and the risers where its top steps down
				plaster.color = YELLOW;
				plaster.vdata = [ 20, 0, 0, 0 ];
				for ( const [ u, top, sgn ] of [ [ 0, W.topA, - 1 ], [ L, W.topB, 1 ] ] ) {

					const g = groundAt( u ), E0 = pw( u ), E1 = pw( u, TW );
					plaster.quadFacing( [ E0[ 0 ], g - 0.6, E0[ 1 ] ], [ E1[ 0 ], g - 0.6, E1[ 1 ] ], [ E1[ 0 ], top, E1[ 1 ] ], [ E0[ 0 ], top, E0[ 1 ] ], [ W.w[ 0 ] * sgn, 0, W.w[ 1 ] * sgn ],
						[ [ 0, - 0.96 ], [ TW, - 0.96 ], [ TW, ( top - g ) * BAR ], [ 0, ( top - g ) * BAR ] ] );

				}

				for ( let i = 1; i < segs.length; i ++ ) {

					const u = segs[ i ][ 0 ], hi = segs[ i - 1 ][ 2 ], lo = segs[ i ][ 2 ], E0 = pw( u ), E1 = pw( u, TW );
					plaster.quadFacing( [ E0[ 0 ], lo, E0[ 1 ] ], [ E1[ 0 ], lo, E1[ 1 ] ], [ E1[ 0 ], hi, E1[ 1 ] ], [ E0[ 0 ], hi, E0[ 1 ] ], [ W.w[ 0 ], 0, W.w[ 1 ] ],
						[ [ 0, 5 ], [ TW, 5 ], [ TW, 5.2 ], [ 0, 5.2 ] ] );

				}

				// level behind it, over the ground's rise to the yard and the bed: paving, then earth
				for ( const [ s0, s1, y, color, tag ] of [ [ 0, W.uS, W.yard, [ 0.8, 0.78, 0.74 ], 'yard' ], [ W.uS, L, W.bed, [ 0.42, 0.33, 0.22 ], 'bed' ] ] ) {

					const [ cx, cz ] = pw( ( s0 + s1 ) / 2, TW + 0.8 ), bottom = Math.min( groundAt( s1 ), y ) - 0.6;
					kit.vdata = [ 0.29, 0.6, 0, 0 ];
					kit.color = color;
					kit.box( cx, ( y + bottom ) / 2, cz, s1 - s0, y - bottom, 1.6, yawW, 'bottom' );
					this.colliders.addBox( new Vector3( cx, ( y + bottom ) / 2, cz ), new Vector3( ( s1 - s0 ) / 2, ( y - bottom ) / 2, 0.8 ), yawW, { walkable: true, tag } );

				}

				// the street lamp on its corner: a fluted cast-iron post, a lantern on top
				{

					const [ x, z ] = pw( 0.25, TW / 2 ), y0 = W.topA + 0.08, warm = new Color( 1.0, 0.66, 0.36 );
					iron.vdata = [ 0, 0, 0, 0 ];
					iron.box( x, y0 + 0.2, z, 0.26, 0.4, 0.26, yawW );
					iron.box( x, y0 + 1.6, z, 0.11, 2.6, 0.11, yawW );
					iron.box( x, y0 + 2.95, z, 0.2, 0.1, 0.2, yawW );
					iron.box( x, y0 + 3.62, z, 0.46, 0.08, 0.46, yawW + 0.785 );
					iron.box( x, y0 + 3.72, z, 0.18, 0.14, 0.18, yawW );
					iron.vdata = [ 1, 0, 0, 0 ];
					iron.box( x, y0 + 3.28, z, 0.34, 0.6, 0.34, yawW, 'top bottom' );
					this.lights.push( { position: new Vector3( x, y0 + 3.25, z ), color: warm, intensity: 10, range: 16, kind: 'lantern', flicker: 0.04 } );
					this.colliders.addBox( new Vector3( x, y0 + 1.6, z ), new Vector3( 0.13, 1.6, 0.13 ), yawW, { walkable: false, tag: 'lamp' } );

				}

				// the parking sign in the yard: a post, a blue panel with a white P
				{

					const [ x, z ] = pw( W.uS - 0.5, 1.1 ), y0 = W.yard;
					iron.vdata = [ 0, 0, 0, 0 ];
					iron.box( x, y0 + 1.1, z, 0.05, 2.2, 0.05, yawW );
					plaster.vdata = [ 0, 0, 0.71, 4 ];
					plaster.color = lin( [ 0.1, 0.27, 0.66 ] );
					plaster.box( x, y0 + 2.05, z, 0.32, 0.5, 0.03, yawW );
					plaster.color = lin( [ 0.95, 0.95, 0.93 ] );
					const toward = [ - W.n[ 0 ] * 0.02, - W.n[ 1 ] * 0.02 ];
					plaster.box( x + toward[ 0 ] - W.w[ 0 ] * 0.04, y0 + 2.1, z + toward[ 1 ] - W.w[ 1 ] * 0.04, 0.05, 0.26, 0.012, yawW );
					plaster.box( x + toward[ 0 ] + W.w[ 0 ] * 0.02, y0 + 2.18, z + toward[ 1 ] + W.w[ 1 ] * 0.02, 0.1, 0.1, 0.012, yawW );

				}

				// tall shrubs in the garden behind its lower part (Trees grows them)
				this.extraTrees = this.extraTrees || [];
				for ( const [ u, v, kind, scale ] of [ [ W.uS + 1.6, 1.4, 'cypress', 0.42 ], [ W.uS + 2.6, 2.4, 'cypress', 0.5 ], [ W.uS + 4.2, 1.6, 'garden', 0.7 ], [ L - 1.5, 1.8, 'garden', 0.6 ] ] ) {

					const [ x, z ] = pw( u, v );
					this.extraTrees.push( { kind, x, z, scale } );

				}

			}

			// the Chafariz Novo: a whitewashed front facing up the lane, a stepped gable rising over its middle,
			// low wings either side ending in scrolls, their ends and its foot painted yellow
			{

				const F = [ 106.05, 51.5 ], fx = - 1, y0 = T.heightAt( F[ 0 ] - 0.6, F[ 1 ] ), yaw = 0;
				const WHITE = lin( [ 0.95, 0.94, 0.91 ] );
				plaster.vdata = [ 0, 0, 0.61, 4 ];
				const box = ( dx, z, w, y, h, dep, color ) => {

					plaster.color = color;
					plaster.box( F[ 0 ] - fx * ( dep / 2 ) + dx, y + h / 2, z, dep, h, w, yaw );

				};
				const D = 1.2;
				box( 0, F[ 1 ], 3.0, y0 - 0.4, 2.0, D, WHITE ); // its body
				box( 0, F[ 1 ], 2.4, y0 + 1.6, 0.35, D - 0.1, WHITE );
				box( 0, F[ 1 ], 1.6, y0 + 1.95, 0.3, D - 0.2, WHITE );
				box( 0, F[ 1 ], 0.8, y0 + 2.25, 0.25, D - 0.3, WHITE );
				box( 0, F[ 1 ], 3.04, y0 - 0.4, 0.55, D + 0.04, YELLOW ); // its foot
				for ( const side of [ - 1, 1 ] ) {

					// the wing, stepping down, and its scroll's end
					box( 0.1, F[ 1 ] + side * 2.0, 1.0, y0 - 0.3, 1.1, D - 0.3, WHITE );
					box( 0.15, F[ 1 ] + side * 2.75, 0.5, y0 - 0.3, 0.75, D - 0.4, WHITE );
					box( 0.2, F[ 1 ] + side * 3.15, 0.34, y0 - 0.3, 0.55, D - 0.5, YELLOW );

				}

				this.colliders.addBox( new Vector3( F[ 0 ] + D / 2, y0 + 0.9, F[ 1 ] ), new Vector3( D / 2, 1.3, 3.3 ), 0, { walkable: false, tag: 'fountain' } );
				// its basin behind, and a spout on its front
				kit.vdata = [ 0.43, 0.5, 0, 0 ];
				kit.color = [ 0.82, 0.8, 0.74 ];
				kit.box( F[ 0 ] - 0.25, y0 + 0.25, F[ 1 ], 0.5, 0.5, 1.2, 0 );
				iron.vdata = [ 0, 0, 0, 0 ];
				iron.box( F[ 0 ] - 0.15, y0 + 0.95, F[ 1 ], 0.3, 0.05, 0.05, 0 );

			}

		}

		for ( const [ k, mat, name ] of [ [ plaster, materials.plaster, 'porta-este' ], [ iron, materials.lantern, 'porta-este-rail' ] ] ) {

			if ( k.empty ) continue;
			const mesh = new Mesh( k.build(), mat );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// An old garden wall from W0 to W1 into plaster: weathered white over a faded yellow foot (or foot), its front on
	// the street (side +1: the street to the left going W0 -> W1, -1 to the right), thick away from it; from
	// streetY( [ x, z ] ) up H0 at W0 to H1 at W1. Ivy over its top and hanging down; flowers: roses and
	// shrubs at its foot.
	_oldWall( plaster, W0, W1, side, streetY, H0, H1, seed, flowers = false, { foot = null, ivy = true } = {} ) {

		const WL = Math.hypot( W1[ 0 ] - W0[ 0 ], W1[ 1 ] - W0[ 1 ] );
		const wu = [ ( W1[ 0 ] - W0[ 0 ] ) / WL, ( W1[ 1 ] - W0[ 1 ] ) / WL ];
		const back = side > 0 ? [ - wu[ 1 ], wu[ 0 ] ] : [ wu[ 1 ], - wu[ 0 ] ]; // away from the street
		const TH = 0.5, FADED = lin( [ 0.8, 0.62, 0.26 ] ), BAR = 0.75;
		plaster.color = foot || FADED;
		plaster.vdata = [ 20, 0, 0.47, 0 ];
		const pt = ( u, k = 0 ) => [ W0[ 0 ] + wu[ 0 ] * u + back[ 0 ] * k, W0[ 1 ] + wu[ 1 ] * u + back[ 1 ] * k ];
		const topAt = ( u ) => streetY( pt( u ) ) + H0 + ( H1 - H0 ) * u / WL;
		const n = Math.ceil( WL ), yaw = Math.atan2( - wu[ 1 ], wu[ 0 ] );
		for ( let i = 0; i < n; i ++ ) {

			const ua = WL * i / n, ub = WL * ( i + 1 ) / n, A = pt( ua ), Bp = pt( ub ), A2 = pt( ua, TH ), B2 = pt( ub, TH );
			const ga = streetY( A ), gb = streetY( Bp ), ya = ga - 0.6, yb = gb - 0.6, ta = topAt( ua ), tb = topAt( ub );
			plaster.quadFacing( [ A[ 0 ], ya, A[ 1 ] ], [ Bp[ 0 ], yb, Bp[ 1 ] ], [ Bp[ 0 ], tb, Bp[ 1 ] ], [ A[ 0 ], ta, A[ 1 ] ], [ - back[ 0 ], 0, - back[ 1 ] ],
				[ [ ua, ( ya - ga ) * BAR ], [ ub, ( yb - gb ) * BAR ], [ ub, ( tb - gb ) * BAR ], [ ua, ( ta - ga ) * BAR ] ] );
			plaster.quadFacing( [ A[ 0 ], ta, A[ 1 ] ], [ Bp[ 0 ], tb, Bp[ 1 ] ], [ B2[ 0 ], tb, B2[ 1 ] ], [ A2[ 0 ], ta, A2[ 1 ] ], [ 0, 1, 0 ], [ [ ua, 5 ], [ ub, 5 ], [ ub, 5.5 ], [ ua, 5.5 ] ] );
			plaster.quadFacing( [ A2[ 0 ], ya, A2[ 1 ] ], [ B2[ 0 ], yb, B2[ 1 ] ], [ B2[ 0 ], tb, B2[ 1 ] ], [ A2[ 0 ], ta, A2[ 1 ] ], [ back[ 0 ], 0, back[ 1 ] ], [ [ ua, 3 ], [ ub, 3 ], [ ub, 4 ], [ ua, 4 ] ] );
			const c = pt( ( ua + ub ) / 2, TH / 2 ), hi = Math.max( ta, tb ), lo = Math.min( ya, yb );
			this.colliders.addBox( new Vector3( c[ 0 ], ( hi + lo ) / 2, c[ 1 ] ), new Vector3( ( ub - ua ) / 2 + 0.02, ( hi - lo ) / 2, TH / 2 ), yaw, { walkable: false, tag: 'wall' } );

		}

		for ( const u of [ 0, WL ] ) {

			// its ends
			const E = pt( u ), E2 = pt( u, TH ), g = streetY( E ), tt = topAt( u ), dir = u === 0 ? - 1 : 1;
			plaster.quadFacing( [ E[ 0 ], g - 0.6, E[ 1 ] ], [ E2[ 0 ], g - 0.6, E2[ 1 ] ], [ E2[ 0 ], tt, E2[ 1 ] ], [ E[ 0 ], tt, E[ 1 ] ], [ wu[ 0 ] * dir, 0, wu[ 1 ] * dir ],
				[ [ 0, - 0.45 ], [ TH, - 0.45 ], [ TH, ( tt - g ) * BAR ], [ 0, ( tt - g ) * BAR ] ] );

		}

		// ivy over its top, strands hanging down its face
		let s = seed;
		const rnd = () => ( ( s = ( s * 16807 ) % 2147483647 ) / 2147483647 );
		plaster.vdata = [ 0, 0, 0.53, 4 ];
		for ( let i = 0; ivy && i < 26 * WL; i ++ ) {

			const u = rnd() * WL, dense = 0.5 + 0.5 * Math.sin( u * 0.9 + seed );
			if ( rnd() > 0.3 + 0.7 * dense ) continue;
			const hang = rnd() < 0.55, drop = hang ? rnd() * rnd() * ( topAt( u ) - streetY( pt( u ) ) ) * 0.9 : 0;
			const P = pt( u, hang ? - 0.06 : rnd() * TH * 1.6 ), y = topAt( u ) - drop + ( hang ? 0 : rnd() * 0.5 ), sz = 0.1 + rnd() * 0.16;
			plaster.color = lin( [ 0.14 + rnd() * 0.1, 0.26 + rnd() * 0.12, 0.09 ] );
			plaster.box( P[ 0 ], y, P[ 1 ], hang ? sz * 0.6 : sz, sz, hang ? 0.05 : sz, rnd() * 3 );

		}

		if ( ! flowers ) return;
		// shrubs and roses at its foot, in a narrow kerbed bed along it
		for ( let i = 0; i < 40 * WL; i ++ ) {

			const u = 0.3 + rnd() * ( WL - 0.6 ), k = - 0.05 - rnd() * 0.55, P = pt( u, k ), g = streetY( P );
			if ( rnd() > 0.55 + 0.45 * Math.sin( u * 0.7 ) ) continue;
			const y = g + rnd() * rnd() * 1.8, sz = 0.12 + rnd() * 0.2, bloom = rnd();
			plaster.color = lin( bloom < 0.12 ? [ 0.92, 0.6, 0.66 ] : bloom < 0.2 ? [ 0.9, 0.35, 0.15 ] : [ 0.15 + rnd() * 0.1, 0.3 + rnd() * 0.15, 0.1 ] );
			plaster.box( P[ 0 ], y, P[ 1 ], sz, sz * 0.8, sz, rnd() * 3 );

		}

		this.kit.vdata = [ 0.43, 0.55, 0, 0 ];
		this.kit.color = [ 0.8, 0.78, 0.72 ];
		const kc = pt( WL / 2, - 0.62 );
		this.kit.box( kc[ 0 ], streetY( kc ) + 0.02, kc[ 1 ], WL - 0.4, 0.2, 0.12, yaw ); // the bed's kerb

	}

	// golden quoins up a corner at P (world xz), on the two faces running along faces[ 0 ] and faces[ 1 ]
	// (unit xz, away from the corner), from y0 to y1
	_quoinCorner( P, faces, y0, y1 ) {

		const kit = this.kit;
		kit.vdata = [ 0.43, 0.45, 0, 0 ];
		kit.color = [ 1.02, 0.86, 0.6 ];
		const [ u1, u2 ] = faces;
		for ( let y = y0, k = 0; y < y1 - 0.1; k ++ ) {

			const h = Math.min( y1 - 0.02 - y, 0.34 ), wa = k % 2 ? 0.28 : 0.5, wb = k % 2 ? 0.5 : 0.28;
			for ( const [ u, o, w ] of [ [ u1, u2, wa ], [ u2, u1, wb ] ] ) kit.box( P[ 0 ] + u[ 0 ] * w / 2 - o[ 0 ] * 0.02, y + h / 2, P[ 1 ] + u[ 1 ] * w / 2 - o[ 1 ] * 0.02, w, h - 0.04, 0.04, Math.atan2( - u[ 1 ], u[ 0 ] ) );
			y += h;

		}

	}

	// Rua da Porta da Senhora da Graça, outside the walls north from Porta Este (photo
	// references/...-inicio-de-rua-entre-porta-este-e-nordest; TerrainData lays the street): a no-entry sign
	// on its right; on Casa da Picva's front, set back across the parking yard, its name in a panel of
	// azulejos, wisteria round it.
	_senhoraDaGraca( materials ) {

		const S = this.terrain.senhoraDaGraca;
		if ( ! S ) return;
		const T = this.terrain, plaster = new MeshKit(), iron = new MeshKit();

		// the no-entry sign: a post, a red disc with its white bar, facing back down the street
		{

			const x = 85.2, z = 41.0, y0 = T.heightAt( x, z ), yaw = Math.atan2( 0.96, 0.29 );
			iron.vdata = [ 0, 0, 0, 0 ];
			iron.box( x, y0 + 1.2, z, 0.06, 2.4, 0.06, yaw );
			plaster.vdata = [ 0, 0, 0.53, 4 ];
			const n = 6, r = 0.3, fx = [ 0.29 * 0.05, - 0.96 * 0.05 ]; // (toward the gate)
			plaster.color = lin( [ 0.78, 0.1, 0.08 ] );
			for ( let i = 0; i < n; i ++ ) {

				const v0 = - r + 2 * r * i / n, v1 = v0 + 2 * r / n, vm = Math.max( Math.abs( v0 ), Math.abs( v1 ) ) * 0.85;
				plaster.box( x + fx[ 0 ], y0 + 2.1 + ( v0 + v1 ) / 2, z + fx[ 1 ], 2 * Math.sqrt( Math.max( 0, r * r - vm * vm ) ), v1 - v0, 0.03, yaw );

			}

			plaster.color = lin( [ 0.95, 0.95, 0.93 ] );
			plaster.box( x + fx[ 0 ] * 1.5, y0 + 2.1, z + fx[ 1 ] * 1.5, 0.4, 0.09, 0.02, yaw );
			this.colliders.addBox( new Vector3( x, y0 + 1.2, z ), new Vector3( 0.05, 1.2, 0.05 ), 0, { walkable: false, tag: 'sign' } );

		}

		// Casa da Picva's name: a panel of azulejos on its front (OSM's face from ( 94.3, 32.7 ) to ( 89.9, 42.9 ),
		// facing the street), white with a blue border and lettering, wisteria arching round it
		{

			const A = [ 94.3, 32.7 ], B = [ 89.9, 42.9 ], L = Math.hypot( B[ 0 ] - A[ 0 ], B[ 1 ] - A[ 1 ] );
			const u = [ ( B[ 0 ] - A[ 0 ] ) / L, ( B[ 1 ] - A[ 1 ] ) / L ], out = [ u[ 1 ], - u[ 0 ] ]; // (west, to the street)
			const at = ( s, k ) => [ A[ 0 ] + u[ 0 ] * s + out[ 0 ] * k, A[ 1 ] + u[ 1 ] * s + out[ 1 ] * k ];
			const yaw = Math.atan2( - u[ 1 ], u[ 0 ] ), sP = L * 0.62, g = T.heightAt( ...at( sP, 1 ) ), yP = g + 1.75;
			plaster.vdata = [ 0, 0, 0.37, 4 ];
			const [ px, pz ] = at( sP, 0.04 );
			plaster.color = lin( [ 0.14, 0.3, 0.7 ] );
			plaster.box( px, yP, pz, 1.3, 0.85, 0.03, yaw );
			const [ qx, qz ] = at( sP, 0.06 );
			plaster.color = lin( [ 0.94, 0.94, 0.9 ] );
			plaster.box( qx, yP, qz, 1.12, 0.67, 0.02, yaw );
			plaster.color = lin( [ 0.14, 0.3, 0.7 ] );
			for ( let i = 0; i < 5; i ++ ) {

				const [ lx, lz ] = at( sP - 0.36 + i * 0.18, 0.075 );
				plaster.box( lx, yP + 0.12, lz, 0.13, 0.22, 0.01, yaw ); // the letters

			}

			const [ dx, dz ] = at( sP, 0.075 );
			plaster.box( dx, yP - 0.18, dz, 0.8, 0.05, 0.01, yaw ); // the scroll under them
			// the wisteria: up either side of it and over, leaves and a few mauve flowers
			let seed = 53;
			const rnd = () => ( ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647 );
			plaster.vdata = [ 0, 0, 0.53, 4 ];
			for ( let i = 0; i < 260; i ++ ) {

				const t = rnd(), arc = t * Math.PI, ds = - Math.cos( arc ) * ( 1.05 + rnd() * 0.25 ), dy = t < 0.15 || t > 0.85 ? - 1.6 + rnd() * 2.4 : Math.sin( arc ) * 1.0 + rnd() * 0.3;
				const [ x, z ] = at( sP + ds, 0.08 + rnd() * 0.3 ), sz = 0.1 + rnd() * 0.16;
				plaster.color = lin( rnd() < 0.1 ? [ 0.62, 0.5, 0.78 ] : [ 0.2 + rnd() * 0.12, 0.36 + rnd() * 0.12, 0.12 ] );
				plaster.box( x, yP + dy, z, sz, sz, sz * 0.7, rnd() * 3 );

			}

		}

		for ( const [ k, mat, name ] of [ [ plaster, materials.plaster, 'senhora-da-graca' ], [ iron, materials.lantern, 'senhora-da-graca-iron' ] ] ) {

			if ( k.empty ) continue;
			const mesh = new Mesh( k.build(), mat );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// The stairs by the Biblioteca Municipal (photo references/...-escadariabiblioteca; TerrainData shapes the
	// ground): one long flight of steps, cobbled treads with nosings of worn limestone, up from Rua Padre Nunes
	// Tavares to a landing at São Pedro's front. On the right the library yard's tall wall, whitewashed with a
	// deep blue band along its foot, a barred window in it and a blue border up its far end; on the left a low
	// weathered wall with a dark foot, the church garden behind it with two clipped round bushes, a taller
	// stretch of it at its top by the church. An iron handrail up the left of the middle, on posts with forked
	// heads, running on level at the foot and turning down into the ground.
	_escadariaBiblioteca( materials ) {

		const B = this.terrain.biblioteca;
		if ( ! B ) return;
		const kit = this.kit, T = this.terrain;
		const plaster = new MeshKit(), iron = new MeshKit();
		const TH = 0.4;

		// the steps
		for ( let i = 0; i < B.N; i ++ ) {

			const x0 = B.xb - i * B.tread, x1 = x0 - B.tread, xc = ( x0 + x1 ) / 2, top = B.yB + ( i + 1 ) * B.rise, bottom = top - B.rise - 0.5;
			const zn = B.north( xc ), zs = B.south( xc ), zc = ( zn + zs ) / 2, w = zs - zn;
			kit.vdata = [ 0.29, 0.6, 0, 0 ];
			kit.color = [ 0.84, 0.81, 0.73 ];
			kit.box( xc, ( top + bottom ) / 2, zc, B.tread + 0.02, top - bottom, w, 0, 'bottom' );
			this.colliders.addBox( new Vector3( xc, ( top + bottom ) / 2, zc ), new Vector3( B.tread / 2 + 0.01, ( top - bottom ) / 2, w / 2 ), 0, { walkable: true, tag: 'stair' } );
			kit.vdata = [ 0.43, 0.55, 0, 0 ];
			kit.color = [ 0.9, 0.86, 0.76 ];
			kit.box( x0 - 0.09, top - 0.07 + 0.005, zc, 0.18, 0.14, w + 0.02, 0 );

		}

		// a wall along one side from x0 down to x1 (x0 > x1), on the line z( x ), thick away from the steps (dir
		// -1 north, +1 south), top( x ); its band from the surface beside it, scaled by bar
		const wallAlong = ( z, dir, x0, x1, top, color, bar ) => {

			plaster.color = color;
			plaster.vdata = [ 20, 0, 0.13, 0 ];
			const cuts = [ x0 ];
			for ( let x = Math.floor( x0 ); x > x1 + 0.3; x -= 1 ) if ( x < x0 - 0.05 ) cuts.push( x );
			cuts.push( x1 );
			for ( let i = 0; i + 1 < cuts.length; i ++ ) {

				const xa = cuts[ i ], xb = cuts[ i + 1 ], za = z( xa ), zb = z( xb ), ra = B.surf( xa ), rb = B.surf( xb );
				const ya = Math.min( ra, T.heightAt( xa, za + dir * ( TH + 0.3 ) ) ) - 0.6, yb = Math.min( rb, T.heightAt( xb, zb + dir * ( TH + 0.3 ) ) ) - 0.6;
				const ta = top( xa ), tb = top( xb ), toSteps = [ 0, 0, - dir ];
				const A = [ xa, za ], Bp = [ xb, zb ], A2 = [ xa, za + dir * TH ], B2 = [ xb, zb + dir * TH ];
				plaster.quadFacing( [ A[ 0 ], ya, A[ 1 ] ], [ Bp[ 0 ], yb, Bp[ 1 ] ], [ Bp[ 0 ], tb, Bp[ 1 ] ], [ A[ 0 ], ta, A[ 1 ] ], toSteps,
					[ [ xa, ( ya - ra ) * bar ], [ xb, ( yb - rb ) * bar ], [ xb, ( tb - rb ) * bar ], [ xa, ( ta - ra ) * bar ] ] );
				plaster.quadFacing( [ A2[ 0 ], ya, A2[ 1 ] ], [ B2[ 0 ], yb, B2[ 1 ] ], [ B2[ 0 ], tb, B2[ 1 ] ], [ A2[ 0 ], ta, A2[ 1 ] ], [ 0, 0, dir ],
					[ [ xa, 2 ], [ xb, 2 ], [ xb, 3 ], [ xa, 3 ] ] );
				plaster.quadFacing( [ A[ 0 ], ta, A[ 1 ] ], [ Bp[ 0 ], tb, Bp[ 1 ] ], [ B2[ 0 ], tb, B2[ 1 ] ], [ A2[ 0 ], ta, A2[ 1 ] ], [ 0, 1, 0 ],
					[ [ xa, 5 ], [ xb, 5 ], [ xb, 5.4 ], [ xa, 5.4 ] ] );
				for ( const [ end, x, E, E2, y0, h, r, nx ] of [ [ i === 0, xa, A, A2, ya, ta, ra, 1 ], [ i + 2 === cuts.length, xb, Bp, B2, yb, tb, rb, - 1 ] ] ) {

					if ( ! end ) continue;
					plaster.quadFacing( [ E[ 0 ], y0, E[ 1 ] ], [ E2[ 0 ], y0, E2[ 1 ] ], [ E2[ 0 ], h, E2[ 1 ] ], [ E[ 0 ], h, E[ 1 ] ], [ nx, 0, 0 ],
						[ [ 0, ( y0 - r ) * bar ], [ TH, ( y0 - r ) * bar ], [ TH, ( h - r ) * bar ], [ 0, ( h - r ) * bar ] ] );

				}

				const xm = ( xa + xb ) / 2, zm = ( za + zb ) / 2 + dir * TH / 2, hi = Math.max( ta, tb ), lo = Math.min( ya, yb );
				this.colliders.addBox( new Vector3( xm, ( hi + lo ) / 2, zm ), new Vector3( ( xa - xb ) / 2 + 0.02, ( hi - lo ) / 2, TH / 2 ), Math.atan2( zb - za, xa - xb ), { walkable: false, tag: 'wall' } );

			}

		};

		// the library yard's wall (right, north): tall, its blue band deep
		const BLUE = lin( [ 0.1, 0.27, 0.78 ] ), WHITE = lin( [ 0.93, 0.92, 0.89 ] ), DARK = lin( [ 0.2, 0.2, 0.19 ] );
		const xYard = B.xt + 6.8; // where the yard ends and the library begins (its own walls)
		wallAlong( B.north, - 1, B.xb + 1.2, xYard, () => B.yT + 1.6, BLUE, 0.55 );
		// a blue border up its far end, and a barred window
		{

			const z = B.north( xYard ) + 0.01, y0 = B.surf( xYard ), y1 = B.yT + 1.6;
			plaster.color = BLUE;
			plaster.vdata = [ 0, 0, 0.21, 4 ];
			plaster.box( xYard + 0.15, ( y0 + y1 ) / 2, z + 0.01, 0.3, y1 - y0, 0.02, 0 );
			const xw = xYard + 3.2, zw = B.north( xw ) + 0.02, yw = B.surf( xw ) + 2.4;
			plaster.color = lin( [ 0.12, 0.12, 0.13 ] );
			plaster.box( xw, yw, zw, 0.7, 1.1, 0.02, 0 );
			plaster.color = lin( [ 0.8, 0.77, 0.7 ] );
			for ( const [ dx, dy, sx, sy ] of [ [ 0, 0.62, 0.92, 0.12 ], [ 0, - 0.62, 0.92, 0.12 ], [ 0.41, 0, 0.12, 1.36 ], [ - 0.41, 0, 0.12, 1.36 ] ] ) plaster.box( xw + dx, yw + dy, zw, sx, sy, 0.04, 0 );
			iron.vdata = [ 0, 0, 0, 0 ];
			for ( let k = - 2; k <= 2; k ++ ) iron.box( xw + k * 0.14, yw, zw + 0.06, 0.025, 1.1, 0.025, 0 );
			for ( const dy of [ - 0.35, 0.05, 0.4 ] ) iron.box( xw, yw + dy, zw + 0.06, 0.7, 0.025, 0.025, 0 );

		}

		// the garden's wall (left, south): low, weathered white over a dark foot, taller by the church
		const xLow = B.xt + 7.6;
		wallAlong( B.south, 1, B.xb + 0.3, xLow, ( x ) => B.surf( x ) + 0.85, DARK, 1.6 );
		wallAlong( B.south, 1, xLow, xLow - 1.6, () => B.surf( xLow ) + 2.3, WHITE, 1.6 );
		// two clipped round bushes in the garden behind it (Trees grows them)
		this.extraTrees = this.extraTrees || [];
		for ( const [ x, dz, scale ] of [ [ xLow + 1.5, 2.2, 0.62 ], [ xLow + 3.4, 2.8, 0.55 ] ] ) this.extraTrees.push( { kind: 'garden', x, z: B.south( x ) + dz, scale } );

		// the handrail, a third of the way across from the left
		iron.vdata = [ 0, 0, 0, 0 ];
		const zr = ( x ) => B.south( x ) - ( B.south( x ) - B.north( x ) ) * 0.33;
		const RAIL = 0.9, W = 0.045;
		const tread = ( x ) => x >= B.xb ? B.yB : x <= B.xt ? B.yT : B.yB + ( Math.floor( ( B.xb - x ) / B.tread ) + 1 ) * B.rise;
		const P = ( x, y ) => [ x, y, zr( x ) ];
		const r0 = B.xb - 0.1, r1 = B.xt + 0.1, foot = B.xb + 0.5, head = B.xt - 0.4;
		const y0 = B.surf( r0 ) + RAIL, y1 = B.surf( r1 ) + RAIL;
		ironBar( iron, P( r0, y0 ), P( r1, y1 ), W );
		ironBar( iron, P( foot, y0 ), P( r0, y0 ), W );
		ironBar( iron, P( r1, y1 ), P( head, y1 ), W );
		ironBar( iron, P( foot, tread( foot ) - 0.05 ), P( foot, y0 + W / 2 ), W );
		ironBar( iron, P( head, tread( head ) - 0.05 ), P( head, y1 + W / 2 ), W );
		const NP = Math.max( 3, Math.round( ( r0 - r1 ) / 2.3 ) );
		for ( let k = 0; k <= NP; k ++ ) {

			const x = r0 - 0.4 - ( r0 - r1 - 0.8 ) * k / NP, yr = B.surf( x ) + RAIL, yb = tread( x ), z = zr( x );
			iron.box( x, ( yb + yr - 0.12 ) / 2, z, 0.04, yr - 0.12 - yb, 0.04, 0 );
			iron.box( x, yr - 0.12, z, 0.035, 0.03, 0.15, 0 );
			for ( const side of [ - 1, 1 ] ) iron.box( x, yr - 0.05, z + side * 0.065, 0.03, 0.15, 0.022, 0 );
			this.colliders.addBox( new Vector3( x, ( yb + yr ) / 2, z ), new Vector3( 0.05, ( yr - yb ) / 2, 0.08 ), 0, { walkable: false, tag: 'rail' } );

		}

		for ( const [ x, y ] of [ [ foot, y0 ], [ head, y1 ] ] ) this.colliders.addBox( new Vector3( x, ( tread( x ) + y ) / 2, zr( x ) ), new Vector3( 0.05, ( y - tread( x ) ) / 2, 0.05 ), 0, { walkable: false, tag: 'rail' } );

		for ( const [ k, mat, name ] of [ [ plaster, materials.plaster, 'escadaria-biblioteca' ], [ iron, materials.lantern, 'escadaria-biblioteca-rail' ] ] ) {

			if ( k.empty ) continue;
			const mesh = new Mesh( k.build(), mat );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// Travessa do Beneficiado (photo references/...-ruaperpendiculara; TerrainData lays the climb): the long
	// steps' edges, rows of worn stones across the alley every metre and a third; on the right the walled
	// garden's tall old wall, weathered white over a faded yellow foot, ivy hanging over its top.
	_beneficiado( materials ) {

		const B = this.terrain.beneficiado;
		if ( ! B ) return;
		const kit = this.kit, T = this.terrain;
		const plaster = new MeshKit();
		const yaw = Math.atan2( - B.dir[ 1 ], B.dir[ 0 ] ), left = [ B.dir[ 1 ], - B.dir[ 0 ] ];
		const at = ( t, d = 0 ) => [ B.from[ 0 ] + B.dir[ 0 ] * t + left[ 0 ] * d, B.from[ 1 ] + B.dir[ 1 ] * t + left[ 1 ] * d ];

		// the steps' edges
		kit.vdata = [ 0.43, 0.55, 0, 0 ];
		kit.color = [ 0.78, 0.76, 0.7 ];
		for ( let t = 1.2; t < B.length - 0.4; t += 1.35 ) {

			const [ x, z ] = at( t ), y = B.y( t );
			kit.box( x, y - 0.06, z, 0.26, 0.2, 2 * B.HALF + 0.4, yaw );

		}

		// the garden's wall: tall over the alley at its foot, less so up the hill
		const alleyY = ( P ) => B.y( ( P[ 0 ] - B.from[ 0 ] ) * B.dir[ 0 ] + ( P[ 1 ] - B.from[ 1 ] ) * B.dir[ 1 ] );
		this._oldWall( plaster, B.wall[ 0 ], B.wall[ 1 ], 1, alleyY, 3.4, 2.3, 17 );

		// the same garden's east wall, along the Calçada da Misericórdia up toward Santa Maria (photo
		// references/...-whatsapp-image-2026-10-21-at-10-05-24): as tall, roses and shrubs at its foot
		const M = this.terrain.misericordia;
		if ( M ) {

			const calY = ( P ) => M.y( ( P[ 0 ] - M.from[ 0 ] ) * M.dir[ 0 ] + ( P[ 1 ] - M.from[ 1 ] ) * M.dir[ 1 ] );
			this._oldWall( plaster, M.wall[ 0 ], M.wall[ 1 ], - 1, calY, 3.6, 3.2, 29, true );
			// golden quoins up the corner of the house opposite, its foot charcoal (Town paints it)
			this._quoinCorner( M.corner, M.cornerFaces, calY( M.corner ) - 0.2, calY( M.corner ) + 5.6 );

		}

		const mesh = new Mesh( plaster.build(), materials.plaster );
		mesh.name = 'beneficiado';
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.staticVelocity = true;
		this.group.add( mesh );

	}

	// Praça de Santa Maria's lower square (photo references/...-1113-814e8453-...; TerrainData levels it and the
	// terrace): the old retaining wall round it, whitewashed, its top level; along its foot a seat painted blue
	// under a slab of reddish stone; in the middle of its long west side the Chafariz, a Renaissance fountain of
	// pinkish stone (a trough, a panel with the arms in a round arch between two pilasters and two lion masks, a
	// cornice, a pediment between scrolls), a low blue bed of shrubs either side and a row of stone bollards in
	// front; three steps up from the square's corner by the south arm's end, a pot on the pier there; on the
	// terrace, against the wall behind the fountain, the Pelourinho, yellow benches either side of it.
	_santaMariaSquare( materials ) {

		const Q = this.terrain.santaMariaSquare;
		if ( ! Q ) return;
		const T = this.terrain, kit = this.kit, F = Q.F, U = Q.U, YT = U + 0.75, TH = 0.6;
		const plaster = new MeshKit(), SK = new MeshKit();
		const WHITE = lin( [ 0.92, 0.91, 0.88 ] ), BLUE = lin( [ 0.1, 0.27, 0.78 ] ), SEAT = lin( [ 0.56, 0.28, 0.19 ] );
		// the three sides: start, along, length, n toward the square, yaw
		const sides = [];
		for ( let i = 0; i < 3; i ++ ) {

			const A = Q.wall[ i ], B = Q.wall[ i + 1 ], L = Math.hypot( B[ 0 ] - A[ 0 ], B[ 1 ] - A[ 1 ] );
			const u = [ ( B[ 0 ] - A[ 0 ] ) / L, ( B[ 1 ] - A[ 1 ] ) / L ];
			sides.push( { A, B, L, u, n: [ - u[ 1 ], u[ 0 ] ], yaw: Math.atan2( - u[ 1 ], u[ 0 ] ) } );

		}

		const P = ( S, s, k ) => [ S.A[ 0 ] + S.u[ 0 ] * s + S.n[ 0 ] * k, S.A[ 1 ] + S.u[ 1 ] * s + S.n[ 1 ] * k ];
		const put = ( K, S, s0, s1, y0, y1, k0, k1, skip = '' ) => {

			const C = P( S, ( s0 + s1 ) / 2, ( k0 + k1 ) / 2 );
			K.box( C[ 0 ], ( y0 + y1 ) / 2, C[ 1 ], s1 - s0, y1 - y0, k1 - k0, S.yaw, skip );

		};
		const solid = ( S, s0, s1, y0, y1, k0, k1, walkable, tag ) => {

			const C = P( S, ( s0 + s1 ) / 2, ( k0 + k1 ) / 2 );
			this.colliders.addBox( new Vector3( C[ 0 ], ( y0 + y1 ) / 2, C[ 1 ] ), new Vector3( ( s1 - s0 ) / 2, ( y1 - y0 ) / 2, Math.abs( k1 - k0 ) / 2 ), S.yaw, { walkable, tag } );

		};

		// the wall: its face on the line, TH thick away from the square (mitred at the two corners), level along
		// its top
		const back = Q.wall.map( ( W, i ) => {

			const a = sides[ Math.max( 0, i - 1 ) ].n, b = sides[ Math.min( 2, i ) ].n;
			const m = [ a[ 0 ] + b[ 0 ], a[ 1 ] + b[ 1 ] ], ml = Math.hypot( m[ 0 ], m[ 1 ] ), k = TH / ( ( m[ 0 ] * a[ 0 ] + m[ 1 ] * a[ 1 ] ) / ml );
			return [ W[ 0 ] - m[ 0 ] / ml * k, W[ 1 ] - m[ 1 ] / ml * k ];

		} );
		plaster.vdata = [ 20, 0, 0.31, 0 ];
		plaster.color = WHITE;
		const V = ( p, y ) => [ p[ 0 ], y, p[ 1 ] ], B0 = F - 0.6, H = YT - F;
		let u0 = 0;
		sides.forEach( ( S, i ) => {

			const A = S.A, B = S.B, Ab = back[ i ], Bb = back[ i + 1 ], u1 = u0 + S.L;
			plaster.quadFacing( V( A, B0 ), V( B, B0 ), V( B, YT ), V( A, YT ), [ S.n[ 0 ], 0, S.n[ 1 ] ], [ [ u0, - 0.6 ], [ u1, - 0.6 ], [ u1, H ], [ u0, H ] ] );
			plaster.quadFacing( V( A, YT ), V( B, YT ), V( Bb, YT ), V( Ab, YT ), [ 0, 1, 0 ], [ [ u0, 5 ], [ u1, 5 ], [ u1, 5.6 ], [ u0, 5.6 ] ] );
			plaster.quadFacing( V( Ab, B0 ), V( Bb, B0 ), V( Bb, YT ), V( Ab, YT ), [ - S.n[ 0 ], 0, - S.n[ 1 ] ], [ [ u0, - 0.6 ], [ u1, - 0.6 ], [ u1, H ], [ u0, H ] ] );
			solid( S, 0, S.L, B0, YT, 0, - TH, false, 'wall' );
			u0 = u1;

		} );
		for ( const [ E, Eb, d ] of [ [ Q.wall[ 0 ], back[ 0 ], sides[ 0 ].u.map( ( v ) => - v ) ], [ Q.wall[ 3 ], back[ 3 ], sides[ 2 ].u ] ] ) {

			plaster.quadFacing( V( E, B0 ), V( Eb, B0 ), V( Eb, YT ), V( E, YT ), [ d[ 0 ], 0, d[ 1 ] ], [ [ 0, - 0.6 ], [ TH, - 0.6 ], [ TH, H ], [ 0, H ] ] );

		}

		// behind it a strip of setts level with what lies there (the terrace; the lanes either side, falling
		// east), over the ground's step down to the square's level under the wall: along the terrace level; along
		// the north arm's lane in steps (photo -1151-); along the south arm's a smooth ramp, as the lane runs on
		// down to the Largo (photo -1411-), blue along the wall's foot on that side (a band following the lane)
		kit.vdata = [ 0.29, 0.6, 0, 1 ];
		kit.color = [ 0.8, 0.78, 0.74 ];
		const laneY = ( S, s ) => {

			let y = 0;
			for ( const d of [ - 0.5, 0, 0.5 ] ) {

				// (the ground just past its outer edge, so the two meet flush)
				const O = P( S, Math.min( S.L, Math.max( 0, s + d ) ), - TH - 1.9 );
				y += T.heightAt( O[ 0 ], O[ 1 ] ) / 3;

			}

			// (at the corner it comes to the terrace's level, the two meeting there)
			return lerp( Math.max( F + 0.05, y ), U + 0.02, smoothstep( S.L - 3, S.L, s ) );

		};
		sides.forEach( ( S, i ) => {

			const n = Math.ceil( S.L );
			for ( let p = 0; p < n; p ++ ) {

				const s0 = S.L * p / n, s1 = S.L * ( p + 1 ) / n, O = P( S, ( s0 + s1 ) / 2, - TH - 2.6 );
				// (the terrace at its level there, Rua Direita climbing north; the north lane's steps coming to it at the corner)
				const M = P( S, ( s0 + s1 ) / 2, 0 );
				const top = i === 1 ? Q.Ut( M[ 1 ] ) + 0.02 : i === 0 ? ( laneY( S, s0 ) + laneY( S, s1 ) ) / 2
					: lerp( Math.max( F + 0.05, T.heightAt( O[ 0 ], O[ 1 ] ) + 0.02 ), Q.UN + 0.02, 1 - smoothstep( 0, 3, ( s0 + s1 ) / 2 ) );
				if ( i === 2 ) put( kit, S, s0 - 0.02, s1 + 0.02, F - 0.4, top, - TH - 1.7, - TH + 0.05, 'bottom' );
				solid( S, s0, s1, F - 0.4, top, - TH - 1.7, - TH, true, 'terrace' );

			}

		} );
		// (the smooth ones: the south lane's ramp, and the terrace along Rua Direita's climb)
		for ( const [ S, Y ] of [ [ sides[ 0 ], ( s ) => laneY( sides[ 0 ], s ) ], [ sides[ 1 ], ( s ) => Q.Ut( P( sides[ 1 ], s, 0 )[ 1 ] ) + 0.02 ] ] ) {

			const V = ( s, k, y ) => { const C = P( S, s, k ); return [ C[ 0 ], y, C[ 1 ] ]; }, k0 = - TH + 0.05, k1 = - TH - 1.7, out = [ - S.n[ 0 ], 0, - S.n[ 1 ] ];
			for ( let p = 0, n = Math.ceil( S.L * 2 ); p < n; p ++ ) {

				const sa = S.L * p / n, sb = S.L * ( p + 1 ) / n, ya = Y( sa ), yb = Y( sb );
				kit.quadFacing( V( sa, k0, ya ), V( sb, k0, yb ), V( sb, k1, yb ), V( sa, k1, ya ), [ 0, 1, 0 ], [ [ sa, 0 ], [ sb, 0 ], [ sb, 1.75 ], [ sa, 1.75 ] ] );
				kit.quadFacing( V( sa, k1, F - 0.4 ), V( sb, k1, F - 0.4 ), V( sb, k1, yb ), V( sa, k1, ya ), out, [ [ sa, 0 ], [ sb, 0 ], [ sb, yb - F ], [ sa, ya - F ] ] );

			}

		}

		{

			const S = sides[ 0 ], n = Math.ceil( S.L * 2 ), V = ( s, k, y ) => { const Q = P( S, s, k ); return [ Q[ 0 ], y, Q[ 1 ] ]; };
			const out = [ - S.n[ 0 ], 0, - S.n[ 1 ] ];
			for ( let p = 0; p < n; p ++ ) {

				const sa = S.L * p / n, sb = S.L * ( p + 1 ) / n, ya = laneY( S, sa ), yb = laneY( S, sb );
				SK.vdata = [ 0, 0, 0.53, 4 ];
				SK.color = BLUE;
				// (on round the corner to the mitre, where it meets the terrace's band)
				const sc = p === n - 1 ? sb + TH * Math.tan( Math.acos( S.u[ 0 ] * sides[ 1 ].u[ 0 ] + S.u[ 1 ] * sides[ 1 ].u[ 1 ] ) / 2 ) + 0.02 : sb;
				SK.quadFacing( V( sa, - TH - 0.02, ya - 0.05 ), V( sc, - TH - 0.02, yb - 0.05 ), V( sc, - TH - 0.02, yb + 0.5 ), V( sa, - TH - 0.02, ya + 0.5 ), out );

			}

			// the outside corner, between the lane's ramp and the terrace: paved at the terrace's level over the
			// ground's step (which lies under the wall and just behind it)
			const S1 = sides[ 1 ];
			// (a touch under the terrace's level: where the lane's ground is as high it shows instead)
			// (out to the wall's line: the south arm's back, past where the lane's ramp ends, is behind it)
			put( kit, S1, - TH - 1.75, 0.05, F - 0.4, U - 0.03, - TH - 1.7, 0.05, 'bottom' );
			solid( S1, - TH - 1.75, 0, F - 0.4, U + 0.02, - TH - 1.7, 0, true, 'terrace' );
			// and the north corner likewise, where the north lane comes up to Rua Direita
			put( kit, S1, S1.L - 0.05, S1.L + TH + 1.75, F - 0.4, Q.UN - 0.03, - TH - 1.7, 0.05, 'bottom' );
			solid( S1, S1.L, S1.L + TH + 1.75, F - 0.4, Q.UN + 0.02, - TH - 1.7, 0, true, 'terrace' );

		}

		// the seat along its foot: blue, under a slab of reddish stone; on the west side broken by the fountain and
		// the low beds either side of it
		const SW = sides[ 1 ], sF = ( Q.fountain.z - SW.A[ 1 ] ) / ( SW.B[ 1 ] - SW.A[ 1 ] ) * SW.L, FW = 1.75, BED = 3.9;
		const seat = ( S, s0, s1 ) => {

			SK.vdata = [ 0, 0, 0.53, 4 ];
			SK.color = BLUE;
			put( SK, S, s0, s1, F - 0.1, F + 0.4, 0, 0.48, 'bottom' );
			SK.color = SEAT;
			put( SK, S, s0, s1, F + 0.4, F + 0.47, 0, 0.53, 'bottom' );
			solid( S, s0, s1, F - 0.1, F + 0.47, 0, 0.53, true, 'seat' );

		};
		seat( sides[ 0 ], 0.75, sides[ 0 ].L ); // (from the pier at its end)
		seat( SW, 0.53, sF - BED );
		seat( SW, sF + BED, SW.L );
		seat( sides[ 2 ], 0.53, sides[ 2 ].L - 0.2 );

		// the beds: a low blue kerb, earth, shrubs and a few small trees of orange flowers
		{

			const r = mulberry32( 1113 );
			for ( const [ s0, s1 ] of [ [ sF - BED, sF - FW ], [ sF + FW, sF + BED ] ] ) {

				SK.vdata = [ 0, 0, 0.53, 4 ];
				SK.color = BLUE;
				put( SK, SW, s0, s1, F - 0.1, F + 0.28, 0.44, 0.56, 'bottom' );
				put( SK, SW, s0, s0 + 0.1, F - 0.1, F + 0.28, 0, 0.5, 'bottom' );
				put( SK, SW, s1 - 0.1, s1, F - 0.1, F + 0.28, 0, 0.5, 'bottom' );
				SK.color = lin( [ 0.24, 0.18, 0.13 ] );
				put( SK, SW, s0 + 0.1, s1 - 0.1, F + 0.1, F + 0.24, 0, 0.44, 'bottom' );
				solid( SW, s0, s1, F - 0.1, F + 0.28, 0, 0.56, true, 'bed' );
				for ( let i = 0; i < 70 * ( s1 - s0 ); i ++ ) {

					// (bushier toward the bed's outer end, as in the photo; low by the fountain)
					const t = r(), s = s0 + 0.15 + t * ( s1 - s0 - 0.3 ), out = s0 < sF ? 1 - t : t;
					if ( r() > 0.25 + 0.75 * out ) continue;
					const k = 0.05 + r() * 0.42, y = F + 0.24 + r() * r() * ( 0.3 + 1.0 * out ), sz = 0.08 + r() * 0.14;
					const C = P( SW, s, k ), bloom = r() < 0.08;
					SK.color = lin( bloom ? [ 0.9, 0.45, 0.12 ] : [ 0.13 + r() * 0.1, 0.3 + r() * 0.14, 0.09 ] );
					SK.box( C[ 0 ], y, C[ 1 ], sz, sz * 0.8, sz, r() * 3 );

				}

			}

		}

		// the Chafariz (photo -1113-): in a frame of s along the west side from the fountain's middle, k out
		// from the wall's face; of dressed grey stone with rosy panels, in two stages: below, as wide as it is
		// tall, its blocks with a lion mask spouting at each end and a mask between them, over a long low trough;
		// above, narrower, the arms on a shield in a great round arch, a scroll curling down at either side, a
		// cornice and a low pediment rising over the wall's top
		{

			const STONE = lin( [ 0.68, 0.63, 0.56 ] ), SHADE = lin( [ 0.54, 0.5, 0.45 ] ), ROSE = lin( [ 0.66, 0.55, 0.5 ] ), DARK = lin( [ 0.3, 0.27, 0.24 ] );
			const W3 = ( s, y, k ) => { const C = P( SW, sF + s, k ); return [ C[ 0 ], y, C[ 1 ] ]; };
			const fb = ( K, s, y0, y1, w, k0, k1 ) => put( K, SW, sF + s - w / 2, sF + s + w / 2, F + y0, F + y1, k0, k1 );
			const face = [ SW.n[ 0 ], 0, SW.n[ 1 ] ];
			const ring = ( K, s, y, r0, r1, a0, a1, k, n = 14 ) => {

				for ( let i = 0; i < n; i ++ ) {

					const t0 = a0 + ( a1 - a0 ) * i / n, t1 = a0 + ( a1 - a0 ) * ( i + 1 ) / n;
					const q = ( t, r ) => W3( s + Math.cos( t ) * r, F + y + Math.sin( t ) * r, k );
					K.quadFacing( q( t0, r0 ), q( t1, r0 ), q( t1, r1 ), q( t0, r1 ), face );

				}

			};
			SK.vdata = [ 0, 0, 0.53, 4 ];
			// the trough: a long low block of stone, dark water in it
			SK.color = STONE;
			fb( SK, 0, - 0.1, 0.47, 3.4, 0, 0.8 );
			SK.color = lin( [ 0.1, 0.12, 0.11 ] );
			fb( SK, 0, 0.4, 0.475, 3.1, 0.24, 0.66 );
			solid( SW, sF - 1.7, sF + 1.7, F - 0.1, F + 0.47, 0, 0.8, true, 'fountain' );
			// the lower stage: its blocks, rosy panels in two rows, the masks
			SK.color = STONE;
			fb( SK, 0, 0.47, 1.55, 3.1, 0, 0.24 );
			SK.color = SHADE;
			for ( const y of [ 0.82, 1.1 ] ) fb( SK, 0, y - 0.012, y + 0.012, 3.1, 0, 0.245 ); // (the courses' joints)
			SK.color = ROSE;
			for ( const s of [ - 1.05, 0, 1.05 ] ) {

				fb( SK, s, 1.16, 1.48, 0.82, 0, 0.25 );
				if ( s === 0 ) fb( SK, s, 0.86, 1.06, 0.82, 0, 0.25 );

			}

			for ( const sd of [ - 1, 1 ] ) {

				// a lion mask at each end, low, its spout over the trough
				SK.color = SHADE;
				ring( SK, sd * 1.15, 0.7, 0, 0.17, 0, Math.PI * 2, 0.27 );
				SK.color = STONE;
				ring( SK, sd * 1.15, 0.74, 0, 0.1, 0, Math.PI * 2, 0.3, 10 );
				SK.color = DARK;
				ring( SK, sd * 1.15, 0.62, 0, 0.04, 0, Math.PI * 2, 0.31, 8 );
				SK.color = SHADE;
				fb( SK, sd * 1.15, 0.58, 0.62, 0.05, 0.24, 0.5 );

			}

			// the mask between them, low over the trough, and the bracket over the middle panel
			SK.color = SHADE;
			ring( SK, 0, 0.62, 0, 0.14, 0, Math.PI * 2, 0.27 );
			fb( SK, 0, 1.33, 1.45, 0.5, 0.2, 0.33 );
			// its cornice, the upper stage's base
			SK.color = SHADE;
			fb( SK, 0, 1.55, 1.66, 3.25, 0, 0.32 );
			// the upper stage: the arch round the arms, rosy spandrels, the shield under a crown
			SK.color = STONE;
			fb( SK, 0, 1.66, 2.8, 2.0, 0, 0.18 );
			SK.color = ROSE;
			ring( SK, 0, 1.86, 0, 0.6, 0, Math.PI, 0.185, 16 );
			fb( SK, 0, 1.66, 1.86, 1.2, 0.17, 0.185 );
			for ( const sd of [ - 1, 1 ] ) fb( SK, sd * 0.84, 2.3, 2.72, 0.24, 0.17, 0.185 );
			SK.color = SHADE;
			ring( SK, 0, 1.86, 0.6, 0.72, 0, Math.PI, 0.21, 18 );
			for ( const sd of [ - 1, 1 ] ) fb( SK, sd * 0.66, 1.66, 1.86, 0.12, 0.17, 0.21 );
			SK.color = STONE;
			fb( SK, 0, 1.9, 2.36, 0.36, 0.18, 0.28 );
			ring( SK, 0, 1.9, 0, 0.18, Math.PI, Math.PI * 2, 0.28 );
			SK.color = SHADE;
			fb( SK, 0, 2.38, 2.52, 0.4, 0.18, 0.27 );
			// the scrolls either side of it, curling down onto the cornice
			for ( const sd of [ - 1, 1 ] ) {

				SK.color = STONE;
				ring( SK, sd * 1.0, 1.66, 0.3, 0.44, sd > 0 ? 0 : Math.PI / 2, sd > 0 ? Math.PI / 2 : Math.PI, 0.16, 10 );
				SK.color = SHADE;
				ring( SK, sd * 1.38, 1.84, 0, 0.17, 0, Math.PI * 2, 0.2 );
				SK.color = STONE;
				ring( SK, sd * 1.38, 1.84, 0.06, 0.12, 0, Math.PI * 2, 0.21 );

			}

			// the cornice and the pediment, its apex over the wall's top
			SK.color = SHADE;
			fb( SK, 0, 2.8, 2.88, 2.16, 0, 0.26 );
			SK.color = STONE;
			fb( SK, 0, 2.88, 2.98, 2.24, 0, 0.32 );
			{

				const y0 = F + 2.98, y1 = F + 3.32, hw = 1.08, k = 0.26;
				const tri = ( w, a, b, kk ) => SK.quadFacing( W3( - w, a, kk ), W3( w, a, kk ), W3( 0, b, kk ), W3( 0, b, kk ), face );
				SK.color = STONE;
				tri( hw, y0, y1, k );
				for ( const sd of [ - 1, 1 ] ) SK.quadFacing( W3( sd * hw, y0, k ), W3( 0, y1, k ), W3( 0, y1, 0 ), W3( sd * hw, y0, 0 ), [ 0, 1, 0 ] );
				SK.color = SHADE;
				tri( hw * 0.75, y0 + 0.05, y1 - 0.09, k + 0.01 );

			}

		}
		// the bollards in a row before the fountain and its beds: short square posts of grey limestone
		kit.vdata = [ 0.43, 0.55, 0, 0 ];
		for ( const s of [ - 3.4, - 2.3, - 0.35, 1.35, 2.6, 3.7 ] ) { // (as the photo's, not quite even)

			const C = P( SW, sF + s, 1.15 );
			kit.color = [ 0.78, 0.77, 0.72 ];
			kit.box( C[ 0 ], F + 0.33, C[ 1 ], 0.22, 0.72, 0.22, SW.yaw );
			kit.box( C[ 0 ], F + 0.72, C[ 1 ], 0.16, 0.08, 0.16, SW.yaw );
			this.colliders.addBox( new Vector3( C[ 0 ], F + 0.35, C[ 1 ] ), new Vector3( 0.11, 0.35, 0.11 ), SW.yaw, { walkable: false, tag: 'bollard' } );

		}

		// the steps up from the square's corner past the south arm's end onto its lane (photos -1113-, -2021-): three
		// long stone steps fanning out from the pier, the lowest short, the next longer with a rounded end, the top one
		// a long wedge sinking into the lane's cobbles as the lane falls east; the pier at the arm's end a little
		// higher, a pot of geraniums on it
		{

			const S0 = sides[ 0 ], x0 = S0.A[ 0 ] + 0.15, zW = S0.A[ 1 ];
			// (full height by the pier, sinking toward the wedge's tip, where the lane has fallen to the square's level)
			const taper = ( x ) => F + 0.02 + 0.43 * ( 1 - smoothstep( x0 + 1.8, x0 + 4.9, x ) );
			// each step's outline (x, z) and its top: its rise, but no higher than that
			const arc = ( cx, cz, r, a0, a1, n ) => Array.from( { length: n + 1 }, ( _, i ) => { const a = a0 + ( a1 - a0 ) * i / n; return [ cx + Math.cos( a ) * r, cz + Math.sin( a ) * r ]; } );
			const steps = [
				[ 1, [ [ x0, zW - 1.35 ], [ x0 + 2.3, zW - 1.35 ], [ x0 + 2.3, zW - 0.95 ], [ x0, zW - 0.95 ] ] ],
				[ 2, [ [ x0, zW - 0.95 ], ...arc( x0 + 3.0, zW - 0.55, 0.4, - Math.PI / 2, 0, 5 ), [ x0, zW - 0.55 ] ] ],
				[ 3, [ [ x0, zW - 0.55 ], [ x0 + 4.9, zW + 0.12 ], [ x0, zW + 1.2 ] ] ] ];
			kit.vdata = [ 0.43, 0.5, 0, 0 ];
			kit.color = [ 0.76, 0.75, 0.7 ];
			const V = ( q, y ) => [ q[ 0 ], y, q[ 1 ] ];
			for ( const [ i, poly ] of steps ) {

				const top = ( q ) => Math.min( F + 0.15 * i, taper( q[ 0 ] ) );
				const C = poly.reduce( ( a, q ) => [ a[ 0 ] + q[ 0 ] / poly.length, a[ 1 ] + q[ 1 ] / poly.length ], [ 0, 0 ] );
				for ( let j = 0; j < poly.length; j ++ ) {

					const a = poly[ j ], b = poly[ ( j + 1 ) % poly.length ], L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
					// its top as a fan from the middle, its edges' faces down below the ground
					// (wound to face up whichever way the outline runs)
					const up = ( b[ 1 ] - C[ 1 ] ) * ( a[ 0 ] - C[ 0 ] ) - ( b[ 0 ] - C[ 0 ] ) * ( a[ 1 ] - C[ 1 ] ) > 0;
					const [ p, q ] = up ? [ b, a ] : [ a, b ];
					kit.tri( V( C, top( C ) ), V( p, top( p ) ), V( q, top( q ) ), [ [ C[ 0 ], C[ 1 ] ], [ p[ 0 ], p[ 1 ] ], [ q[ 0 ], q[ 1 ] ] ], [ 0, 1, 0 ] );
					const n = [ ( b[ 1 ] - a[ 1 ] ) / L, 0, - ( b[ 0 ] - a[ 0 ] ) / L ];
					const out = ( ( a[ 0 ] + b[ 0 ] ) / 2 - C[ 0 ] ) * n[ 0 ] + ( ( a[ 1 ] + b[ 1 ] ) / 2 - C[ 1 ] ) * n[ 2 ] > 0 ? n : [ - n[ 0 ], 0, - n[ 2 ] ];
					kit.quadFacing( V( a, F - 0.3 ), V( b, F - 0.3 ), V( b, top( b ) ), V( a, top( a ) ), out, [ [ 0, 0 ], [ L, 0 ], [ L, top( b ) - F + 0.3 ], [ 0, top( a ) - F + 0.3 ] ] );

				}

				// (to walk on: a box for each step's broad end by the pier)
				const xs = poly.map( ( q ) => q[ 0 ] ), zs = poly.map( ( q ) => q[ 1 ] );
				const bx0 = Math.min( ...xs ), bx1 = i === 3 ? x0 + 2.2 : Math.max( ...xs ), bz0 = Math.min( ...zs ), bz1 = i === 3 ? zW + 0.9 : Math.max( ...zs ), h = F + 0.15 * i;
				this.colliders.addBox( new Vector3( ( bx0 + bx1 ) / 2, ( h + F - 0.3 ) / 2, ( bz0 + bz1 ) / 2 ), new Vector3( ( bx1 - bx0 ) / 2, ( h - F + 0.3 ) / 2, ( bz1 - bz0 ) / 2 ), 0, { walkable: true, tag: 'stair' } );

			}

			const E = S0.A, Eb = back[ 0 ], Cp = [ ( E[ 0 ] + Eb[ 0 ] ) / 2 + S0.u[ 0 ] * 0.3, ( E[ 1 ] + Eb[ 1 ] ) / 2 + S0.u[ 1 ] * 0.3 ];
			plaster.vdata = [ 20, 0, 0.31, 0 ];
			plaster.color = WHITE;
			plaster.box( Cp[ 0 ], ( B0 + YT + 0.12 ) / 2, Cp[ 1 ], 0.82, YT + 0.12 - B0, TH + 0.12, S0.yaw );
			// (blue at its foot, round from the seat, the steps' side; a slab of grey stone on top)
			SK.vdata = [ 0, 0, 0.53, 4 ];
			SK.color = BLUE;
			SK.box( Cp[ 0 ], ( B0 + F + 0.75 ) / 2, Cp[ 1 ], 0.84, F + 0.75 - B0, TH + 0.14, S0.yaw, 'top bottom' );
			// (on its end, over the steps, the blue goes higher, photo -2021-)
			SK.box( Cp[ 0 ] - S0.u[ 0 ] * 0.425, F + 1.32, Cp[ 1 ] - S0.u[ 1 ] * 0.425, 0.02, 1.15, TH + 0.14, S0.yaw );
			kit.vdata = [ 0.43, 0.6, 0, 0 ];
			kit.color = [ 0.66, 0.64, 0.6 ];
			kit.box( Cp[ 0 ], YT + 0.17, Cp[ 1 ], 0.94, 0.1, TH + 0.24, S0.yaw );
			SK.color = lin( [ 0.62, 0.32, 0.2 ] );
			SK.box( Cp[ 0 ], YT + 0.38, Cp[ 1 ], 0.36, 0.32, 0.36, S0.yaw + 0.4 );
			SK.box( Cp[ 0 ], YT + 0.56, Cp[ 1 ], 0.44, 0.06, 0.44, S0.yaw + 0.4 );
			// the litter bin of brown slats by the seat's end
			SK.color = lin( [ 0.3, 0.16, 0.1 ] );
			const Cb = P( S0, 1.15, 0.78 );
			SK.box( Cb[ 0 ], F + 0.33, Cb[ 1 ], 0.42, 0.66, 0.42, S0.yaw );
			this.colliders.addBox( new Vector3( Cb[ 0 ], F + 0.33, Cb[ 1 ] ), new Vector3( 0.21, 0.33, 0.21 ), S0.yaw, { walkable: false, tag: 'bin' } );
			const r = mulberry32( 2113 );
			for ( let i = 0; i < 40; i ++ ) {

				const a = r() * 6.28, d = r() * 0.3, sz = 0.06 + r() * 0.08;
				SK.color = lin( r() < 0.2 ? [ 0.8, 0.12, 0.14 ] : [ 0.16 + r() * 0.08, 0.32 + r() * 0.12, 0.1 ] );
				SK.box( Cp[ 0 ] + Math.cos( a ) * d, YT + 0.6 + r() * 0.3, Cp[ 1 ] + Math.sin( a ) * d, sz, sz, sz, r() * 3 );

			}

		}

		// the Pelourinho (photo -1350-): against the terrace's side of the wall right behind the fountain (its
		// pediment shows over the wall behind it), on three round steps of big blocks; a round shaft on a moulded
		// base, a collar of twisted rope two thirds up, and a tall carved finial like a pine cone; some 4.8 m over the
		// terrace in all (photo -1113-: its tip under five metres over the terrace). The column's profile is drawn
		// 6 m tall and scaled by K, its girth by KR.
		{

			const K = 0.64, KR = 0.9;
			const C = P( SW, sF, - TH - 1.0 ), [ x, z ] = C, g = T.heightAt( x - 1.5, z );
			kit.vdata = [ 0.43, 0.65, 0, 0 ];
			// a drum of n blocks round ( x, z ), radius r, from y0 up h; a round body: four squares turned
			const drum = ( y0, h, r, n ) => {

				for ( let i = 0; i < n; i ++ ) {

					const a = ( i + 0.5 ) * 2 * Math.PI / n, c = Math.cos( a ), s = Math.sin( a );
					kit.box( x + c * r / 2, y0 + h / 2, z + s * r / 2, 2 * r * Math.tan( Math.PI / n ) + 0.01, h, r, Math.PI / 2 - a );

				}

			};
			// (the column smooth dressed stone, pale and weathered: flat paint in two tones)
			const PALE = lin( [ 0.78, 0.77, 0.72 ] ), WORN = lin( [ 0.66, 0.65, 0.6 ] );
			const round = ( y0, h, r, c = PALE ) => {

				SK.vdata = [ 0, 0, 0.53, 4 ];
				SK.color = c;
				for ( let i = 0; i < 4; i ++ ) SK.box( x, y0 + h / 2, z, 2 * r, h, 2 * r, i * Math.PI / 8 );

			};
			kit.color = [ 1.0, 0.98, 0.92 ];
			let y = g - 0.3;
			for ( const [ h, r, n ] of [ [ 0.64, 1.1, 14 ], [ 0.34, 0.84, 12 ], [ 0.32, 0.6, 10 ] ] ) {

				drum( y, h, r, n );
				this.colliders.addBox( new Vector3( x, y + h / 2, z ), new Vector3( r * 0.9, h / 2, r * 0.9 ), 0, { walkable: true, tag: 'pillory' } );
				y += h;

			}

			const y0 = y;
			this.colliders.addBox( new Vector3( x, y0 + 6 * K / 2, z ), new Vector3( 0.3, 6 * K / 2, 0.3 ), 0, { walkable: false, tag: 'pillory' } );
			for ( const [ dy, h, r ] of [
				// the base's mouldings, the shaft, the rope collar, the shaft on up
				[ 0, 0.12, 0.36 ], [ 0.12, 0.2, 0.3 ], [ 0.32, 0.18, 0.33 ], [ 0.5, 0.15, 0.27 ], [ 0.65, 0.1, 0.22 ], [ 0.75, 2.2, 0.17 ],
				[ 2.95, 0.22, 0.225 ], [ 3.17, 0.75, 0.17 ],
				// the finial: a moulded drum, the long carved cone swelling and closing, a ring, its point
				[ 3.9, 0.12, 0.24 ], [ 4.02, 0.25, 0.28 ], [ 4.27, 0.4, 0.32 ], [ 4.67, 0.4, 0.34 ], [ 5.07, 0.25, 0.3 ], [ 5.32, 0.1, 0.26 ],
				[ 5.42, 0.18, 0.2 ], [ 5.6, 0.18, 0.14 ], [ 5.78, 0.14, 0.09 ], [ 5.92, 0.1, 0.04 ] ] ) round( y0 + dy * K, h * K, r * KR, h < 0.13 ? WORN : PALE );
			// the rope's twist, and the leaves carved over the cone
			const r = mulberry32( 1350 );
			for ( let i = 0; i < 12; i ++ ) {

				const a = i * Math.PI / 6;
				SK.color = WORN;
				SK.box( x + Math.cos( a ) * 0.225 * KR, y0 + 3.06 * K, z + Math.sin( a ) * 0.225 * KR, 0.11, 0.04, 0.045, - a + 0.6 );

			}

			for ( let i = 0; i < 30; i ++ ) {

				const a = r() * Math.PI * 2, yy = 4.15 + r() * 1.0, rr = 0.3 + 0.05 * Math.sin( ( yy - 4.15 ) * 3 );
				SK.color = r() < 0.5 ? WORN : PALE;
				SK.box( x + Math.cos( a ) * rr * KR, y0 + yy * K, z + Math.sin( a ) * rr * KR, 0.12, 0.09, 0.08, - a );

			}

		}

		// two yellow benches against the wall's terrace side, either side of the Pelourinho: slats on dark iron ends
		{

			const YEL = lin( [ 0.95, 0.74, 0.08 ] );
			for ( const sd of [ - 1, 1 ] ) {

				const s = sF + sd * 3.5, g = T.heightAt( ...P( SW, s, - TH - 2.5 ) );
				SK.vdata = [ 0, 0, 0.53, 4 ];
				SK.color = YEL;
				for ( let i = 0; i < 4; i ++ ) put( SK, SW, s - 0.9, s + 0.9, g + 0.42, g + 0.45, - TH - 0.18 - i * 0.11, - TH - 0.27 - i * 0.11 );
				for ( let i = 0; i < 3; i ++ ) put( SK, SW, s - 0.9, s + 0.9, g + 0.58 + i * 0.13, g + 0.67 + i * 0.13, - TH - 0.1, - TH - 0.13 );
				SK.color = lin( [ 0.05, 0.05, 0.05 ] );
				for ( const e of [ - 0.75, 0.75 ] ) {

					put( SK, SW, s + e - 0.03, s + e + 0.03, g - 0.05, g + 0.42, - TH - 0.55, - TH - 0.49 );
					put( SK, SW, s + e - 0.03, s + e + 0.03, g - 0.05, g + 0.95, - TH - 0.14, - TH - 0.08 );
					put( SK, SW, s + e - 0.03, s + e + 0.03, g + 0.36, g + 0.42, - TH - 0.55, - TH - 0.1 );

				}

				solid( SW, s - 0.9, s + 0.9, g, g + 0.45, - TH - 0.1, - TH - 0.55, true, 'bench' );

			}

		}

		// the terrace's side of the west wall: blue along its foot, as on the square's side
		SK.vdata = [ 0, 0, 0.53, 4 ];
		SK.color = BLUE;
		{

			// (following the terrace's climb north, round both corners to the mitres)
			const n = Math.ceil( SW.L ), V = ( s, y ) => { const C = P( SW, s, - TH - 0.025 ); return [ C[ 0 ], y, C[ 1 ] ]; };
			for ( let p = 0; p < n; p ++ ) {

				const sa = p === 0 ? - TH * 0.95 : SW.L * p / n, sb = p === n - 1 ? SW.L + TH * 0.95 : SW.L * ( p + 1 ) / n;
				const ya = Q.Ut( P( SW, Math.max( 0, sa ), 0 )[ 1 ] ), yb = Q.Ut( P( SW, Math.min( SW.L, sb ), 0 )[ 1 ] );
				SK.quadFacing( V( sa, ya - 0.1 ), V( sb, yb - 0.1 ), V( sb, Math.min( yb + 0.52, YT - 0.12 ) ), V( sa, Math.min( ya + 0.52, YT - 0.12 ) ), [ - SW.n[ 0 ], 0, - SW.n[ 1 ] ] ); // (under the coping where the street has climbed)

			}

		}

		// the plane trees before the church's south side, over the café's tables (photo -1350-)
		this.extraTrees = this.extraTrees || [];
		this.extraTrees.push( { kind: 'plane', x: 15.5, z: - 34.5, scale: 1.05 }, { kind: 'plane', x: 11.0, z: - 28.0, scale: 0.95 } );
		for ( const [ K, name ] of [ [ plaster, 'santa-maria-wall' ], [ SK, 'santa-maria-chafariz' ] ] ) {

			const mesh = new Mesh( K.build(), materials.plaster );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// The Igreja de Santa Maria's front to the square (photo references/...-1350-4c6b5633-...; Town builds the
	// nave gabled toward the square, BLANK_FRONTS): white between corner pilasters of golden stone, a cornice
	// and the pediment's mouldings, urns on its corners and a cross on its apex, an oval window high up; the
	// Renaissance portal of two storeys, a round-arched door between pairs of columns under an entablature, over
	// it the Virgin in a niche between two inscribed panels and scrolls, a small pediment on top. The north aisle's
	// lower front set back beside it, a pilaster and an urn at its corner, a small window. South of the front the
	// bell tower: white, quoins of golden stone, a dark belfry opening on each side, a cornice, a pinnacle on each
	// corner, a stone spire.
	_santaMariaChurch( materials ) {

		const T = this.terrain, kit = this.kit, SK = new MeshKit(), paint = new MeshKit(), plaster = new MeshKit();
		const P0 = [ 19.2, - 47.2 ], P1 = [ 19.2, - 40.1 ], FL = Math.hypot( P1[ 0 ] - P0[ 0 ], P1[ 1 ] - P0[ 1 ] );
		const U = [ ( P1[ 0 ] - P0[ 0 ] ) / FL, ( P1[ 1 ] - P0[ 1 ] ) / FL ], N = [ - U[ 1 ], U[ 0 ] ]; // (N: out, to the square)
		const yaw = Math.atan2( - U[ 1 ], U[ 0 ] ), uC = FL / 2, face = [ N[ 0 ], 0, N[ 1 ] ];
		const G = T.heightAt( P0[ 0 ] + N[ 0 ] + U[ 0 ] * uC, P0[ 1 ] + N[ 1 ] + U[ 1 ] * uC ), EAVE = 65.5, RISE = 3.55 * 0.45;
		// s along the front from its middle (toward the tower), y over the square, k out from the front
		const W = ( s, y, k, x0 = P0 ) => [ x0[ 0 ] + U[ 0 ] * ( uC + s ) + N[ 0 ] * k, G + y, x0[ 1 ] + U[ 1 ] * ( uC + s ) + N[ 1 ] * k ];
		const box = ( K, s, y0, y1, w, k0, k1, x0 = P0 ) => {

			const Q = W( s, 0, ( k0 + k1 ) / 2, x0 );
			K.box( Q[ 0 ], G + ( y0 + y1 ) / 2, Q[ 2 ], w, y1 - y0, k1 - k0, yaw );

		};
		const ring = ( K, s, y, r0, r1, a0, a1, k, n = 14, sx = 1, sy = 1 ) => {

			for ( let i = 0; i < n; i ++ ) {

				const t0 = a0 + ( a1 - a0 ) * i / n, t1 = a0 + ( a1 - a0 ) * ( i + 1 ) / n;
				const q = ( t, r ) => W( s + Math.cos( t ) * r * sx, y + Math.sin( t ) * r * sy, k );
				K.quadFacing( q( t0, r0 ), q( t1, r0 ), q( t1, r1 ), q( t0, r1 ), face );

			}

		};
		const STONE = lin( [ 0.82, 0.73, 0.57 ] ), SHADE = lin( [ 0.66, 0.58, 0.45 ] ), DARK = lin( [ 0.08, 0.08, 0.09 ] );
		// (photo -2003-, the front close: its pilasters and cornice of grey weathered stone; the portal pale, near white)
		const GREY = lin( [ 0.6, 0.58, 0.53 ] ), GREY2 = lin( [ 0.47, 0.46, 0.42 ] ), PALE = lin( [ 0.86, 0.83, 0.76 ] ), PALE2 = lin( [ 0.72, 0.69, 0.62 ] );
		SK.vdata = [ 0, 0, 0.53, 4 ];
		paint.vdata = [ 0, 0, 0.53, 4 ];
		const e = EAVE - G, hw = uC + 0.2;
		// the corner pilasters: broad, plain, a moulded base and a capital under the cornice, dark weathering down them
		for ( const sd of [ - 1, 1 ] ) {

			const s = sd * ( uC - 0.55 );
			SK.color = GREY;
			box( SK, s, - 0.3, e, 1.1, 0, 0.22 );
			SK.color = GREY2;
			box( SK, s + sd * 0.18, 1.2, e - 0.6, 0.32, 0.22, 0.23 );
			box( SK, s - sd * 0.3, 2.5, e - 2.5, 0.16, 0.22, 0.23 );
			box( SK, s, - 0.3, 1.05, 1.24, 0, 0.32 );
			SK.color = GREY;
			box( SK, s, 1.05, 1.2, 1.18, 0, 0.27 );
			box( SK, s, e - 0.4, e - 0.15, 1.2, 0, 0.3 );

		}

		// the cornice, and the mouldings up the pediment's rakes
		SK.color = GREY2;
		box( SK, 0, e - 0.15, e, FL + 0.2, 0, 0.26 );
		SK.color = GREY;
		box( SK, 0, e, e + 0.28, FL + 0.5, 0, 0.38 );
		{

			const y0 = e + 0.28, y1 = e + 0.28 + RISE, H = 0.2, kk = 0.28;
			SK.color = GREY;
			for ( const sd of [ - 1, 1 ] ) {

				SK.quadFacing( W( sd * hw, y0, kk ), W( 0, y1, kk ), W( 0, y1 + H, kk ), W( sd * hw, y0 + H, kk ), face );
				SK.quadFacing( W( sd * hw, y0 + H, kk ), W( 0, y1 + H, kk ), W( 0, y1 + H, 0 ), W( sd * hw, y0 + H, 0 ), [ 0, 1, 0 ] );

			}

			// the tympanum's white carried out to the mouldings (the nave's gable is the front's plane)
			plaster.vdata = [ 20, 0, 0.31, 0 ];
			plaster.color = lin( [ 0.92, 0.91, 0.88 ] );
			plaster.quadFacing( W( - hw, y0, 0.12 ), W( hw, y0, 0.12 ), W( 0, y1, 0.12 ), W( 0, y1, 0.12 ), face, [ [ 0, e ], [ FL, e ], [ FL / 2, e + RISE ], [ FL / 2, e + RISE ] ] );
			// urns like pine cones on the corners, over the pilasters; the cross on the apex
			for ( const sd of [ - 1, 1 ] ) {

				SK.color = GREY;
				box( SK, sd * ( uC - 0.4 ), y0, y0 + 0.4, 0.46, 0.05, 0.5 );
				const Q = W( sd * ( uC - 0.4 ), 0, 0.27 );
				for ( const [ dy, h, w ] of [ [ 0.4, 0.1, 0.36 ], [ 0.5, 0.22, 0.2 ], [ 0.72, 0.3, 0.36 ], [ 1.02, 0.22, 0.26 ], [ 1.24, 0.14, 0.14 ] ] ) for ( const a of [ 0, Math.PI / 4 ] ) SK.box( Q[ 0 ], G + y0 + dy + h / 2, Q[ 2 ], w, h, w, yaw + a );

			}

			box( SK, 0, y1, y1 + 0.42, 0.5, 0.05, 0.45 );
			box( SK, 0, y1 + 0.42, y1 + 1.75, 0.13, 0.19, 0.31 );
			box( SK, 0, y1 + 1.2, y1 + 1.33, 0.72, 0.19, 0.31 );

		}

		// the oval window, high under the cornice: a frame of grey stone, leaded panes in a lattice
		SK.color = GREY;
		const yo = e - 1.05;
		ring( SK, 0, yo, 0.45, 0.6, 0, Math.PI * 2, 0.08, 24, 1.62, 1 );
		paint.color = lin( [ 0.16, 0.18, 0.2 ] );
		ring( paint, 0, yo, 0, 0.45, 0, Math.PI * 2, 0.05, 24, 1.62, 1 );
		kit.vdata = [ 0.29, 0.2, 0, 0 ];
		kit.color = [ 0.3, 0.3, 0.3 ];
		for ( let s = - 0.6; s <= 0.61; s += 0.2 ) {

			const h = 0.45 * Math.sqrt( Math.max( 0, 1 - ( s / 0.73 ) ** 2 ) );
			box( kit, s, yo - h, yo + h, 0.02, 0.06, 0.07 );

		}

		for ( let y = - 0.36; y <= 0.37; y += 0.18 ) {

			const w = 0.73 * Math.sqrt( Math.max( 0, 1 - ( y / 0.45 ) ** 2 ) );
			box( kit, 0, yo + y - 0.01, yo + y + 0.01, 2 * w, 0.06, 0.07 );

		}

		// before the portal, a step of big stone slabs; two stone bollards on the square
		kit.vdata = [ 0.43, 0.4, 0, 0 ];
		kit.color = [ 0.86, 0.85, 0.8 ];
		box( kit, 0, - 0.3, 0.1, FL - 0.4, 0, 1.4 );
		this.colliders.addBox( new Vector3( ...W( 0, - 0.1, 0.7 ) ), new Vector3( ( FL - 0.4 ) / 2, 0.2, 0.7 ), yaw, { walkable: true, tag: 'step' } );
		kit.color = [ 0.8, 0.78, 0.72 ];
		for ( const s of [ - 5.0, 4.9 ] ) {

			const Q = W( s, 0, 2.6 );
			for ( const a of [ 0, Math.PI / 4 ] ) kit.box( Q[ 0 ], T.heightAt( Q[ 0 ], Q[ 2 ] ) + 0.3, Q[ 2 ], 0.3, 0.7, 0.3, a );
			kit.box( Q[ 0 ], T.heightAt( Q[ 0 ], Q[ 2 ] ) + 0.7, Q[ 2 ], 0.2, 0.12, 0.2, 0.4 );
			this.colliders.addBox( new Vector3( Q[ 0 ], T.heightAt( Q[ 0 ], Q[ 2 ] ) + 0.35, Q[ 2 ] ), new Vector3( 0.17, 0.35, 0.17 ), 0, { walkable: false, tag: 'bollard' } );

		}

		// the portal, pale stone: its lower storey, the round-arched door in pairs of fluted columns on pedestals,
		// a carved frieze over them
		SK.color = PALE;
		box( SK, 0, 0.05, 3.9, 5.7, 0, 0.14 );
		const wood = new MeshKit();
		wood.vdata = [ 0, 0, 0.53, 5 ];
		wood.color = lin( [ 0.3, 0.16, 0.1 ] );
		box( wood, 0, 0.05, 2.95, 1.95, 0.14, 0.18 );
		ring( wood, 0, 2.95, 0, 0.975, 0, Math.PI, 0.18, 16 );
		wood.color = lin( [ 0.24, 0.12, 0.08 ] );
		box( wood, 0, 0.05, 2.95, 0.04, 0.18, 0.2 );
		for ( const sd of [ - 1, 1 ] ) for ( let r = 0; r < 3; r ++ ) {

			// (its leaves' panels with diamond points)
			const yc = 0.6 + r * 0.85, sc = sd * 0.47;
			wood.color = lin( [ 0.17, 0.09, 0.06 ] );
			box( wood, sc, yc - 0.34, yc + 0.34, 0.76, 0.18, 0.2 );
			wood.color = lin( [ 0.36, 0.2, 0.12 ] );
			box( wood, sc, yc - 0.29, yc + 0.29, 0.66, 0.2, 0.22 );
			wood.color = lin( [ 0.27, 0.15, 0.09 ] );
			box( wood, sc, yc - 0.19, yc + 0.19, 0.44, 0.22, 0.26 );
			wood.color = lin( [ 0.42, 0.25, 0.15 ] );
			box( wood, sc, yc - 0.08, yc + 0.08, 0.18, 0.26, 0.3 );

		}

		SK.color = PALE2;
		ring( SK, 0, 2.95, 0.975, 1.28, 0, Math.PI, 0.22, 18 );
		ring( SK, 0, 2.95, 1.28, 1.36, 0, Math.PI, 0.25, 18 );
		for ( const sd of [ - 1, 1 ] ) box( SK, sd * 1.13, 0.05, 2.95, 0.3, 0.14, 0.22 );
		for ( const sd of [ - 1, 1 ] ) {

			// (a tall blank panel between each pair, round-headed like a niche)
			SK.color = PALE2;
			box( SK, sd * 1.92, 1.25, 3.2, 0.5, 0.14, 0.16 );
			ring( SK, sd * 1.92, 3.2, 0, 0.25, 0, Math.PI, 0.16 );

		}

		for ( const s of [ - 2.35, - 1.5, 1.5, 2.35 ] ) {

			SK.color = PALE2;
			box( SK, s, 0.05, 1.0, 0.56, 0.14, 0.66 );
			SK.color = PALE;
			box( SK, s, 1.0, 1.12, 0.5, 0.14, 0.62 );
			const Q = W( s, 0, 0.4 );
			for ( let a = 0; a < 4; a ++ ) SK.box( Q[ 0 ], G + 2.35, Q[ 2 ], 0.28, 2.46, 0.28, yaw + a * Math.PI / 8 );
			SK.color = PALE2;
			for ( let a = 0; a < 8; a ++ ) {

				// (its flutes)
				const t = a * Math.PI / 4, c = W( s + Math.cos( t ) * 0.145, 0, 0.4 + Math.sin( t ) * 0.145 );
				SK.box( c[ 0 ], G + 2.35, c[ 2 ], 0.03, 2.3, 0.03, yaw );

			}

			SK.color = PALE;
			box( SK, s, 3.58, 3.72, 0.38, 0.18, 0.6 );
			box( SK, s, 3.72, 3.9, 0.5, 0.14, 0.66 );

		}

		this.colliders.addBox( new Vector3( ...W( 0, 0.5, 0.4 ) ), new Vector3( 2.85, 0.5, 0.26 ), yaw, { walkable: true, tag: 'portal' } );
		SK.color = PALE2;
		box( SK, 0, 3.9, 4.12, 5.95, 0, 0.68 );
		SK.color = PALE;
		box( SK, 0, 4.12, 4.6, 5.8, 0, 0.62 );
		SK.color = PALE2;
		for ( let s = - 2.6; s <= 2.61; s += 0.65 ) box( SK, s, 4.22, 4.5, 0.36, 0.62, 0.65 ); // (the frieze's carving)
		box( SK, 0, 4.6, 4.8, 6.15, 0, 0.74 );
		// its upper storey: the Virgin of the Assumption with two angels on clouds in a round-headed niche, rosy
		// round her; the two inscribed tablets in carved frames; a crest of scrolls and medallions with little ball
		// finials; the small pediment over the niche, its date plaque under it
		SK.color = PALE;
		box( SK, 0, 4.8, 6.75, 4.9, 0, 0.18 );
		paint.color = lin( [ 0.74, 0.5, 0.45 ] );
		box( paint, 0, 4.95, 6.2, 0.98, 0.18, 0.19 );
		ring( paint, 0, 6.2, 0, 0.49, 0, Math.PI, 0.19 );
		paint.color = lin( [ 0.56, 0.5, 0.47 ] );
		box( paint, 0, 5.0, 6.2, 0.72, 0.19, 0.2 );
		ring( paint, 0, 6.2, 0, 0.36, 0, Math.PI, 0.2 );
		paint.color = lin( [ 0.88, 0.87, 0.84 ] );
		const fig = ( s, y0, y1, w, k0, k1 ) => box( paint, s, y0, y1, w, k0, k1 );
		fig( 0, 4.95, 5.12, 0.8, 0.2, 0.42 ); // the clouds
		fig( - 0.2, 5.05, 5.22, 0.36, 0.22, 0.44 );
		fig( 0.22, 5.08, 5.24, 0.34, 0.22, 0.44 );
		for ( const sd of [ - 1, 1 ] ) {

			fig( sd * 0.24, 5.15, 5.5, 0.15, 0.24, 0.4 ); // the angels
			fig( sd * 0.24, 5.5, 5.6, 0.09, 0.26, 0.38 );

		}

		fig( 0, 5.2, 6.05, 0.32, 0.22, 0.38 ); // her robe
		fig( 0, 5.85, 5.95, 0.62, 0.24, 0.34 ); // her arms raised
		fig( 0, 6.06, 6.2, 0.13, 0.25, 0.35 ); // her head
		for ( const sd of [ - 1, 1 ] ) {

			SK.color = PALE2;
			box( SK, sd * 1.45, 5.2, 6.0, 1.3, 0.18, 0.22 );
			SK.color = PALE;
			box( SK, sd * 1.45, 5.28, 5.92, 1.15, 0.22, 0.24 );
			paint.color = lin( [ 0.36, 0.35, 0.33 ] );
			box( paint, sd * 1.45, 5.38, 5.82, 0.95, 0.24, 0.25 );
			SK.color = PALE2;
			for ( const dx of [ - 0.5, 0.5 ] ) box( SK, sd * 1.45 + dx, 5.05, 5.18, 0.25, 0.18, 0.26 ); // (strapwork under them)
			ring( SK, sd * 2.25, 5.6, 0, 0.16, 0, Math.PI * 2, 0.22 );
			// the crest: a medallion in scrolls over each tablet, ball finials at its ends and by the niche
			SK.color = PALE2;
			box( SK, sd * 1.45, 6.75, 6.85, 2.1, 0, 0.26 );
			ring( SK, sd * 1.45, 7.03, 0.11, 0.2, 0, Math.PI * 2, 0.22, 14, 1.25, 1 );
			for ( const dx of [ - 0.45, 0.45 ] ) ring( SK, sd * 1.45 + dx, 6.97, 0.05, 0.12, 0, Math.PI * 2, 0.22 );
			for ( const s of [ sd * 2.3, sd * 0.62 ] ) {

				SK.color = PALE;
				box( SK, s, 6.85, 7.0, 0.16, 0.05, 0.25 );
				const Q = W( s, 0, 0.15 );
				for ( const a of [ 0, Math.PI / 4 ] ) SK.box( Q[ 0 ], G + 7.1, Q[ 2 ], 0.17, 0.2, 0.17, yaw + a );

			}

		}

		SK.color = PALE2;
		box( SK, 0, 6.75, 6.9, 1.55, 0, 0.32 );
		paint.color = lin( [ 0.93, 0.92, 0.88 ] );
		box( paint, 0, 6.98, 7.16, 1.05, 0.12, 0.2 ); // the date plaque
		SK.color = PALE;
		box( SK, 0, 6.9, 7.25, 1.3, 0, 0.16 );
		box( SK, 0, 7.25, 7.33, 1.75, 0, 0.3 );
		{

			const y0 = 7.33, y1 = 7.8, k = 0.25;
			SK.quadFacing( W( - 0.86, y0, k ), W( 0.86, y0, k ), W( 0, y1, k ), W( 0, y1, k ), face );
			for ( const sd of [ - 1, 1 ] ) SK.quadFacing( W( sd * 0.86, y0, k ), W( 0, y1, k ), W( 0, y1, 0 ), W( sd * 0.86, y0, 0 ), [ 0, 1, 0 ] );
			SK.color = PALE2;
			SK.quadFacing( W( - 0.62, y0 + 0.05, k + 0.01 ), W( 0.62, y0 + 0.05, k + 0.01 ), W( 0, y1 - 0.1, k + 0.01 ), W( 0, y1 - 0.1, k + 0.01 ), face );

		}

		// the north aisle's front, set back: a grey pilaster at its corner with a finial like a flame, a small
		// window with red shutters up under its roof, a little barred one low down
		{

			const A0 = [ 22.9, - 51.8 ];
			const ea = 63.1 - G;
			const Wa = ( s, k ) => [ A0[ 0 ] + U[ 0 ] * s + N[ 0 ] * k, A0[ 1 ] + U[ 1 ] * s + N[ 1 ] * k ];
			const ab = ( K, s0, s1, y0, y1, k0, k1 ) => {

				const Q = Wa( ( s0 + s1 ) / 2, ( k0 + k1 ) / 2 );
				K.box( Q[ 0 ], G + ( y0 + y1 ) / 2, Q[ 1 ], s1 - s0, y1 - y0, k1 - k0, yaw );

			};
			SK.color = GREY;
			ab( SK, 0, 0.8, - 0.3, ea + 0.2, 0, 0.18 );
			ab( SK, - 0.05, 0.85, - 0.3, 0.9, 0, 0.26 );
			ab( SK, - 0.05, 0.85, ea + 0.2, ea + 0.45, 0, 0.3 );
			for ( const [ dy, h, w ] of [ [ 0.45, 0.2, 0.3 ], [ 0.65, 0.3, 0.38 ], [ 0.95, 0.2, 0.26 ], [ 1.15, 0.2, 0.14 ] ] ) for ( const a of [ 0, Math.PI / 4 ] ) {

				const Q = Wa( 0.4, 0.15 );
				SK.box( Q[ 0 ], G + ea + 0.2 + dy + h / 2, Q[ 1 ], w, h, w, yaw + a );

			}

			ab( SK, 1.9, 2.95, ea - 2.0, ea - 0.75, 0, 0.1 );
			paint.color = lin( [ 0.5, 0.13, 0.1 ] );
			ab( paint, 2.02, 2.83, ea - 1.88, ea - 0.87, 0.1, 0.12 );
			paint.color = lin( [ 0.3, 0.07, 0.06 ] );
			ab( paint, 2.41, 2.44, ea - 1.88, ea - 0.87, 0.12, 0.13 );
			ab( SK, 2.15, 2.75, 1.6, 2.5, 0, 0.1 );
			paint.color = DARK;
			ab( paint, 2.25, 2.65, 1.7, 2.4, 0.1, 0.11 );
			kit.vdata = [ 0.29, 0.2, 0, 0 ];
			kit.color = [ 0.08, 0.08, 0.08 ];
			for ( const s of [ 2.35, 2.45, 2.55 ] ) ab( kit, s - 0.012, s + 0.012, 1.7, 2.4, 0.11, 0.13 );
			ab( kit, 2.25, 2.65, 2.04, 2.07, 0.11, 0.13 );

		}

		// the chapel before the bell tower, beside the front to the south (photo -2003-; Town builds it, its gable to
		// the square, CHAPEL): in its front a big round-arched doorway in a frame of grey stone, up three stone
		// steps; a moulding across its front at the eave and up its gable
		{

			const C = SANTA_MARIA_CHAPEL, zc = ( C.z0 + C.z1 ) / 2, hwC = ( C.z1 - C.z0 ) / 2, Xt = [ C.x, zc - uC ];
			const gt = T.heightAt( C.x - 1.5, zc ) - G, sill = gt + 0.45, ec = C.eave - G, rc = hwC * 0.45;
			const Wt = ( s, y, k ) => W( s, y, k, Xt );
			// the steps
			kit.vdata = [ 0.43, 0.45, 0, 0 ];
			kit.color = [ 0.78, 0.77, 0.72 ];
			for ( let i = 1; i <= 3; i ++ ) {

				const top = gt + 0.15 * i, d = 0.36 * ( 4 - i ), Q = Wt( 0, 0, d / 2 );
				box( kit, 0, gt - 0.3, top, 3.1 - ( i - 1 ) * 0.1, 0, d, Xt );
				this.colliders.addBox( new Vector3( Q[ 0 ], G + ( gt - 0.3 + top ) / 2, Q[ 2 ] ), new Vector3( 1.55, ( top - gt + 0.3 ) / 2, d / 2 ), yaw, { walkable: true, tag: 'stair' } );

			}

			// the doorway
			const R0 = 0.95, R1 = 1.25, spring = sill + 2.45;
			SK.color = GREY;
			box( SK, 0, sill - 0.05, spring, 2 * R1, 0, 0.12, Xt );
			paint.color = lin( [ 0.07, 0.07, 0.08 ] );
			box( paint, 0, sill, spring, 2 * R0, 0.12, 0.14, Xt );
			for ( let i = 0; i < 12; i ++ ) {

				const t0 = Math.PI * i / 12, t1 = Math.PI * ( i + 1 ) / 12;
				const q = ( t, r, k ) => Wt( Math.cos( t ) * r, spring + Math.sin( t ) * r, k );
				paint.quadFacing( Wt( 0, spring, 0.14 ), q( t0, R0, 0.14 ), q( t1, R0, 0.14 ), Wt( 0, spring, 0.14 ), face );
				SK.quadFacing( q( t0, R0, 0.12 ), q( t1, R0, 0.12 ), q( t1, R1, 0.12 ), q( t0, R1, 0.12 ), face );

			}

			// the moulding along the eave and up the gable
			SK.color = GREY;
			box( SK, 0, ec - 0.14, ec + 0.04, 2 * hwC + 0.3, 0, 0.22, Xt );
			for ( const sd of [ - 1, 1 ] ) {

				SK.quadFacing( Wt( sd * ( hwC + 0.15 ), ec + 0.04, 0.2 ), Wt( 0, ec + 0.04 + rc + 0.07, 0.2 ), Wt( 0, ec + 0.2 + rc + 0.07, 0.2 ), Wt( sd * ( hwC + 0.15 ), ec + 0.2, 0.2 ), face );
				SK.quadFacing( Wt( sd * ( hwC + 0.15 ), ec + 0.2, 0.2 ), Wt( 0, ec + 0.2 + rc + 0.07, 0.2 ), Wt( 0, ec + 0.2 + rc + 0.07, 0 ), Wt( sd * ( hwC + 0.15 ), ec + 0.2, 0 ), [ 0, 1, 0 ] );

			}

		}

		// the bell tower
		{

			const X0 = 23.2, X1 = 28.4, Z0 = - 40.1, Z1 = - 34.6, top = G + 14.9, base = G - 1;
			const C = [ ( X0 + X1 ) / 2, ( Z0 + Z1 ) / 2 ];
			plaster.vdata = [ 20, 0, 0.47, 0 ];
			plaster.color = lin( [ 0.92, 0.91, 0.88 ] );
			const corners = [ [ X0, Z0 ], [ X1, Z0 ], [ X1, Z1 ], [ X0, Z1 ] ];
			for ( let i = 0; i < 4; i ++ ) {

				const a = corners[ i ], b = corners[ ( i + 1 ) % 4 ], L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
				const u = [ ( b[ 0 ] - a[ 0 ] ) / L, ( b[ 1 ] - a[ 1 ] ) / L ], n = [ u[ 1 ], - u[ 0 ] ]; // (out: the corners run counter-clockwise on the map)
				const m = [ ( a[ 0 ] + b[ 0 ] ) / 2, ( a[ 1 ] + b[ 1 ] ) / 2 ];
				const out = ( m[ 0 ] - C[ 0 ] ) * n[ 0 ] + ( m[ 1 ] - C[ 1 ] ) * n[ 1 ] > 0 ? n : [ - n[ 0 ], - n[ 1 ] ];
				plaster.quadFacing( [ a[ 0 ], base, a[ 1 ] ], [ b[ 0 ], base, b[ 1 ] ], [ b[ 0 ], top, b[ 1 ] ], [ a[ 0 ], top, a[ 1 ] ], [ out[ 0 ], 0, out[ 1 ] ], [ [ 0, - 1 ], [ L, - 1 ], [ L, top - G ], [ 0, top - G ] ] );
				// its belfry opening, round-headed, dark
				paint.color = DARK;
				const yaw2 = Math.atan2( - u[ 1 ], u[ 0 ] ), o = [ m[ 0 ] + out[ 0 ] * 0.04, m[ 1 ] + out[ 1 ] * 0.04 ];
				paint.box( o[ 0 ], top - 2.55, o[ 1 ], 1.3, 2.3, 0.04, yaw2 );
				for ( let k = 0; k < 8; k ++ ) {

					const t0 = Math.PI * k / 8, t1 = Math.PI * ( k + 1 ) / 8, cx = ( Math.cos( t0 ) + Math.cos( t1 ) ) / 2 * 0.65, h = ( Math.sin( t0 ) + Math.sin( t1 ) ) / 2 * 0.65;
					paint.box( o[ 0 ] + u[ 0 ] * cx, top - 1.4 + h / 2, o[ 1 ] + u[ 1 ] * cx, 1.3 / 8 + 0.01, h, 0.04, yaw2 );

				}

				SK.color = STONE;
				SK.box( o[ 0 ], top - 3.75, o[ 1 ], 1.7, 0.12, 0.2, yaw2 ); // its sill
				this._quoinCorner( a, [ u, [ ( corners[ ( i + 3 ) % 4 ][ 0 ] - a[ 0 ] ) / ( i % 2 ? 5.2 : 5.5 ), ( corners[ ( i + 3 ) % 4 ][ 1 ] - a[ 1 ] ) / ( i % 2 ? 5.2 : 5.5 ) ] ], G, top );

			}

			// the cornice, the pinnacles, the spire
			SK.color = STONE;
			SK.box( C[ 0 ], top + 0.15, C[ 1 ], X1 - X0 + 0.5, 0.3, Z1 - Z0 + 0.5, 0 );
			SK.box( C[ 0 ], top + 0.4, C[ 1 ], X1 - X0 + 0.2, 0.2, Z1 - Z0 + 0.2, 0 );
			for ( const [ x, z ] of corners ) {

				const px = x + Math.sign( C[ 0 ] - x ) * 0.3, pz = z + Math.sign( C[ 1 ] - z ) * 0.3;
				SK.box( px, top + 0.8, pz, 0.42, 0.6, 0.42, 0 );
				for ( const a of [ 0, Math.PI / 4 ] ) {

					SK.box( px, top + 1.3, pz, 0.36, 0.4, 0.36, a );
					SK.box( px, top + 1.75, pz, 0.12, 0.5, 0.12, a );

				}

			}

			const yb = top + 0.5, yA = yb + 4.2, A = [ C[ 0 ], yA, C[ 1 ] ], inset = 0.7;
			const B = [ [ X0 + inset, Z0 + inset ], [ X1 - inset, Z0 + inset ], [ X1 - inset, Z1 - inset ], [ X0 + inset, Z1 - inset ] ];
			kit.vdata = [ 0.43, 0.7, 0, 0 ];
			kit.color = [ 0.6, 0.6, 0.58 ];
			for ( let i = 0; i < 4; i ++ ) {

				const a = B[ i ], b = B[ ( i + 1 ) % 4 ], m = [ ( a[ 0 ] + b[ 0 ] ) / 2 - C[ 0 ], 0.5, ( a[ 1 ] + b[ 1 ] ) / 2 - C[ 1 ] ];
				kit.quadFacing( [ a[ 0 ], yb, a[ 1 ] ], [ b[ 0 ], yb, b[ 1 ] ], A, A, m );

			}

			this.colliders.addBox( new Vector3( C[ 0 ], ( base + top ) / 2, C[ 1 ] ), new Vector3( ( X1 - X0 ) / 2, ( top - base ) / 2, ( Z1 - Z0 ) / 2 ), 0, { walkable: false, tag: 'tower' } );

		}

		for ( const [ K, name ] of [ [ SK, 'santa-maria-church-stone' ], [ paint, 'santa-maria-church-paint' ], [ plaster, 'santa-maria-church-plaster' ], [ wood, 'santa-maria-church-door' ] ] ) {

			const mesh = new Mesh( K.build(), materials.plaster );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// The steps down from Praça de Santa Maria toward the Igreja da Misericórdia (photo
	// references/...-2fa087ec-...; TerrainData lays the fall): rows of pale stone across the alley every
	// three metres, the long cobbled treads between them; going down, on the right a white wall with a strong
	// blue foot, its top level (the terrace behind it), an iron handrail along it on posts; on the left the walled
	// garden's tall plain wall, white over a dark red foot; a flowering bush in the bottom corner.
	_santaMariaSteps( materials ) {

		const S = this.terrain.santaMariaSteps;
		if ( ! S ) return;
		const kit = this.kit, plaster = new MeshKit();
		const yaw = Math.atan2( - S.dir[ 1 ], S.dir[ 0 ] ), left = [ S.dir[ 1 ], - S.dir[ 0 ] ];
		const at = ( t, d = 0 ) => [ S.from[ 0 ] + S.dir[ 0 ] * t + left[ 0 ] * d, S.from[ 1 ] + S.dir[ 1 ] * t + left[ 1 ] * d ];
		const tOf = ( P ) => ( P[ 0 ] - S.from[ 0 ] ) * S.dir[ 0 ] + ( P[ 1 ] - S.from[ 1 ] ) * S.dir[ 1 ];
		const alleyY = ( P ) => S.y( tOf( P ) );

		// the steps' edges: long worn stones, standing a hand's breadth over the cobbles below them
		kit.vdata = [ 0.43, 0.55, 0, 0 ];
		kit.color = [ 0.74, 0.73, 0.69 ];
		for ( let t = 1.4; t < S.length - 3.0; t += 2.9 ) { // (none on the level corner at its foot)

			const [ x, z ] = at( t ), y = S.y( t );
			kit.box( x, y + 0.01, z, 0.32, 0.2, 2 * S.HALF + 0.3, yaw ); // its top a short riser over the tread below

		}

		// the walls: on the south (the right going down) as high as the terrace behind it, so its top stays
		// level while the alley falls; on the north the garden's, taller
		const [ s0, s1 ] = S.south, [ n0, n1 ] = S.north, top = S.top;
		this._oldWall( plaster, s0, s1, - 1, alleyY, top - alleyY( s0 ), top - alleyY( s1 ), 53, false, { foot: lin( [ 0.2, 0.34, 0.8 ] ), ivy: false } );
		const ntop = alleyY( n0 ) + 3.2;
		// (down at the corner, as high again over the alley's foot as the wall turning down the ramp)
		const nEnd = alleyY( n1 ) + 4.2;
		this._oldWall( plaster, n0, n1, 1, alleyY, ntop - alleyY( n0 ), nEnd - alleyY( n1 ), 59, false, { foot: lin( [ 0.66, 0.16, 0.16 ] ), ivy: false } );

		// the handrail along the south wall: dark iron posts, a rail following the fall
		const SL = Math.hypot( s1[ 0 ] - s0[ 0 ], s1[ 1 ] - s0[ 1 ] ), su = [ ( s1[ 0 ] - s0[ 0 ] ) / SL, ( s1[ 1 ] - s0[ 1 ] ) / SL ];
		const out = [ - su[ 1 ], su[ 0 ] ]; // off the wall's face, into the alley
		const railAt = ( u ) => {

			const P = [ s0[ 0 ] + su[ 0 ] * u + out[ 0 ] * 0.14, s0[ 1 ] + su[ 1 ] * u + out[ 1 ] * 0.14 ];
			return [ P[ 0 ], alleyY( P ), P[ 1 ] ];

		};
		kit.vdata = [ 0.29, 0.2, 0, 0 ];
		kit.color = [ 0.06, 0.06, 0.06 ];
		const RAIL = Math.min( SL, 7.4 ), posts = Math.max( 2, Math.round( ( RAIL - 0.8 ) / 1.6 ) ); // (it stops short of the bush)
		let prev = null;
		for ( let i = 0; i <= posts; i ++ ) {

			const [ x, g, z ] = railAt( 0.4 + ( RAIL - 0.8 ) * i / posts ), head = [ x, g + 0.92, z ];
			ironBar( kit, [ x, g - 0.05, z ], head, 0.035 );
			if ( prev ) ironBar( kit, prev, head, 0.045 );
			prev = head;

		}

		// the terrace's other sides, held up by walls like the front one: its back (south), its east end, and
		// its west side along the way down from the square (photo references/...-814e8453-...)
		{

			const back = [ - out[ 0 ], - out[ 1 ] ], T = this.terrain, P = ( u, k ) => [ s0[ 0 ] + su[ 0 ] * u + back[ 0 ] * k, s0[ 1 ] + su[ 1 ] * u + back[ 1 ] * k ];
			// each from the lowest ground a metre out along it, so its top stays level over the uneven paving
			const base = ( A, B, n ) => {

				let lo = Infinity;
				for ( let f = 0; f <= 1.001; f += 0.05 ) lo = Math.min( lo, T.heightAt( A[ 0 ] + ( B[ 0 ] - A[ 0 ] ) * f + n[ 0 ], A[ 1 ] + ( B[ 1 ] - A[ 1 ] ) * f + n[ 1 ] ) );
				return lo;

			};
			const blue = lin( [ 0.2, 0.34, 0.8 ] );
			for ( const [ A, B, n, seed ] of [ [ P( SL, S.DEEP ), P( 0, S.DEEP ), back, 67 ], [ P( SL, 0.25 ), P( SL, S.DEEP ), su, 71 ], [ P( 0, S.DEEP ), P( 0, 0.25 ), [ - su[ 0 ], - su[ 1 ] ], 73 ] ] ) {

				const g = base( A, B, n );
				this._oldWall( plaster, A, B, - 1, () => g, top - g, top - g, seed, false, { foot: blue, ivy: false } );

			}

			// the floor: grey stone paving level just under the walls' tops, over the ground, and a collider for it
			const F = top - 0.05, corners = [ P( 0, 0 ), P( SL, 0 ), P( SL, S.DEEP ), P( 0, S.DEEP ) ];
			kit.vdata = [ 0.71, 0.3, 0, 0 ];
			kit.color = [ 0.74, 0.72, 0.67 ];
			kit.quadFacing( ...corners.map( ( q ) => [ q[ 0 ], F, q[ 1 ] ] ), [ 0, 1, 0 ], corners.map( ( q ) => [ q[ 0 ], q[ 1 ] ] ) );
			const Cf = P( SL / 2, S.DEEP / 2 ), lo = base( corners[ 0 ], corners[ 2 ], [ 0, 0 ] ) - 0.5;
			this.colliders.addBox( new Vector3( Cf[ 0 ], ( F + lo ) / 2, Cf[ 1 ] ), new Vector3( SL / 2, ( F - lo ) / 2, S.DEEP / 2 ), Math.atan2( - su[ 1 ], su[ 0 ] ), { walkable: true, tag: 'terrace' } );

			// a coping of old brownish stone along all four tops, moss in it
			kit.vdata = [ 0.43, 0.6, 0, 0 ];
			kit.color = [ 0.36, 0.33, 0.27 ];
			const C = P( SL / 2, S.DEEP / 2 );
			for ( const [ A, B ] of [ [ P( 0, 0 ), P( SL, 0 ) ], [ P( SL, 0 ), P( SL, S.DEEP ) ], [ P( SL, S.DEEP ), P( 0, S.DEEP ) ], [ P( 0, S.DEEP ), P( 0, 0 ) ] ] ) {

				const M = [ ( A[ 0 ] + B[ 0 ] ) / 2, ( A[ 1 ] + B[ 1 ] ) / 2 ], l = Math.hypot( B[ 0 ] - A[ 0 ], B[ 1 ] - A[ 1 ] );
				const m = Math.hypot( C[ 0 ] - M[ 0 ], C[ 1 ] - M[ 1 ] ), inw = [ ( C[ 0 ] - M[ 0 ] ) / m, ( C[ 1 ] - M[ 1 ] ) / m ];
				kit.box( M[ 0 ] + inw[ 0 ] * 0.24, top + 0.04, M[ 1 ] + inw[ 1 ] * 0.24, l + 0.1, 0.08, 0.62, Math.atan2( - ( B[ 1 ] - A[ 1 ] ), B[ 0 ] - A[ 0 ] ) );

			}

		}

		// in the garden's wall at the top of the steps, facing the way down from the square (photo
		// references/...-814e8453-...): a green double door of panels in a surround of rough grey stone,
		// its head a low arch of blocks
		{

			const NL = Math.hypot( n1[ 0 ] - n0[ 0 ], n1[ 1 ] - n0[ 1 ] ), nu = [ ( n1[ 0 ] - n0[ 0 ] ) / NL, ( n1[ 1 ] - n0[ 1 ] ) / NL ];
			const face = [ nu[ 1 ], - nu[ 0 ] ]; // toward the alley
			const U = 1.7, D = [ n0[ 0 ] + nu[ 0 ] * U, n0[ 1 ] + nu[ 1 ] * U ], g = this.terrain.heightAt( D[ 0 ] + face[ 0 ] * 0.6, D[ 1 ] + face[ 1 ] * 0.6 );
			const dyaw = Math.atan2( - nu[ 1 ], nu[ 0 ] ), W = 1.5, H = 2.2;
			const put = ( u, y, w, h, d, k ) => kit.box( D[ 0 ] + nu[ 0 ] * u + face[ 0 ] * k, y, D[ 1 ] + nu[ 1 ] * u + face[ 1 ] * k, w, h, d, dyaw );
			kit.vdata = [ 0.43, 0.5, 0, 0 ];
			kit.color = [ 0.08, 0.32, 0.26 ];
			put( 0, g + H / 2, W, H, 0.06, 0.0 ); // the doors
			kit.color = [ 0.06, 0.26, 0.21 ];
			for ( const su2 of [ - 1, 1 ] ) for ( const y of [ 0.55, 1.5 ] ) put( su2 * W / 4, g + y, W / 2 - 0.3, 0.6, 0.04, 0.04 ); // their panels
			put( 0, g + H / 2, 0.03, H, 0.04, 0.04 ); // the meeting stile
			kit.color = [ 0.5, 0.49, 0.45 ];
			for ( const sd of [ - 1, 1 ] ) for ( let y = g, i = 0; y < g + H - 0.05; i ++ ) {

				// the jambs: rough blocks of uneven height and width
				const h = 0.32 + ( ( i * 7 + ( sd > 0 ? 3 : 0 ) ) % 4 ) * 0.05, w = 0.3 + ( ( i * 5 + ( sd > 0 ? 1 : 0 ) ) % 3 ) * 0.06;
				put( sd * ( W / 2 + w / 2 ), y + Math.min( h, g + H - y ) / 2, w, Math.min( h, g + H - y ) - 0.02, 0.16, 0.05 );
				y += h;

			}

			for ( let i = 0; i < 7; i ++ ) {

				// the head: blocks over the doors, rising a little to the middle
				const a = ( i + 0.5 ) / 7 - 0.5, bw = ( W + 0.7 ) / 7;
				put( a * ( W + 0.7 ), g + H + 0.24 + 0.14 * Math.cos( a * Math.PI ), bw - 0.02, 0.5 + 0.12 * Math.cos( a * Math.PI ), 0.17, 0.05 );

			}

		}

		// the Museu's side door on the way down from the square (photo references/...-814e8453-...): a door of dark
		// green boards in a plain frame of pale stone, two worn stone steps up to it standing out into the way
		{

			const A = [ 10, - 20.4 ], B = [ 8.5, - 8.3 ], ML = Math.hypot( B[ 0 ] - A[ 0 ], B[ 1 ] - A[ 1 ] );
			const mu = [ ( B[ 0 ] - A[ 0 ] ) / ML, ( B[ 1 ] - A[ 1 ] ) / ML ], mo = [ mu[ 1 ], - mu[ 0 ] ]; // along the front, out of it
			const D = [ A[ 0 ] + mu[ 0 ] * 4.9, A[ 1 ] + mu[ 1 ] * 4.9 ], dyaw = Math.atan2( - mu[ 1 ], mu[ 0 ] ), T = this.terrain;
			const g = T.heightAt( D[ 0 ] + mo[ 0 ] * 1.2, D[ 1 ] + mo[ 1 ] * 1.2 ) - 0.02;
			const put = ( u, k, y, w, h, d ) => kit.box( D[ 0 ] + mu[ 0 ] * u + mo[ 0 ] * k, y, D[ 1 ] + mu[ 1 ] * u + mo[ 1 ] * k, w, h, d, dyaw );
			const sill = g + 0.36;
			kit.vdata = [ 0.43, 0.55, 0, 0 ];
			kit.color = [ 0.68, 0.66, 0.6 ];
			for ( const [ i, w, d ] of [ [ 0, 1.5, 0.95 ], [ 1, 1.3, 0.5 ] ] ) {

				// the steps, each a block from below the ground up to its tread
				const y1 = g + 0.18 * ( i + 1 ), y0 = g - 0.3;
				put( 0, d / 2, ( y0 + y1 ) / 2, w, y1 - y0, d );
				const c = [ D[ 0 ] + mo[ 0 ] * d / 2, D[ 1 ] + mo[ 1 ] * d / 2 ];
				this.colliders.addBox( new Vector3( c[ 0 ], ( y0 + y1 ) / 2, c[ 1 ] ), new Vector3( w / 2, ( y1 - y0 ) / 2, d / 2 ), dyaw, { walkable: true, tag: 'stair' } );

			}

			// the frame: jambs and a lintel of pale stone, a little proud of the plaster
			kit.color = [ 0.72, 0.69, 0.62 ];
			for ( const sd of [ - 1, 1 ] ) put( sd * 0.68, 0.06, sill + 1.2, 0.24, 2.4, 0.12 );
			put( 0, 0.06, sill + 2.52, 1.6, 0.26, 0.12 );
			kit.vdata = [ 0.43, 0.5, 0, 0 ];
			kit.color = [ 0.06, 0.22, 0.18 ];
			put( 0, 0.03, sill + 1.2, 1.12, 2.4, 0.06 ); // the door
			kit.color = [ 0.04, 0.17, 0.14 ];
			for ( let u = - 0.42; u < 0.45; u += 0.21 ) put( u, 0.065, sill + 1.2, 0.02, 2.36, 0.02 ); // its boards

		}

		// a terracotta pot of geraniums on the terrace wall's coping, a metre from its corner by the steps
		{

			const back = [ - out[ 0 ], - out[ 1 ] ], Q = [ s0[ 0 ] + back[ 0 ] * 1.0 + su[ 0 ] * 0.24, s0[ 1 ] + back[ 1 ] * 1.0 + su[ 1 ] * 0.24 ], rp = mulberry32( 83 );
			kit.vdata = [ 0.29, 0.6, 0, 0 ];
			kit.color = [ 0.62, 0.24, 0.11 ];
			const y0 = top + 0.08;
			kit.box( Q[ 0 ], y0 + 0.03, Q[ 1 ], 0.2, 0.06, 0.2, 0.3 ); // its foot
			kit.box( Q[ 0 ], y0 + 0.19, Q[ 1 ], 0.3, 0.26, 0.3, 0.3 ); // its belly
			kit.box( Q[ 0 ], y0 + 0.35, Q[ 1 ], 0.34, 0.06, 0.34, 0.3 ); // its rim
			const leaves = new MeshKit();
			leaves.vdata = [ 0, 0, 0.53, 4 ];
			for ( let i = 0; i < 160; i ++ ) {

				const a = rp() * Math.PI * 2, r = Math.sqrt( rp() ) * 0.28, h = rp() * 0.4, bloom = rp() < 0.12, sz = 0.05 + rp() * 0.05;
				leaves.color = lin( bloom ? [ 0.9, 0.25, 0.35 ] : [ 0.16 + rp() * 0.08, 0.36 + rp() * 0.1, 0.1 ] );
				leaves.box( Q[ 0 ] + Math.cos( a ) * r, y0 + 0.4 + h, Q[ 1 ] + Math.sin( a ) * r, sz, sz * 0.7, sz, rp() * 3 );

			}

			const lm = new Mesh( leaves.build(), materials.plaster );
			lm.name = 'santa-maria-pot';
			lm.castShadow = true;
			lm.staticVelocity = true;
			this.group.add( lm );

		}

		// the ramp down from the alley's foot to the Largo da Misericórdia (photo references/...-2241-814e8453-...):
		// long cobbled treads edged with stone like the alley's; on its left going down the garden's wall turning
		// from the alley, white over its dark red foot, coming down with it
		const R = S.ramp, ST = S.stair, X = S.cross, T = this.terrain;
		const rampY = ( P ) => R.y( ( P[ 0 ] - R.from[ 0 ] ) * R.dir[ 0 ] + ( P[ 1 ] - R.from[ 1 ] ) * R.dir[ 1 ] );
		kit.vdata = [ 0.43, 0.55, 0, 0 ];
		kit.color = [ 0.74, 0.73, 0.69 ];
		for ( let t = 1.9; t < R.length - 0.6; t += 1.8 ) {

			const x = R.from[ 0 ] + R.dir[ 0 ] * t, z = R.from[ 1 ] + R.dir[ 1 ] * t;
			kit.box( x, R.y( t ) + 0.01, z, 0.3, 0.2, 2 * R.HALF + 0.4, Math.atan2( - R.dir[ 1 ], R.dir[ 0 ] ) );

		}

		{

			const A = n1, Bw = [ 21.25, 0.6 ];
			this._oldWall( plaster, A, Bw, 1, rampY, nEnd - rampY( A ), 3.4, 61, false, { foot: lin( [ 0.66, 0.16, 0.16 ] ), ivy: false } );

		}

		// the wayside cross (OSM; the photo): a tall plain cross of grey stone on a pedestal and two square steps,
		// on a block between the ramp and the stair, whitewashed over a black foot, a stone slab on its top
		{

			// (its top level with the passage behind it and the stair's first flight: photo -1018-)
			const g = Math.min( T.heightAt( X.x, X.z + X.d / 2 + 0.3 ), T.heightAt( X.x - X.w / 2, X.z ) ), y0 = g - 0.5, yt = Math.max( g + 1.0, S.landing.y - 0.1 );
			plaster.vdata = [ 0, 0, 0.53, 4 ];
			plaster.color = lin( [ 0.9, 0.9, 0.88 ] );
			plaster.box( X.x, ( g + 0.78 + yt ) / 2, X.z, X.w, yt - g - 0.78, X.d, 0 );
			plaster.color = lin( [ 0.04, 0.04, 0.04 ] );
			plaster.box( X.x, ( y0 + g + 0.78 ) / 2, X.z, X.w + 0.01, g + 0.78 - y0, X.d + 0.01, 0 );
			this.colliders.addBox( new Vector3( X.x, ( y0 + yt ) / 2, X.z ), new Vector3( X.w / 2, ( yt - y0 ) / 2, X.d / 2 ), 0, { walkable: true, tag: 'wall' } );
			kit.vdata = [ 0.43, 0.6, 0, 0 ];
			kit.color = [ 0.6, 0.58, 0.53 ];
			let y = yt;
			for ( const [ w, h ] of [ [ X.w + 0.08, 0.1 ], [ 1.5, 0.17 ], [ 1.1, 0.17 ], [ 0.6, 0.62 ], [ 0.72, 0.1 ] ] ) {

				// the slab, the two steps, the pedestal and its cap
				kit.box( X.x, y + h / 2, X.z - ( w > X.w ? 0 : 0.2 ), w, h, w > X.w ? X.d + 0.08 : w, 0 );
				y += h;

			}

			kit.color = [ 0.66, 0.64, 0.6 ];
			kit.box( X.x, y + 1.75, X.z - 0.2, 0.26, 3.5, 0.24, 0 ); // the shaft
			// its fluting (photo references/...-2302-...): ribs standing out between shallow grooves on each face
			kit.color = [ 0.7, 0.68, 0.64 ];
			for ( const f of [ - 0.08, 0, 0.08 ] ) {

				kit.box( X.x + f, y + 1.55, X.z - 0.2 - 0.125, 0.035, 3.0, 0.02, 0 );
				kit.box( X.x + f, y + 1.55, X.z - 0.2 + 0.125, 0.035, 3.0, 0.02, 0 );
				kit.box( X.x - 0.135, y + 1.55, X.z - 0.2 + f, 0.02, 3.0, 0.035, 0 );
				kit.box( X.x + 0.135, y + 1.55, X.z - 0.2 + f, 0.02, 3.0, 0.035, 0 );

			}

			kit.color = [ 0.66, 0.64, 0.6 ];
			kit.box( X.x, y + 2.95, X.z - 0.2, 1.75, 0.26, 0.22, 0 ); // the arms
			this.colliders.addBox( new Vector3( X.x, y + 1.75, X.z - 0.2 ), new Vector3( 0.15, 1.75, 0.15 ), 0, { walkable: false, tag: 'wall' } );

		}

		// the stair up from the Largo: long stone steps from the foot of the Igreja da Misericórdia's wall up along
		// the terrace's east wall, in two flights either side of a level passage of stone slabs that comes across
		// from the ramp just behind the cross; a whitewashed wall with a blue foot on its right past the church's
		// corner; on its left the cross's block, then open to the passage and the ramp
		{

			const LD = S.landing, xm = ( ST.x0 + ST.x1 ) / 2, W = ST.x1 - ST.x0;
			kit.vdata = [ 0.43, 0.55, 0, 0 ];
			const flightSteps = ( zFrom, zTo, y0, y1, first ) => {

				const N = Math.max( 2, Math.round( ( y1 - y0 ) / 0.17 ) ), rise = ( y1 - y0 ) / N, tread = ( zFrom - zTo ) / N;
				for ( let i = 0; i < N; i ++ ) {

					const z0 = zFrom - tread * i, z1 = z0 - tread - ( i < N - 1 ? 0.02 : 0 ), top = y0 + rise * ( i + 1 ), bottom = y0 - 0.4;
					kit.color = [ 0.7 - ( i % 3 ) * 0.02, 0.69 - ( i % 3 ) * 0.02, 0.64 - ( i % 2 ) * 0.02 ];
					// (the lower flight's steps out in front of the cross's block run on a little to its left: photo -2302-)
					const extra = first && z0 - tread > X.z + X.d / 2 ? 0.55 : 0, sw = W + extra, sx = xm - extra / 2, zz1 = i === N - 1 ? ( first ? z0 - tread : zTo ) : z1;
					kit.box( sx, ( top + bottom ) / 2, ( z0 + zz1 ) / 2, sw, top - bottom, z0 - zz1, 0 );
					this.colliders.addBox( new Vector3( sx, ( top + bottom ) / 2, ( z0 + zz1 ) / 2 ), new Vector3( sw / 2, ( top - bottom ) / 2, ( z0 - zz1 ) / 2 ), 0, { walkable: true, tag: 'stair' } );

				}

			};
			flightSteps( ST.zb, LD.z0, ST.yB, LD.y, true );
			flightSteps( LD.zL, ST.zt - 0.3, LD.y, ST.yT, false ); // (from the L of the terrace's wall)
			// the passage behind the cross: big pale slabs, level with the block's top and the stair's landing, from
			// the corner at the alley's foot (four steps up to it, photo -1045-) across to the stair's far side and
			// back to the L of the terrace's wall
			const px0 = LD.x0, px1 = ST.x1, pz0 = LD.z0, pz1 = LD.zL;
			kit.color = [ 0.72, 0.7, 0.65 ];
			for ( let x = px0, k = 0; x < px1 - 0.05; k ++ ) {

				const w = Math.min( px1 - x, 0.9 + ( k % 3 ) * 0.25 );
				for ( let z = pz0, m = 0; z > pz1 + 0.05; m ++ ) {

					const d = Math.min( z - pz1, 0.9 + ( ( k + m ) % 3 ) * 0.3 );
					kit.box( x + w / 2, LD.y - 0.2, z - d / 2, w - 0.02, 0.4, d - 0.02, 0 );
					z -= d;

				}

				x += w;

			}

			this.colliders.addBox( new Vector3( ( px0 + px1 ) / 2, LD.y - 0.3, ( pz0 + pz1 ) / 2 ), new Vector3( ( px1 - px0 ) / 2, 0.3, ( pz0 - pz1 ) / 2 ), 0, { walkable: true, tag: 'stair' } );
			{

				// the four steps up from the corner, along the back of the cross's block to its corner by the stair
				const N = 4, rise = ( LD.y - S.y( 1e3 ) ) / N, tr = LD.run / N, y0s = S.y( 1e3 );
				for ( let i = 0; i < N; i ++ ) {

					const xa = LD.x0 - LD.run + tr * i, top = y0s + rise * ( i + 1 ), bottom = y0s - 0.3;
					kit.color = [ 0.7 - ( i % 2 ) * 0.03, 0.68 - ( i % 2 ) * 0.03, 0.63 ];
					kit.box( ( xa + LD.x0 ) / 2, ( top + bottom ) / 2, ( pz0 + pz1 ) / 2, LD.x0 - xa, top - bottom, pz0 - pz1, 0 );
					this.colliders.addBox( new Vector3( ( xa + LD.x0 ) / 2, ( top + bottom ) / 2, ( pz0 + pz1 ) / 2 ), new Vector3( ( LD.x0 - xa ) / 2, ( top - bottom ) / 2, ( pz0 - pz1 ) / 2 ), 0, { walkable: true, tag: 'stair' } );

				}

			}

			const flight = ( P ) => ST.y( P[ 1 ] );
			// on its right, the Misericórdia's side right against the lower steps, white over its black foot,
			// golden stone quoins up its corner (photo references/...-2302-...); past it, set back a little, a
			// lower wall with a blue foot up to the top
			const CZ = ST.zb - 1.8, blue = lin( [ 0.2, 0.34, 0.8 ] ); // (the church's side along the first few steps)
			// (the Misericórdia's own front, Town's, runs along the lower steps to its corner at CZ: _misericordiaPortal)
			this._oldWall( plaster, [ ST.x1 + 0.27, CZ ], [ ST.x1 + 0.27, ST.zt ], 1, flight, 2.6, 2.0, 81, false, { foot: blue, ivy: false } );

		}

		// on the terrace, three big square white parasols over the tables, open, their tops showing over the
		// walls from the Largo (photo references/...-2241-...)
		{

			const back = [ - out[ 0 ], - out[ 1 ] ], P = ( u, k ) => [ s0[ 0 ] + su[ 0 ] * u + back[ 0 ] * k, s0[ 1 ] + su[ 1 ] * u + back[ 1 ] * k ];
			const F = top - 0.05, pyaw = Math.atan2( - su[ 1 ], su[ 0 ] );
			for ( const u of [ 3.0, 6.6, 10.2 ] ) {

				const C = P( u, 1.9 ), yR = F + 2.35, yA = F + 2.75, H = 1.55; // the rim, the apex, half the canopy
				kit.vdata = [ 0.29, 0.2, 0, 0 ];
				kit.color = [ 0.08, 0.08, 0.08 ];
				kit.box( C[ 0 ], F + 0.06, C[ 1 ], 0.5, 0.12, 0.5, pyaw ); // the weighted base
				kit.box( C[ 0 ], F + ( yA + 0.1 - F ) / 2, C[ 1 ], 0.05, yA + 0.1 - F, 0.05, pyaw ); // the pole
				plaster.vdata = [ 0, 0, 0.53, 4 ];
				plaster.color = lin( [ 0.93, 0.93, 0.91 ] );
				const corner = ( a, b ) => [ C[ 0 ] + su[ 0 ] * H * a + back[ 0 ] * H * b, yR, C[ 1 ] + su[ 1 ] * H * a + back[ 1 ] * H * b ];
				const apex = [ C[ 0 ], yA, C[ 1 ] ], cs = [ corner( - 1, - 1 ), corner( 1, - 1 ), corner( 1, 1 ), corner( - 1, 1 ) ];
				for ( let i = 0; i < 4; i ++ ) {

					// four sloping panels, seen from above and below, and the valance hanging round the rim
					const a = cs[ i ], b = cs[ ( i + 1 ) % 4 ], m = [ ( a[ 0 ] + b[ 0 ] ) / 2 - C[ 0 ], 0, ( a[ 2 ] + b[ 2 ] ) / 2 - C[ 1 ] ];
					plaster.quadFacing( a, b, apex, apex, [ m[ 0 ], 1.2, m[ 2 ] ] );
					plaster.quadFacing( a, b, apex, apex, [ - m[ 0 ], - 1.2, - m[ 2 ] ] );
					const a2 = [ a[ 0 ], yR - 0.2, a[ 2 ] ], b2 = [ b[ 0 ], yR - 0.2, b[ 2 ] ];
					plaster.quadFacing( a2, b2, b, a, m );
					plaster.quadFacing( a2, b2, b, a, [ - m[ 0 ], 0, - m[ 2 ] ] );

				}

			}

		}

		// at the foot of the cross's block, a small kerbed bed of stones with a straggling shrub growing up its
		// black foot
		{

			const g = T.heightAt( X.x, X.z + X.d / 2 + 0.5 ), zf = X.z + X.d / 2 + 0.3, rb = mulberry32( 97 );
			kit.vdata = [ 0.43, 0.55, 0, 0 ];
			kit.color = [ 0.62, 0.6, 0.55 ];
			const bx = X.x - X.w / 2 + 0.6; // (in front of its left half)
			kit.box( bx, g + 0.08, zf + 0.28, 1.0, 0.22, 0.14, 0 );
			for ( const sd of [ - 1, 1 ] ) kit.box( bx + sd * 0.45, g + 0.08, zf + 0.12, 0.14, 0.22, 0.38, 0 );
			const shrub = new MeshKit();
			shrub.vdata = [ 0, 0, 0.53, 4 ];
			for ( let i = 0; i < 140; i ++ ) {

				const h = rb() * 1.0, x = bx + ( rb() - 0.5 ) * ( 0.35 + h * 0.4 ), z = zf + 0.05 + rb() * 0.2, sz = 0.04 + rb() * 0.05;
				shrub.color = lin( [ 0.15 + rb() * 0.08, 0.33 + rb() * 0.12, 0.1 ] );
				shrub.box( x, g + 0.15 + h, z, sz, sz * 0.7, sz, rb() * 3 );

			}

			const sm = new Mesh( shrub.build(), materials.plaster );
			sm.name = 'santa-maria-cross-shrub';
			sm.staticVelocity = true;
			this.group.add( sm );

		}

		// over the stair, a lantern on a curled iron bracket from the wall on its right (photo references/...-2241-...)
		{

			const lamps = new MeshKit(), z = - 8.6, wx = ST.x1 + 0.26, y0 = ST.y( z ) + 1.85, lx = ST.x1 - 0.45; // (under the wall's top)
			lamps.vdata = [ 0, 0, 0, 0 ];
			lamps.box( wx, y0 + 0.4, z, 0.06, 0.5, 0.24, 0 ); // the plate on the wall
			lamps.box( ( wx + lx ) / 2, y0 + 0.62, z, wx - lx, 0.05, 0.05, 0 ); // the arm
			lamps.box( ( wx + lx ) / 2 + 0.05, y0 + 0.42, z, 0.04, 0.4, 0.04, 0 ); // its curl
			lamps.box( lx, y0 + 0.55, z, 0.04, 0.14, 0.04, 0 );
			lamps.box( lx, y0 - 0.12, z, 0.18, 0.06, 0.18, 0 );
			lamps.box( lx, y0 + 0.4, z, 0.36, 0.06, 0.36, 0 );
			lamps.box( lx, y0 + 0.47, z, 0.14, 0.1, 0.14, 0 );
			lamps.vdata = [ 1, 0, 0, 0 ];
			lamps.box( lx, y0 + 0.13, z, 0.28, 0.46, 0.28, 0, 'top bottom' );
			this.lights.push( { position: new Vector3( lx, y0 + 0.1, z ), color: new Color( 1.0, 0.66, 0.36 ), intensity: 10, range: 14, kind: 'lantern', flicker: 0.04 } );
			const lm = new Mesh( lamps.build(), materials.lantern );
			lm.name = 'santa-maria-lantern';
			lm.staticVelocity = true;
			this.group.add( lm );

		}

		const mesh = new Mesh( plaster.build(), materials.plaster );
		mesh.name = 'santa-maria-steps';
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.staticVelocity = true;
		this.group.add( mesh );

		// the bush in the bottom corner against the south wall: dense leaves from the ground up, taller than a
		// person, small orange flowers; and on the terrace above, the café's tables and chairs by the wall
		const bush = new MeshKit(), rnd = mulberry32( 61 );
		bush.vdata = [ 0, 0, 0.53, 4 ];
		const B = [ s0[ 0 ] + su[ 0 ] * ( SL - 4.7 ) + out[ 0 ] * 0.8, s0[ 1 ] + su[ 1 ] * ( SL - 4.7 ) + out[ 1 ] * 0.8 ], gB = alleyY( B );
		for ( let i = 0; i < 2600; i ++ ) {

			// a rounded mass, broad and full low down, narrowing to the top
			const h = Math.sqrt( rnd() ) * 2.2, rr = 0.85 * Math.sqrt( 1 - ( ( h - 0.9 ) / 1.35 ) ** 2 ) * Math.sqrt( rnd() ), a = rnd() * Math.PI * 2;
			const x = B[ 0 ] + Math.cos( a ) * rr * 1.15, z = B[ 1 ] + Math.sin( a ) * rr * 0.8, sz = 0.05 + rnd() * 0.07, bloom = rnd();
			bush.color = lin( bloom < 0.06 ? [ 0.95, 0.5, 0.12 ] : [ 0.12 + rnd() * 0.08, 0.26 + rnd() * 0.12, 0.08 ] );
			bush.box( x, gB + 0.05 + 2.2 - h, z, bloom < 0.06 ? sz * 0.7 : sz, sz * 0.8, bloom < 0.06 ? sz * 0.7 : sz, rnd() * 3 );

		}

		// and in the garden behind the tall wall, a tree leaning its branches over the top (photo
		// references/...-814e8453-...)
		this.extraTrees = this.extraTrees || [];
		this.extraTrees.push( { kind: 'garden', x: 13.8, z: - 5.0, scale: 1.3 } );
		// and the plane trees over the stair's top, before the church of Santa Maria (photo references/...-2241-...)
		this.extraTrees.push( { kind: 'plane', x: 30.5, z: - 20.5, scale: 0.85 }, { kind: 'plane', x: 24.5, z: - 26.5, scale: 0.8 } );

		const bushMesh = new Mesh( bush.build(), materials.plaster );
		bushMesh.name = 'santa-maria-bush';
		bushMesh.castShadow = true;
		bushMesh.receiveShadow = true;
		bushMesh.staticVelocity = true;
		this.group.add( bushMesh );

		kit.vdata = [ 0.29, 0.2, 0, 0 ];
		for ( const u of [ 1.6, 4.4 ] ) {

			// a small round table, two chairs, a step back from the wall's top
			const C = [ s0[ 0 ] + su[ 0 ] * u - out[ 0 ] * 1.3, s0[ 1 ] + su[ 1 ] * u - out[ 1 ] * 1.3 ], g = S.top - 0.05;
			kit.color = [ 0.06, 0.06, 0.06 ];
			kit.box( C[ 0 ], g + 0.36, C[ 1 ], 0.05, 0.72, 0.05, 0 );
			kit.color = [ 0.55, 0.55, 0.53 ];
			kit.box( C[ 0 ], g + 0.73, C[ 1 ], 0.6, 0.03, 0.6, yaw + 0.785 );
			for ( const sgn of [ - 1, 1 ] ) {

				const P = [ C[ 0 ] + su[ 0 ] * 0.55 * sgn, C[ 1 ] + su[ 1 ] * 0.55 * sgn ], cy = Math.atan2( - su[ 1 ], su[ 0 ] );
				kit.color = [ 0.05, 0.05, 0.05 ];
				kit.box( P[ 0 ], g + 0.45, P[ 1 ], 0.4, 0.04, 0.4, cy ); // the seat
				for ( const [ a, b ] of [ [ - 1, - 1 ], [ - 1, 1 ], [ 1, - 1 ], [ 1, 1 ] ] ) kit.box( P[ 0 ] + su[ 0 ] * 0.17 * a + out[ 0 ] * 0.17 * b, g + 0.22, P[ 1 ] + su[ 1 ] * 0.17 * a + out[ 1 ] * 0.17 * b, 0.03, 0.45, 0.03, cy );
				const Bk = [ P[ 0 ] + su[ 0 ] * 0.19 * sgn, P[ 1 ] + su[ 1 ] * 0.19 * sgn ];
				kit.box( Bk[ 0 ], g + 0.68, Bk[ 1 ], 0.03, 0.44, 0.4, cy ); // the back

			}

		}

	}

	// The lane from the Largo da Misericórdia north under the arch beside the house-tower (photo
	// references/...-1912-3408fb6f-...; TerrainData evens it): on its left going up the walled garden's tall
	// wall, white over a dark red foot, holding the garden up (the tower's forecourt and its bollards on its right:
	// _torreLargo).
	_torreLane( materials ) {

		const S = this.terrain.santaMariaSteps;
		if ( ! S || ! S.lane ) return;
		const T = this.terrain, kit = this.kit, plaster = new MeshKit(), W = S.lane.wall;
		// the wall, in short lengths so its top climbs evenly over the uneven lane: from the ramp's wall's end
		// (as high) up to the garden's height at the arch
		const pts = [];
		for ( let i = 0; i + 1 < W.length; i ++ ) {

			const n = Math.ceil( Math.hypot( W[ i + 1 ][ 0 ] - W[ i ][ 0 ], W[ i + 1 ][ 1 ] - W[ i ][ 1 ] ) / 1.5 );
			for ( let k = 0; k < n; k ++ ) pts.push( [ W[ i ][ 0 ] + ( W[ i + 1 ][ 0 ] - W[ i ][ 0 ] ) * k / n, W[ i ][ 1 ] + ( W[ i + 1 ][ 1 ] - W[ i ][ 1 ] ) * k / n ] );

		}

		pts.push( W[ W.length - 1 ] );
		const t0 = S.ramp.y( 1e3 ) + 3.4, t1 = 56.4;
		for ( let i = 0; i + 1 < pts.length; i ++ ) {

			const A = pts[ i ], B = pts[ i + 1 ], l = Math.hypot( B[ 0 ] - A[ 0 ], B[ 1 ] - A[ 1 ] );
			const e = [ ( B[ 1 ] - A[ 1 ] ) / l, - ( B[ 0 ] - A[ 0 ] ) / l ]; // toward the lane (east)
			const low = ( P ) => T.heightAt( P[ 0 ] + e[ 0 ] * 0.9, P[ 1 ] + e[ 1 ] * 0.9 );
			const ta = t0 + ( t1 - t0 ) * i / ( pts.length - 1 ), tb = t0 + ( t1 - t0 ) * ( i + 1 ) / ( pts.length - 1 );
			this._oldWall( plaster, A, B, 1, low, ta - low( A ), tb - low( B ), 101 + i, false, { foot: lin( [ 0.66, 0.16, 0.16 ] ), ivy: false } );

		}

		const mesh = new Mesh( plaster.build(), materials.plaster );
		mesh.name = 'torre-lane';
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.staticVelocity = true;
		this.group.add( mesh );

	}

	// The Igreja da Misericórdia's front to its Largo (photo references/...-1512-...; Town leaves it without painted
	// openings, BLANK_FRONTS): a baroque portal of honey-coloured stone, its double door of dark wood carved in
	// diamond-pointed panels between moulded jambs, plinths and pilasters ending in small scrolls, an entablature,
	// and over it a niche with the Virgin in blue-and-white azulejo between two great scrolls of a broken pediment,
	// a crowned cartouche on top; across the whole front a moulded band, a small barred window over the portal,
	// golden quoins up both corners; by the door a little rust-brown sign post.
	_misericordiaPortal( materials ) {

		const T = this.terrain, kit = this.kit, wood = new MeshKit(), paint = new MeshKit();
		const P0 = [ 27.1, 2.3 ], P1 = [ 28.24, - 8.8 ], FL = Math.hypot( P1[ 0 ] - P0[ 0 ], P1[ 1 ] - P0[ 1 ] ); // (Town's OUTLINE)
		const U = [ ( P1[ 0 ] - P0[ 0 ] ) / FL, ( P1[ 1 ] - P0[ 1 ] ) / FL ], N = [ U[ 1 ], - U[ 0 ] ]; // (N: out, to the Largo)
		const yaw = Math.atan2( - U[ 1 ], U[ 0 ] ), uC = FL / 2, face = [ N[ 0 ], 0, N[ 1 ] ]; // (the portal in the middle, under the window and the gable's apex)
		const W = ( s, y, k ) => [ P0[ 0 ] + U[ 0 ] * ( uC + s ) + N[ 0 ] * k, y, P0[ 1 ] + U[ 1 ] * ( uC + s ) + N[ 1 ] * k ];
		const box = ( K, s, y0, y1, w, k0, k1 ) => {

			const Q = W( s, 0, ( k0 + k1 ) / 2 );
			K.box( Q[ 0 ], ( y0 + y1 ) / 2, Q[ 2 ], w, y1 - y0, k1 - k0, yaw );

		};
		// a flat ring (or disc, r0 = 0) in the front's plane, k out, from angle a0 to a1 round ( s, y )
		const ring = ( K, s, y, r0, r1, a0, a1, k, n = 14 ) => {

			for ( let i = 0; i < n; i ++ ) {

				const t0 = a0 + ( a1 - a0 ) * i / n, t1 = a0 + ( a1 - a0 ) * ( i + 1 ) / n;
				const q = ( t, r ) => W( s + Math.cos( t ) * r, y + Math.sin( t ) * r, k );
				K.quadFacing( q( t0, r0 ), q( t1, r0 ), q( t1, r1 ), q( t0, r1 ), face );

			}

		};
		const gp = W( 0, 0, 1.0 ), g = T.heightAt( gp[ 0 ], gp[ 2 ] );
		// (smooth dressed stone: flat-painted, in two tones for the mouldings' shade)
		const STONE = lin( [ 0.86, 0.72, 0.56 ] ), SHADE = lin( [ 0.7, 0.57, 0.44 ] ), SK = new MeshKit();
		SK.vdata = [ 0, 0, 0.53, 4 ];
		SK.color = STONE;
		// plinths, pilasters with their small scrolls, the jambs
		for ( const sd of [ - 1, 1 ] ) {

			box( SK, sd * 1.3, g - 0.2, g + 0.8, 0.6, 0, 0.32 );
			box( SK, sd * 1.3, g + 0.8, g + 3.85, 0.44, 0, 0.24 );
			SK.color = SHADE;
			ring( SK, sd * 1.3, g + 3.72, 0.06, 0.2, 0, Math.PI * 2, 0.26 );
			SK.color = STONE;
			box( SK, sd * 0.99, g - 0.05, g + 3.62, 0.32, 0, 0.17 );

		}

		// the entablature and its cornice
		box( SK, 0, g + 3.62, g + 4.1, 3.2, 0, 0.3 );
		SK.color = SHADE;
		box( SK, 0, g + 4.1, g + 4.24, 3.45, 0, 0.4 );
		SK.color = STONE;
		// the niche between the scrolls: its block, the dark round-headed recess, the Virgin in azulejo
		box( SK, 0, g + 4.24, g + 5.55, 1.0, 0, 0.26 );
		ring( SK, 0, g + 5.1, 0.28, 0.4, 0, Math.PI, 0.27 );
		paint.vdata = [ 0, 0, 0.53, 4 ];
		paint.color = lin( [ 0.55, 0.46, 0.38 ] );
		box( paint, 0, g + 4.35, g + 5.1, 0.56, 0.25, 0.27 );
		ring( paint, 0, g + 5.1, 0, 0.28, 0, Math.PI, 0.27 );
		paint.color = lin( [ 0.92, 0.93, 0.95 ] );
		box( paint, 0, g + 4.38, g + 4.52, 0.34, 0.27, 0.36 ); // her pedestal
		paint.color = lin( [ 0.2, 0.33, 0.72 ] );
		box( paint, 0, g + 4.52, g + 5.0, 0.2, 0.28, 0.35 ); // her mantle
		paint.color = lin( [ 0.95, 0.94, 0.92 ] );
		box( paint, 0, g + 4.7, g + 4.95, 0.1, 0.33, 0.36 ); // her robe, the child
		box( paint, 0, g + 5.0, g + 5.12, 0.08, 0.29, 0.35 ); // her head
		// the two great scrolls of the broken pediment, curling out from the niche, and their eyes
		for ( const sd of [ - 1, 1 ] ) {

			SK.color = STONE;
			box( SK, sd * 0.85, g + 4.24, g + 4.9, 0.7, 0, 0.2 );
			ring( SK, sd * 1.0, g + 5.0, 0.38, 0.6, sd > 0 ? - 0.3 : Math.PI + 0.3, sd > 0 ? Math.PI * 1.2 : - Math.PI * 0.2, 0.22, 18 );
			SK.color = SHADE;
			ring( SK, sd * 1.12, g + 4.95, 0, 0.22, 0, Math.PI * 2, 0.24 );
			SK.color = STONE;
			ring( SK, sd * 1.12, g + 4.95, 0.08, 0.16, 0, Math.PI * 2, 0.25 );

		}

		// the crowned cartouche on top
		box( SK, 0, g + 5.55, g + 5.75, 1.25, 0, 0.3 );
		box( SK, 0, g + 5.75, g + 6.35, 0.6, 0, 0.22 );
		ring( SK, 0, g + 6.35, 0, 0.28, 0, Math.PI, 0.22 );
		// the door: dark boards, raised diamond-pointed panels in two leaves
		wood.vdata = [ 0, 0, 0.53, 5 ];
		wood.color = lin( [ 0.3, 0.2, 0.14 ] );
		box( wood, 0, g - 0.02, g + 3.5, 1.66, 0, 0.06 );
		wood.color = lin( [ 0.24, 0.16, 0.11 ] );
		for ( const sd of [ - 1, 1 ] ) for ( let r = 0; r < 5; r ++ ) {

			const yc = g + 0.45 + r * 0.66 + ( r === 0 ? 0 : 0.05 ), sc = sd * 0.41;
			box( wood, sc, yc - 0.25, yc + 0.25, 0.6, 0.06, 0.1 );
			box( wood, sc, yc - 0.15, yc + 0.15, 0.36, 0.1, 0.14 );
			box( wood, sc, yc - 0.06, yc + 0.06, 0.14, 0.14, 0.17 );

		}

		// the threshold
		kit.vdata = [ 0.43, 0.45, 0, 0 ];
		kit.color = [ 0.72, 0.7, 0.65 ];
		box( kit, 0, g - 0.25, g + 0.02, 2.0, 0, 0.5 );

		// across the front a moulded band, and the small barred window over the portal
		{

			paint.color = lin( [ 0.93, 0.93, 0.91 ] );
			const yb = g + 6.9, Qa = [ P0[ 0 ] + U[ 0 ] * 0.3 + N[ 0 ] * 0.06, P0[ 1 ] + U[ 1 ] * 0.3 + N[ 1 ] * 0.06 ], Qb = [ P1[ 0 ] - U[ 0 ] * 0.3 + N[ 0 ] * 0.06, P1[ 1 ] - U[ 1 ] * 0.3 + N[ 1 ] * 0.06 ];
			paint.box( ( Qa[ 0 ] + Qb[ 0 ] ) / 2, yb, ( Qa[ 1 ] + Qb[ 1 ] ) / 2, FL - 0.6, 0.22, 0.12, yaw );
			paint.box( ( Qa[ 0 ] + Qb[ 0 ] ) / 2, yb + 0.15, ( Qa[ 1 ] + Qb[ 1 ] ) / 2, FL - 0.6, 0.08, 0.18, yaw );
			// the big barred window under the gable, centred on it: a stone frame, dark panes behind an iron grid
			const sW = FL / 2 - uC, wy0 = g + 7.5, wy1 = g + 9.25;
			SK.color = STONE;
			box( SK, sW, wy0 - 0.12, wy1 + 0.12, 1.45, 0, 0.1 );
			paint.color = lin( [ 0.07, 0.08, 0.09 ] );
			box( paint, sW, wy0, wy1, 1.05, 0.1, 0.11 );
			SK.color = SHADE;
			box( SK, sW, wy0 - 0.2, wy0 - 0.08, 1.6, 0, 0.18 ); // its sill
			kit.vdata = [ 0.29, 0.2, 0, 0 ];
			kit.color = [ 0.08, 0.08, 0.08 ];
			for ( let s2 = - 0.42; s2 <= 0.43; s2 += 0.14 ) box( kit, sW + s2, wy0, wy1, 0.025, 0.12, 0.14 );
			for ( let y2 = wy0 + 0.15; y2 < wy1; y2 += 0.2 ) box( kit, sW, y2 - 0.012, y2 + 0.012, 1.05, 0.12, 0.14 );
		}

		// its gable (photo references/...-1526-): the front carried up over the eave (Town's eave, 61.0, its roof
		// sloping away behind) into a triangle, white, with a moulded cornice along its rakes and short returns at
		// its foot, Roman tiles along the rakes, a round oculus near the apex; at its south corner, over the stair, a
		// little stone bell-cote with its bell in a round arch, an iron cross on top
		{

			const yE = 61.75, RISE = 2.9, TH = 0.55, uA = FL / 2, gab = new MeshKit(), tiles = new MeshKit();
			const at = ( u, y, k ) => [ P0[ 0 ] + U[ 0 ] * u + N[ 0 ] * k, y, P0[ 1 ] + U[ 1 ] * u + N[ 1 ] * k ];
			const rake = ( u ) => yE + RISE * ( 1 - Math.abs( u - uA ) / uA );
			gab.vdata = [ 0, 0, 0.53, 4 ];
			gab.color = lin( [ 0.92, 0.92, 0.9 ] );
			// the wall: from the face's top (61.0 to 61.7 along it) up to the rakes, front and back faces, in slices
			const n = 12;
			for ( let i = 0; i < n; i ++ ) {

				const u0 = FL * i / n, u1 = FL * ( i + 1 ) / n, b0 = 60.4, b1 = 60.4; // (down over the face's top: no sliver of roof)
				for ( const [ k, nn ] of [ [ 0.04, face ], [ - TH, [ - face[ 0 ], 0, - face[ 2 ] ] ] ] ) gab.quadFacing( at( u0, b0, k ), at( u1, b1, k ), at( u1, rake( u1 ), k ), at( u0, rake( u0 ), k ), nn );

			}

			// its ends
			for ( const u of [ 0, FL ] ) gab.quadFacing( at( u, 61.0, 0 ), at( u, 61.0, - TH ), at( u, yE, - TH ), at( u, yE, 0 ), [ u === 0 ? - U[ 0 ] : U[ 0 ], 0, u === 0 ? - U[ 1 ] : U[ 1 ] ] );
			// the cornice along the rakes and its returns at the foot: a moulded strip standing proud
			for ( const [ ua, ub ] of [ [ - 0.15, uA ], [ uA, FL + 0.15 ] ] ) {

				const y0a = rake( Math.max( 0, Math.min( FL, ua ) ) ) - 0.05, y0b = rake( Math.max( 0, Math.min( FL, ub ) ) ) - 0.05;
				gab.quadFacing( at( ua, y0a - 0.3, 0.18 ), at( ub, y0b - 0.3, 0.18 ), at( ub, y0b, 0.18 ), at( ua, y0a, 0.18 ), face );
				gab.quadFacing( at( ua, y0a - 0.3, 0 ), at( ub, y0b - 0.3, 0 ), at( ub, y0b - 0.3, 0.18 ), at( ua, y0a - 0.3, 0.18 ), [ 0, - 1, 0 ] );
				// the tiles over it, from the front edge back over the wall
				tiles.vdata = [ 0.43, 0.7, 0, 0 ];
				tiles.color = [ 1, 1, 1 ];
				const L = Math.hypot( ub - ua, y0b - y0a );
				tiles.quadFacing( at( ua, y0a + 0.06, 0.28 ), at( ub, y0b + 0.06, 0.28 ), at( ub, y0b + 0.12, - TH - 0.1 ), at( ua, y0a + 0.12, - TH - 0.1 ), [ 0, 1, 0 ], [ [ 0, 0 ], [ L, 0 ], [ L, 0.9 ], [ 0, 0.9 ] ] );

			}

			for ( const [ ua, ub ] of [ [ - 0.15, 0.9 ], [ FL - 0.9, FL + 0.15 ] ] ) {

				// the returns, level along the eave
				const Q = at( ( ua + ub ) / 2, 0, 0.09 );
				gab.box( Q[ 0 ], yE - 0.2, Q[ 2 ], ub - ua, 0.3, 0.2, yaw );

			}

			// the oculus near the apex: a white moulded ring round a dark round
			const yO = yE + RISE - 1.05, sO = uA - uC;
			ring( gab, sO, yO, 0.24, 0.36, 0, Math.PI * 2, 0.06, 18 );
			paint.color = lin( [ 0.07, 0.07, 0.08 ] );
			ring( paint, sO, yO, 0, 0.24, 0, Math.PI * 2, 0.02, 18 );

			// the bell-cote over the south corner
			const uB = FL - 0.75, yB0 = rake( uB ) + 0.05, BS = lin( [ 0.74, 0.69, 0.6 ] );
			const bb = ( s, y0, y1, w, k0, k1 ) => {

				const Q = at( uB + s, 0, ( k0 + k1 ) / 2 );
				gab.box( Q[ 0 ], ( y0 + y1 ) / 2, Q[ 2 ], w, y1 - y0, k1 - k0, yaw );

			};
			gab.color = BS;
			bb( 0, yB0 - 0.4, yB0 + 0.2, 1.5, - 0.75, 0.2 ); // its base on the gable's corner
			for ( const sd of [ - 1, 1 ] ) bb( sd * 0.58, yB0 + 0.2, yB0 + 1.45, 0.3, - 0.6, 0.15 ); // the piers
			gab.color = lin( [ 0.68, 0.63, 0.55 ] );
			for ( const k of [ 0.15, - 0.6 ] ) ring( gab, uB - uC, yB0 + 1.45, 0.43, 0.72, 0, Math.PI, k, 12 ); // the arch, both faces
			bb( 0, yB0 + 1.45, yB0 + 2.25, 1.5, - 0.6, 0.15 ); // (its spandrels filled up to the cap: the arch shows on them)
			gab.color = BS;
			bb( 0, yB0 + 2.25, yB0 + 2.4, 1.7, - 0.7, 0.25 ); // its cap
			bb( 0, yB0 + 2.4, yB0 + 2.6, 1.1, - 0.55, 0.1 );
			paint.color = lin( [ 0.18, 0.15, 0.1 ] ); // the bell, its yoke
			const bell = ( s, y0, y1, w ) => {

				const Q = at( uB + s, 0, - 0.22 );
				paint.box( Q[ 0 ], ( y0 + y1 ) / 2, Q[ 2 ], w, y1 - y0, w, yaw );

			};
			bell( 0, yB0 + 0.75, yB0 + 0.85, 0.62 );
			bell( 0, yB0 + 0.85, yB0 + 1.1, 0.5 );
			bell( 0, yB0 + 1.1, yB0 + 1.3, 0.38 );
			bell( 0, yB0 + 1.3, yB0 + 1.42, 0.24 );
			bell( 0, yB0 + 1.42, yB0 + 1.5, 0.9 );
			kit.vdata = [ 0.29, 0.2, 0, 0 ];
			kit.color = [ 0.06, 0.06, 0.06 ];
			{

				const Q = at( uB, 0, - 0.22 );
				kit.box( Q[ 0 ], yB0 + 3.0, Q[ 2 ], 0.05, 0.8, 0.05, yaw ); // the cross
				kit.box( Q[ 0 ], yB0 + 3.15, Q[ 2 ], 0.36, 0.05, 0.05, yaw );

			}

			for ( const [ K, mat, name ] of [ [ gab, materials.plaster, 'misericordia-gable' ], [ tiles, materials.roof, 'misericordia-gable-tiles' ] ] ) {

				const mesh = new Mesh( K.build(), mat );
				mesh.name = name;
				mesh.castShadow = true;
				mesh.receiveShadow = true;
				mesh.staticVelocity = true;
				this.group.add( mesh );

			}

		}

		// golden quoins up both its corners
		const dir = ( a, b ) => {

			const l = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
			return [ ( b[ 0 ] - a[ 0 ] ) / l, ( b[ 1 ] - a[ 1 ] ) / l ];

		};
		this._quoinCorner( P0, [ dir( P0, P1 ), dir( P0, [ 41.7, 7 ] ) ], T.heightAt( ...P0 ) - 0.2, 61.4 );
		this._quoinCorner( P1, [ dir( P1, P0 ), dir( P1, [ 34.7, - 5.6 ] ) ], T.heightAt( ...P1 ) - 0.2, 60.8 );

		// the sign post by the door, toward the north corner
		{

			const s0 = - 2.3, gq = T.heightAt( ...[ W( s0, 0, 0.5 ) ].map( ( v ) => [ v[ 0 ], v[ 2 ] ] )[ 0 ] );
			paint.color = lin( [ 0.36, 0.15, 0.08 ] );
			box( paint, s0, gq - 0.1, gq + 1.55, 0.2, 0.42, 0.5 );
			box( paint, s0, gq + 1.55, gq + 1.7, 0.12, 0.43, 0.49 );
			box( paint, s0, gq + 1.7, gq + 1.82, 0.03, 0.44, 0.48 ); // the little cross
			box( paint, s0, gq + 1.74, gq + 1.77, 0.08, 0.44, 0.48 );
			paint.color = lin( [ 0.9, 0.9, 0.88 ] );
			box( paint, s0, gq + 1.0, gq + 1.3, 0.16, 0.5, 0.51 ); // its plaque

		}

		for ( const [ K, name ] of [ [ wood, 'misericordia-door' ], [ paint, 'misericordia-paint' ], [ SK, 'misericordia-portal' ] ] ) {

			const mesh = new Mesh( K.build(), materials.plaster );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// The medieval house-tower of bare stone facing the Largo da Misericórdia (photo
	// references/...-1912-3408fb6f-...; Town builds it in stone, STONE_HOUSES): in its front a pointed doorway
	// of dark boards in a ring of pale dressed stone, over it a tall pointed window of leaded panes in a moulded
	// frame, and high up to the right a small round-headed window opening onto a balcony of dark wood on three
	// brackets.
	_torreLargo( materials ) {

		const A = [ 21, 9.2 ], B = [ 26, 10.5 ], T = this.terrain, kit = this.kit, wood = new MeshKit();
		const FL = Math.hypot( B[ 0 ] - A[ 0 ], B[ 1 ] - A[ 1 ] ), U = [ ( B[ 0 ] - A[ 0 ] ) / FL, ( B[ 1 ] - A[ 1 ] ) / FL ], N = [ U[ 1 ], - U[ 0 ] ];
		const yaw = Math.atan2( - U[ 1 ], U[ 0 ] );
		const P = ( u, y, k = 0 ) => [ A[ 0 ] + U[ 0 ] * u + N[ 0 ] * k, y, A[ 1 ] + U[ 1 ] * u + N[ 1 ] * k ];
		const box = ( K, u, y, w, h, k, d ) => {

			const Q = P( u, y, k );
			K.box( Q[ 0 ], Q[ 1 ], Q[ 2 ], w, h, d, yaw );

		};
		const face = [ N[ 0 ], 0, N[ 1 ] ];
		// a pointed (or, ha = w / 2, round) arch's curve: points from the left springing over to the right, at
		// offset o out from the opening's edge
		const arch = ( uc, ys, w, ha, o, n = 10 ) => {

			const h = w / 2, c = Math.abs( ha - h ) < 1e-3 ? 0 : ( ha * ha - h * h ) / ( 2 * h ), r = h + c, pts = [];
			const top = Math.atan2( ha, - c ); // (the left arc, centred at +c, from angle pi up to the apex over uc)
			for ( let i = 0; i <= n; i ++ ) {

				const t = Math.PI + ( top - Math.PI ) * i / n;
				pts.push( [ uc + c + Math.cos( t ) * ( r + o ), ys + Math.sin( t ) * ( r + o ) ] );

			}

			for ( let i = n - 1; i >= 0; i -- ) {

				const [ x, y ] = pts[ i ];
				pts.push( [ 2 * uc - x, y ] );

			}

			return pts;

		};
		// a flat ring in the wall's plane between two outlines (same count), k out
		const ring = ( K, inner, outer, k ) => {

			for ( let i = 0; i + 1 < inner.length; i ++ ) K.quadFacing( P( inner[ i ][ 0 ], inner[ i ][ 1 ], k ), P( inner[ i + 1 ][ 0 ], inner[ i + 1 ][ 1 ], k ), P( outer[ i + 1 ][ 0 ], outer[ i + 1 ][ 1 ], k ), P( outer[ i ][ 0 ], outer[ i ][ 1 ], k ), face );

		};
		// a pointed / round opening filled flat (its jambs from y0 to its springing ys), k out
		const fill = ( K, uc, y0, ys, w, ha, k ) => {

			const top = arch( uc, ys, w, ha, 0 );
			K.quadFacing( P( uc - w / 2, y0, k ), P( uc + w / 2, y0, k ), P( uc + w / 2, ys, k ), P( uc - w / 2, ys, k ), face );
			for ( let i = 0; i + 1 < top.length; i ++ ) {

				const c = P( top[ i + 1 ][ 0 ], top[ i + 1 ][ 1 ], k );
				K.quadFacing( P( uc, ys, k ), P( top[ i ][ 0 ], top[ i ][ 1 ], k ), c, c, face );

			}

		};
		// a frame of dressed stone round an opening: jambs and the arch, width f, standing a little proud
		const frame = ( uc, y0, ys, w, ha, f, k = 0.04 ) => {

			ring( kit, arch( uc, ys, w, ha, 0 ), arch( uc, ys, w, ha, f ), k );
			for ( const sd of [ - 1, 1 ] ) box( kit, uc + sd * ( w / 2 + f / 2 ), ( y0 + ys ) / 2, f, ys - y0, k / 2, k );

		};

		// the doorway, from the Largo's ground (u runs from the front's right-hand corner, seen from the Largo)
		// the little Largo before it (photo references/...-1750-...; TerrainData gives it the Calçada's ground): a
		// wedge paved in big grey flagstones laid on the ground, between the Calçada and the lane to the arch; along
		// the lane, which stands a little higher, a low stone wall; worn stone bollards on it and at the wedge's
		// tip, an iron chain swagged between them
		const FP = this.terrain.santaMariaSteps.forecourt.poly;
		{

			let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
			for ( const [ x, z ] of FP ) {

				x0 = Math.min( x0, x ); x1 = Math.max( x1, x ); z0 = Math.min( z0, z ); z1 = Math.max( z1, z );

			}

			// the bedding between the flags: a dark draped floor in cells, just over the ground
			const CELL = 0.5, hy = ( x, z ) => T.heightAt( x, z ) + 0.02;
			kit.vdata = [ 0.71, 0.3, 0, 0 ];
			kit.color = [ 0.42, 0.41, 0.38 ];
			for ( let z = z0; z < z1; z += CELL ) for ( let x = x0; x < x1; x += CELL ) {

				if ( ! pointInPolygon( x + CELL / 2, z + CELL / 2, FP ) ) continue;
				const q = [ [ x, z ], [ x + CELL, z ], [ x + CELL, z + CELL ], [ x, z + CELL ] ];
				kit.quadFacing( ...q.map( ( [ a, b ] ) => [ a, hy( a, b ), b ] ), [ 0, 1, 0 ], q.map( ( [ a, b ] ) => [ a, b ] ) );

			}

			// the flags themselves (the photo -1506-): big worn rectangles in courses parallel to the tower's front,
			// each a quad a touch over the bedding, its own grey, with a fine gap round it
			const rf = mulberry32( 151 ), FH = ( x, z ) => T.heightAt( x, z ) + 0.04;
			let kk = 0.05, row = 0;
			while ( kk < 9 ) {

				const depth = 0.55 + rf() * 0.2;
				let uu = - 1 + ( row % 2 ) * 0.4;
				while ( uu < FL + 1 ) {

					const w = 0.7 + rf() * 0.35, c = P( uu + w / 2, 0, kk + depth / 2 );
					if ( pointInPolygon( c[ 0 ], c[ 2 ], FP ) ) {

						const g = 0.02, corners = [ [ uu + g, kk + g ], [ uu + w - g, kk + g ], [ uu + w - g, kk + depth - g ], [ uu + g, kk + depth - g ] ].map( ( [ u, k ] ) => {

							const Q = P( u, 0, k );
							return [ Q[ 0 ], FH( Q[ 0 ], Q[ 2 ] ), Q[ 2 ] ];

						} );
						const t = 0.72 + rf() * 0.1;
						kit.color = [ t, t - 0.01, t - 0.04 - rf() * 0.03 ];
						kit.quadFacing( ...corners, [ 0, 1, 0 ], corners.map( ( v ) => [ c[ 0 ] + ( v[ 0 ] - c[ 0 ] ) * 0.15, c[ 2 ] + ( v[ 2 ] - c[ 2 ] ) * 0.15 ] ) );

					}

					uu += w;

				}

				kk += depth;
				row ++;

			}

			// and along its open side to the Calçada a kerb of long stones, the flags a hand over the setts
			{

				const K0 = FP[ 1 ], K1 = FP[ 2 ], KL = Math.hypot( K1[ 0 ] - K0[ 0 ], K1[ 1 ] - K0[ 1 ] ), kyaw = Math.atan2( - ( K1[ 1 ] - K0[ 1 ] ), K1[ 0 ] - K0[ 0 ] );
				for ( let k = 0, n = Math.ceil( KL / 1.1 ); k < n; k ++ ) {

					const f = ( k + 0.5 ) / n, x = K0[ 0 ] + ( K1[ 0 ] - K0[ 0 ] ) * f, z = K0[ 1 ] + ( K1[ 1 ] - K0[ 1 ] ) * f;
					const top = T.heightAt( x, z ) + 0.05, bottom = top - 0.4, t = 0.7 + ( k % 2 ) * 0.04;
					kit.color = [ t, t - 0.01, t - 0.05 ];
					kit.box( x, ( top + bottom ) / 2, z, KL / n - 0.02, top - bottom, 0.3, kyaw );

				}

			}

		}

		// a low wall of grey rubble round its open sides, from the tower's west corner down the lane and across the
		// tip: its face to the Largo; along the lane its top the lane's own level, across the tip a hand over the
		// street and climbing with it (the drawing); the stone bollards stand on it, the chain swagged between them
		const WP = [ FP[ 0 ], FP[ 3 ], FP[ 2 ] ];
		let cx = 0, cz = 0;
		for ( const [ x, z ] of FP ) {

			cx += x / FP.length; cz += z / FP.length;

		}

		kit.vdata = [ 0.43, 0.6, 0, 0 ];
		kit.color = [ 0.6, 0.6, 0.58 ]; // (grey rubble)
		// its top: at each corner a hand or two over the higher of the Largo's floor and the street outside; one
		// straight slope from corner to corner (low at the tip's corner on the Calçada, climbing to the lane)
		const outN = ( a, b ) => {

			const l = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
			let no = [ ( b[ 1 ] - a[ 1 ] ) / l, - ( b[ 0 ] - a[ 0 ] ) / l ];
			if ( ( ( a[ 0 ] + b[ 0 ] ) / 2 - cx ) * no[ 0 ] + ( ( a[ 1 ] + b[ 1 ] ) / 2 - cz ) * no[ 1 ] < 0 ) no = [ - no[ 0 ], - no[ 1 ] ];
			return no;

		};
		const nLaneSide = outN( WP[ 0 ], WP[ 1 ] ), nFront = outN( WP[ 1 ], WP[ 2 ] );
		const cornerTop = ( P, ns ) => {

			let y = T.heightAt( P[ 0 ] - ( ns[ 0 ][ 0 ] + ns[ ns.length - 1 ][ 0 ] ) * 0.6, P[ 1 ] - ( ns[ 0 ][ 1 ] + ns[ ns.length - 1 ][ 1 ] ) * 0.6 );
			for ( const n of ns ) y = Math.max( y, T.heightAt( P[ 0 ] + n[ 0 ] * 1.5, P[ 1 ] + n[ 1 ] * 1.5 ) );
			return y + 0.22;

		};
		// (along the lane its top is the lane's own level, the lane running on over it to its edge: photo -1506-)
		const LY = this.terrain.santaMariaSteps.laneY;
		const tops3 = [ LY( ...WP[ 0 ] ) + 0.03, Math.max( LY( ...WP[ 1 ] ), cornerTop( WP[ 1 ], [ nFront ] ) - 0.1 ) + 0.03, cornerTop( WP[ 2 ], [ nFront ] ) ];
		tops3[ 2 ] = Math.min( tops3[ 2 ], tops3[ 1 ] - 0.15 ); // (the tip's Calçada corner the lowest)
		const wallPts = []; // [ x, z, top ] along it, for the bollards
		for ( let sgi = 0; sgi + 1 < WP.length; sgi ++ ) {

			const A0 = WP[ sgi ], A1 = WP[ sgi + 1 ], no = sgi === 0 ? nLaneSide : nFront, TH = 0.36;
			const yt0 = tops3[ sgi ], yt1 = tops3[ sgi + 1 ];
			const g0 = Math.min( T.heightAt( ...A0 ), T.heightAt( A0[ 0 ] + no[ 0 ] * 1.2, A0[ 1 ] + no[ 1 ] * 1.2 ) ) - 0.4;
			const g1 = Math.min( T.heightAt( ...A1 ), T.heightAt( A1[ 0 ] + no[ 0 ] * 1.2, A1[ 1 ] + no[ 1 ] * 1.2 ) ) - 0.4;
			const p = ( Q, k, y ) => [ Q[ 0 ] + no[ 0 ] * k, y, Q[ 1 ] + no[ 1 ] * k ];
			// a prism along the edge, its top one straight slope: the Largo's face, the street's, the top, the ends
			kit.quadFacing( p( A0, 0, g0 ), p( A1, 0, g1 ), p( A1, 0, yt1 ), p( A0, 0, yt0 ), [ - no[ 0 ], 0, - no[ 1 ] ] );
			kit.quadFacing( p( A0, TH, g0 ), p( A1, TH, g1 ), p( A1, TH, yt1 ), p( A0, TH, yt0 ), [ no[ 0 ], 0, no[ 1 ] ] );
			kit.quadFacing( p( A0, 0, yt0 ), p( A1, 0, yt1 ), p( A1, TH, yt1 ), p( A0, TH, yt0 ), [ 0, 1, 0 ] );
			for ( const [ Q, g, yt, sg ] of [ [ A0, g0, yt0, - 1 ], [ A1, g1, yt1, 1 ] ] ) {

				const du = [ ( A1[ 0 ] - A0[ 0 ] ) * sg, 0, ( A1[ 1 ] - A0[ 1 ] ) * sg ];
				kit.quadFacing( p( Q, 0, g ), p( Q, TH, g ), p( Q, TH, yt ), p( Q, 0, yt ), du );

			}

			const SL = Math.hypot( A1[ 0 ] - A0[ 0 ], A1[ 1 ] - A0[ 1 ] ), wyaw = Math.atan2( - ( A1[ 1 ] - A0[ 1 ] ), A1[ 0 ] - A0[ 0 ] );
			for ( let k = 0, n = Math.ceil( SL / 0.6 ); k < n; k ++ ) {

				const f = ( k + 0.5 ) / n, M = [ A0[ 0 ] + ( A1[ 0 ] - A0[ 0 ] ) * f + no[ 0 ] * TH / 2, A0[ 1 ] + ( A1[ 1 ] - A0[ 1 ] ) * f + no[ 1 ] * TH / 2 ];
				const top = yt0 + ( yt1 - yt0 ) * f, bottom = g0 + ( g1 - g0 ) * f;
				this.colliders.addBox( new Vector3( M[ 0 ], ( top + bottom ) / 2, M[ 1 ] ), new Vector3( SL / n / 2, ( top - bottom ) / 2, TH / 2 ), wyaw, { walkable: true, tag: 'stair' } );
				wallPts.push( [ M[ 0 ], M[ 1 ], top ] );

			}

		}

		// along the lane's side of the wall, the lane's own setts carried right to it at its level (the Largo's
		// floor runs on under the wall, lower: this covers the step), in short lengths climbing with it
		{

			const S2 = this.terrain.santaMariaSteps, A0 = WP[ 0 ], A1 = WP[ 1 ], SL = Math.hypot( A1[ 0 ] - A0[ 0 ], A1[ 1 ] - A0[ 1 ] );
			const du = [ ( A1[ 0 ] - A0[ 0 ] ) / SL, ( A1[ 1 ] - A0[ 1 ] ) / SL ], no = nLaneSide, APRON = 1.85, ayaw = Math.atan2( - du[ 1 ], du[ 0 ] );
			kit.vdata = [ 0.37, 0.4, 0, 1 ];
			kit.color = [ 0.9, 0.88, 0.84 ];
			const fA = - 1.4 / SL; // (on a little past the tower's corner, where the step still is)
			for ( let k = 0, n = Math.ceil( ( SL + 1.4 ) / 0.5 ); k < n; k ++ ) {

				const f = fA + ( 1 - fA ) * ( k + 0.5 ) / n, M = [ A0[ 0 ] + ( A1[ 0 ] - A0[ 0 ] ) * f + no[ 0 ] * ( 0.36 + APRON / 2 ), A0[ 1 ] + ( A1[ 1 ] - A0[ 1 ] ) * f + no[ 1 ] * ( 0.36 + APRON / 2 ) ];
				const top = S2.laneY( M[ 0 ], M[ 1 ] ) + 0.02, bottom = Math.min( top, T.heightAt( A0[ 0 ] + ( A1[ 0 ] - A0[ 0 ] ) * f, A0[ 1 ] + ( A1[ 1 ] - A0[ 1 ] ) * f ) ) - 0.4;
				// (its surface one even slope: a quad from this length's start to its end, each corner at the lane's
				// level there; the collider under it in short level lengths)
				const f0 = fA + ( 1 - fA ) * k / n, f1 = fA + ( 1 - fA ) * ( k + 1 ) / n;
				const cnr = ( ff, kk ) => {

					const X = A0[ 0 ] + ( A1[ 0 ] - A0[ 0 ] ) * ff + no[ 0 ] * kk, Z = A0[ 1 ] + ( A1[ 1 ] - A0[ 1 ] ) * ff + no[ 1 ] * kk;
					return [ X, S2.laneY( X, Z ) + 0.02, Z ];

				};
				const q = [ cnr( f0, 0.3 ), cnr( f1, 0.3 ), cnr( f1, 0.36 + APRON ), cnr( f0, 0.36 + APRON ) ];
				kit.quadFacing( ...q, [ 0, 1, 0 ], q.map( ( v ) => [ v[ 0 ], v[ 2 ] ] ) );
				this.colliders.addBox( new Vector3( M[ 0 ], ( top + bottom ) / 2, M[ 1 ] ), new Vector3( ( SL + 1.4 ) / n / 2, ( top - bottom ) / 2, APRON / 2 ), ayaw, { walkable: true, tag: 'stair' } );

			}

		}

		// the bollards: near the tower, halfway down the lane, at the tip's two corners
		const tops = [];
		const along = ( f ) => wallPts[ Math.min( wallPts.length - 1, Math.max( 0, Math.round( f * ( wallPts.length - 1 ) ) ) ) ];
		const nLane = Math.ceil( Math.hypot( FP[ 3 ][ 0 ] - FP[ 0 ][ 0 ], FP[ 3 ][ 1 ] - FP[ 0 ][ 1 ] ) / 0.6 );
		for ( const q of [ wallPts[ 1 ], wallPts[ Math.round( nLane * 0.55 ) ], wallPts[ nLane - 1 ], along( 1 ) ] ) {

			const [ x, z, gq ] = q;
			kit.vdata = [ 0.43, 0.6, 0, 0 ];
			kit.color = [ 0.7, 0.67, 0.6 ];
			for ( const r of [ 0, Math.PI / 4 ] ) kit.box( x, gq + 0.4, z, 0.32, 0.86, 0.32, yaw + r ); // (octagonal)
			kit.box( x, gq + 0.87, z, 0.24, 0.1, 0.24, yaw );
			kit.box( x, gq + 0.94, z, 0.14, 0.05, 0.14, yaw + Math.PI / 4 );
			tops.push( [ x, gq + 0.7, z ] );
			this.colliders.addBox( new Vector3( x, gq + 0.45, z ), new Vector3( 0.17, 0.5, 0.17 ), yaw, { walkable: false, tag: 'wall' } );

		}

		kit.vdata = [ 0.29, 0.2, 0, 0 ];
		kit.color = [ 0.12, 0.07, 0.05 ];
		for ( let i = 0; i + 1 < tops.length; i ++ ) {

			// each swag in short links, sagging
			const a = tops[ i ], b = tops[ i + 1 ], n = 12, sag = Math.min( 0.45, 0.12 * Math.hypot( b[ 0 ] - a[ 0 ], b[ 2 ] - a[ 2 ] ) );
			let prev = a;
			for ( let k = 1; k <= n; k ++ ) {

				const f = k / n, Q = [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * f, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * f - sag * Math.sin( Math.PI * f ), a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * f ];
				ironBar( kit, prev, Q, 0.035 );
				prev = Q;

			}

		}

		const uD = 2.87, gd = P( uD, 0, 0.6 ), g = T.heightAt( gd[ 0 ], gd[ 2 ] ) + 0.03; // (the doorway from the Largo's floor)
		kit.vdata = [ 0.43, 0.5, 0, 0 ];
		kit.color = [ 0.95, 0.88, 0.74 ];
		frame( uD, g, g + 1.5, 1.3, 1.1, 0.26 ); // (an equilateral arch: its two arcs from the opposite springings)
		box( kit, uD, g + 0.06, 1.9, 0.12, 0.12, 0.24 ); // the threshold
		wood.vdata = [ 0, 0, 0.53, 5 ];
		wood.color = lin( [ 0.16, 0.1, 0.07 ] );
		fill( wood, uD, g, g + 1.5, 1.3, 1.1, 0.02 );
		wood.color = lin( [ 0.08, 0.05, 0.035 ] );
		box( wood, uD, g + 1.2, 0.04, 2.3, 0.035, 0.03 ); // the doors' meeting

		// the tall pointed window, to the left of the door and over it: a moulded frame (two rings), leaded panes
		const uW = 3.6, yW0 = g + 3.45, yWs = g + 4.55, wW = 0.95, haW = 0.82;
		kit.color = [ 0.9, 0.84, 0.72 ];
		frame( uW, yW0, yWs, wW, haW, 0.14, 0.05 );
		kit.color = [ 0.82, 0.77, 0.66 ];
		frame( uW, yW0 - 0.04, yWs, wW + 0.28, haW + 0.14, 0.12, 0.08 );
		box( kit, uW, yW0 - 0.1, wW + 0.7, 0.14, 0.09, 0.18 ); // the sill
		const glass = new MeshKit();
		glass.vdata = [ 0, 0, 0.53, 4 ];
		glass.color = lin( [ 0.1, 0.12, 0.13 ] );
		fill( glass, uW, yW0, yWs, wW, haW, 0.015 );
		kit.color = [ 0.25, 0.25, 0.25 ];
		for ( let y = yW0 + 0.27; y < yWs + haW - 0.15; y += 0.27 ) box( kit, uW, y, wW * ( y < yWs ? 1 : Math.max( 0.15, 1 - ( y - yWs ) / haW ) ), 0.02, 0.025, 0.01 );
		for ( const du of [ - wW / 4, 0, wW / 4 ] ) box( kit, uW + du, ( yW0 + yWs + haW * 0.6 ) / 2, 0.02, yWs + haW * 0.6 - yW0, 0.025, 0.01 );

		// high up to the right: a small round-headed window, set in, onto a wooden balcony
		const uS = 1.85, yS0 = g + 6.05, wS = 0.72, ySs = yS0 + 1.05;
		kit.color = [ 0.92, 0.86, 0.73 ];
		frame( uS, yS0, ySs, wS + 0.3, wS / 2 + 0.15, 0.14, 0.04 );
		glass.color = lin( [ 0.13, 0.12, 0.12 ] );
		fill( glass, uS, yS0, ySs, wS, wS / 2, 0.01 );
		wood.color = lin( [ 0.1, 0.07, 0.05 ] );
		for ( const sd of [ - 1, 1 ] ) box( wood, uS + sd * ( wS / 2 + 0.06 ), ( yS0 + ySs ) / 2, 0.08, ySs - yS0, 0.04, 0.05 ); // its shutters, folded back
		const bW = 1.9, bD = 0.72, yB = yS0 - 0.05;
		box( wood, uS, yB - 0.04, bW, 0.08, bD / 2, bD ); // the floor
		for ( const du of [ - 0.75, 0, 0.75 ] ) box( wood, uS + du, yB - 0.42, 0.08, 0.76, bD * 0.4, bD * 0.8 ); // the brackets
		box( wood, uS, yB + 0.85, bW, 0.06, bD - 0.03, 0.06 ); // the rail, front
		for ( const sd of [ - 1, 1 ] ) box( wood, uS + sd * ( bW / 2 - 0.03 ), yB + 0.85, 0.06, 0.06, bD / 2, bD ); // and sides
		for ( let du = - bW / 2 + 0.03; du <= bW / 2; du += bW / 8 ) box( wood, uS + du, yB + 0.43, 0.05, 0.84, bD - 0.03, 0.05 );
		for ( const sd of [ - 1, 1 ] ) for ( const dk of [ 0.25, 0.5 ] ) box( wood, uS + sd * ( bW / 2 - 0.03 ), yB + 0.43, 0.05, 0.84, dk, 0.05 );
		// a little green in pots at its corners
		wood.vdata = [ 0, 0, 0.53, 4 ];
		const rp = mulberry32( 131 );
		for ( const sd of [ - 1, 1 ] ) for ( let i = 0; i < 30; i ++ ) {

			wood.color = lin( [ 0.15 + rp() * 0.08, 0.34 + rp() * 0.1, 0.1 ] );
			box( wood, uS + sd * ( bW / 2 - 0.15 ) + ( rp() - 0.5 ) * 0.3, yB + 0.08 + rp() * 0.25, 0.06, 0.05, bD - 0.1 - rp() * 0.15, 0.06 );

		}

		for ( const [ K, mat, name ] of [ [ wood, materials.plaster, 'torre-largo-wood' ], [ glass, materials.plaster, 'torre-largo-glass' ] ] ) {

			const mesh = new Mesh( K.build(), mat );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

	}

	// The small square just inside Porta da Vila, between Rua Direita and the lane going down on the right
	// (0.6 m over the street; TerrainData leaves the ground under it): a level stone floor, two high
	// steps up from Rua Direita, a low parapet
	// round its front and its east side, which stands as a tall wall over the lane, and a small round
	// column of pale stone in the middle.
	_praceta() {

		const pr = this.terrain.praceta;
		if ( ! pr ) return;
		const T = this.terrain, kit = this.kit, { poly, y } = pr;
		const STEPS = [ 3, 4 ], WALLS = [ 1, 2 ]; // which edges (from poly[ i ] to poly[ i + 1 ]); 0 is the house's
		// a band along edge i from d0 to d1 out of the square (negative: in), in metre pieces
		const band = ( i, d0, d1, top, bottomOf, opts ) => {

			const a = poly[ i ], b = poly[ i + 1 ];
			const len = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ), n = Math.max( 1, Math.round( len ) );
			let ox = - ( b[ 1 ] - a[ 1 ] ) / len, oz = ( b[ 0 ] - a[ 0 ] ) / len;
			const mx = ( a[ 0 ] + b[ 0 ] ) / 2, mz = ( a[ 1 ] + b[ 1 ] ) / 2;
			if ( pointInPolygon( mx + ox * 0.5, mz + oz * 0.5, poly ) ) {

				ox = - ox;
				oz = - oz;

			}

			const yaw = Math.atan2( - ( b[ 1 ] - a[ 1 ] ), b[ 0 ] - a[ 0 ] ), dm = ( d0 + d1 ) / 2;
			for ( let k = 0; k < n; k ++ ) {

				const t = ( k + 0.5 ) / n;
				const x = a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t + ox * dm, z = a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t + oz * dm;
				const bottom = bottomOf( x + ox * ( d1 - dm ), z + oz * ( d1 - dm ) );
				kit.box( x, ( top + bottom ) / 2, z, len / n + 0.02, top - bottom, d1 - d0, yaw );
				this.colliders.addBox( new Vector3( x, ( top + bottom ) / 2, z ), new Vector3( len / n / 2 + 0.01, ( top - bottom ) / 2, ( d1 - d0 ) / 2 ), yaw, opts );

			}

		};
		const below = ( x, z ) => Math.min( y, T.heightAt( x, z ) ) - 0.6;
		kit.vdata = [ 0.43, 0.5, 0, 0 ];
		kit.color = [ 0.95, 0.9, 0.8 ]; // worn limestone
		for ( const i of STEPS ) {

			band( i, 0, 0.5, y - 0.3, below, { walkable: true, tag: 'stair' } );
			band( i, - 0.4, 0, y, below, { walkable: true, tag: 'stair' } ); // the floor's edge

		}

		// the floor: a level paving of stone over the whole square (the ground under it is left as it was),
		// walked on as strips a metre deep across it
		const ring = poly.slice( 0, - 1 );
		let fx = 0, fz = 0;
		for ( const q of ring ) {

			fx += q[ 0 ] / ring.length;
			fz += q[ 1 ] / ring.length;

		}

		kit.color = [ 0.92, 0.88, 0.8 ];
		kit.vdata = [ 0.71, 0.3, 0, 0 ];
		ring.forEach( ( q, i ) => {

			const r = ring[ ( i + 1 ) % ring.length ];
			kit.quadFacing( [ fx, y, fz ], [ q[ 0 ], y, q[ 1 ] ], [ r[ 0 ], y, r[ 1 ] ], [ r[ 0 ], y, r[ 1 ] ], [ 0, 1, 0 ],
				[ [ fx, fz ], [ q[ 0 ], q[ 1 ] ], [ r[ 0 ], r[ 1 ] ], [ r[ 0 ], r[ 1 ] ] ] );

		} );
		const zs = ring.map( ( q ) => q[ 1 ] );
		for ( let z = Math.min( ...zs ); z < Math.max( ...zs ); z += 1 ) {

			// the square's width across this strip
			let x0 = Infinity, x1 = - Infinity;
			for ( const zz of [ z, Math.min( z + 1, Math.max( ...zs ) ) ] ) ring.forEach( ( q, i ) => {

				const r = ring[ ( i + 1 ) % ring.length ];
				if ( ( q[ 1 ] - zz ) * ( r[ 1 ] - zz ) > 0 || q[ 1 ] === r[ 1 ] ) return;
				const x = q[ 0 ] + ( r[ 0 ] - q[ 0 ] ) * ( zz - q[ 1 ] ) / ( r[ 1 ] - q[ 1 ] );
				x0 = Math.min( x0, x );
				x1 = Math.max( x1, x );

			} );
			if ( x1 > x0 ) this.colliders.addBox( new Vector3( ( x0 + x1 ) / 2, y - 0.2, z + 0.5 ), new Vector3( ( x1 - x0 ) / 2, 0.2, 0.5 ), 0, { walkable: true, tag: 'praceta' } );

		}

		kit.color = [ 1.02, 0.86, 0.62 ];
		kit.vdata = [ 0.47, 0.6, 0, 0 ];
		for ( const i of WALLS ) band( i, - 0.15, 0.75, y + 0.6, below, { walkable: false, tag: 'wall' } );
		// the corner where the two walls meet, rounded on the outside: a quarter round about their inner corner
		{

			const out = ( i ) => {

				const a = poly[ i ], b = poly[ i + 1 ], len = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
				const o = [ - ( b[ 1 ] - a[ 1 ] ) / len, ( b[ 0 ] - a[ 0 ] ) / len ];
				return pointInPolygon( ( a[ 0 ] + b[ 0 ] ) / 2 + o[ 0 ] * 0.5, ( a[ 1 ] + b[ 1 ] ) / 2 + o[ 1 ] * 0.5, poly ) ? [ - o[ 0 ], - o[ 1 ] ] : o;

			};
			const [ i1, i2 ] = WALLS, v = poly[ i2 ], n1 = out( i1 ), n2 = out( i2 );
			const c = [ v[ 0 ] - 0.15 * ( n1[ 0 ] + n2[ 0 ] ), v[ 1 ] - 0.15 * ( n1[ 1 ] + n2[ 1 ] ) ], R = 0.9, N = 8;
			const a1 = Math.atan2( n1[ 1 ], n1[ 0 ] );
			let da = Math.atan2( n2[ 1 ], n2[ 0 ] ) - a1;
			da = Math.atan2( Math.sin( da ), Math.cos( da ) );
			const top = y + 0.6, bottom = below( v[ 0 ] + ( n1[ 0 ] + n2[ 0 ] ) * 0.5, v[ 1 ] + ( n1[ 1 ] + n2[ 1 ] ) * 0.5 );
			for ( let k = 0; k < N; k ++ ) {

				const t0 = a1 + da * k / N, t1 = a1 + da * ( k + 1 ) / N, tm = ( t0 + t1 ) / 2;
				const p0 = [ c[ 0 ] + Math.cos( t0 ) * R, c[ 1 ] + Math.sin( t0 ) * R ], p1 = [ c[ 0 ] + Math.cos( t1 ) * R, c[ 1 ] + Math.sin( t1 ) * R ];
				kit.quadFacing( [ p0[ 0 ], bottom, p0[ 1 ] ], [ p1[ 0 ], bottom, p1[ 1 ] ], [ p1[ 0 ], top, p1[ 1 ] ], [ p0[ 0 ], top, p0[ 1 ] ], [ Math.cos( tm ), 0, Math.sin( tm ) ],
					[ [ t0 * R, bottom ], [ t1 * R, bottom ], [ t1 * R, top ], [ t0 * R, top ] ] );
				kit.quadFacing( [ c[ 0 ], top, c[ 1 ] ], [ p0[ 0 ], top, p0[ 1 ] ], [ p1[ 0 ], top, p1[ 1 ] ], [ p1[ 0 ], top, p1[ 1 ] ], [ 0, 1, 0 ] );

			}

			const m = [ c[ 0 ] + Math.cos( a1 + da / 2 ) * R * 0.5, c[ 1 ] + Math.sin( a1 + da / 2 ) * R * 0.5 ];
			this.colliders.addBox( new Vector3( m[ 0 ], ( top + bottom ) / 2, m[ 1 ] ), new Vector3( R * 0.5, ( top - bottom ) / 2, R * 0.5 ), - ( a1 + da / 2 ), { walkable: false, tag: 'wall' } );

		}

		// the column: a square base in two courses, a round shaft, a moulded cap
		let cx = 0, cz = 0;
		for ( const q of poly.slice( 0, - 1 ) ) {

			cx += q[ 0 ] / ( poly.length - 1 );
			cz += q[ 1 ] / ( poly.length - 1 );

		}

		kit.color = [ 1.05, 1.02, 0.94 ];
		kit.vdata = [ 0.53, 0.2, 0, 0 ];
		kit.box( cx, y + 0.12, cz, 1.4, 0.24, 1.4, 0 );
		kit.box( cx, y + 0.34, cz, 1.0, 0.2, 1.0, 0 );
		const round = ( r, y0, y1, N = 16 ) => {

			for ( let k = 0; k < N; k ++ ) {

				const a0 = k / N * Math.PI * 2, a1 = ( k + 1 ) / N * Math.PI * 2, am = ( a0 + a1 ) / 2;
				const p0 = [ cx + Math.cos( a0 ) * r, cz + Math.sin( a0 ) * r ], p1 = [ cx + Math.cos( a1 ) * r, cz + Math.sin( a1 ) * r ];
				kit.quadFacing( [ p0[ 0 ], y0, p0[ 1 ] ], [ p1[ 0 ], y0, p1[ 1 ] ], [ p1[ 0 ], y1, p1[ 1 ] ], [ p0[ 0 ], y1, p0[ 1 ] ], [ Math.cos( am ), 0, Math.sin( am ) ],
					[ [ a0 * r, y0 ], [ a1 * r, y0 ], [ a1 * r, y1 ], [ a0 * r, y1 ] ] );
				kit.quadFacing( [ cx, y1, cz ], [ p0[ 0 ], y1, p0[ 1 ] ], [ p1[ 0 ], y1, p1[ 1 ] ], [ p1[ 0 ], y1, p1[ 1 ] ], [ 0, 1, 0 ] );

			}

		};
		round( 0.32, y + 0.44, y + 1.8 );
		round( 0.42, y + 1.8, y + 1.95 );
		round( 0.3, y + 1.95, y + 2.1 );
		this.colliders.addBox( new Vector3( cx, y + 1.05, cz ), new Vector3( 0.7, 1.05, 0.7 ), 0, { walkable: false, tag: 'column' } );

	}

	// a thin square bar from p to q (iron work), half thickness r
	_bar( p, q, r ) {

		const dx = q[ 0 ] - p[ 0 ], dz = q[ 2 ] - p[ 2 ], L = Math.hypot( dx, dz ) || 1;
		const sx = - dz / L, sz = dx / L; // across, level
		const c = ( o, s, u ) => [ o[ 0 ] + sx * r * s, o[ 1 ] + r * u, o[ 2 ] + sz * r * s ];
		for ( const [ s0, u0, s1, u1, n ] of [ [ - 1, 1, 1, 1, [ 0, 1, 0 ] ], [ 1, - 1, - 1, - 1, [ 0, - 1, 0 ] ], [ 1, 1, 1, - 1, [ sx, 0, sz ] ], [ - 1, - 1, - 1, 1, [ - sx, 0, - sz ] ] ] ) {

			this.kit.quadFacing( c( p, s0, u0 ), c( q, s0, u0 ), c( q, s1, u1 ), c( p, s1, u1 ), n );

		}

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
	_wallLine( profile, gates, seed, { parapetBoth = false, sharp = null, adjust = null, exact = null, town = null, lowOuter = false, bare = null, capStart = true, ramp = null, corners = null } = {} ) {

		const P = profile.pts;
		if ( P.length < 2 ) return null;
		// resample positions at PIECE; interpolate top and normal from the 2 m profile by arc length
		// (the profile's 2 m points cut corners; `exact`, the wall's own polyline, keeps them, each side
		// resampled on its own)
		const line = exact ? exact.slice( 0, - 1 ).flatMap( ( a, i ) => {

			const b = exact[ i + 1 ], k = Math.max( 1, Math.round( Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) / PIECE ) );
			return Array.from( { length: k + ( i === exact.length - 2 ? 1 : 0 ) }, ( _, j ) => [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * j / k, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * j / k ] );

		} ) : resample( P.map( ( p ) => [ p.x, p.z ] ), PIECE );
		// corners ([[ x, z ]]): the nearest positions moved onto them, so the line turns right there
		if ( corners ) for ( const c of corners ) {

			let b = 0;
			for ( let i = 1; i < line.length; i ++ ) if ( Math.hypot( line[ i ][ 0 ] - c[ 0 ], line[ i ][ 1 ] - c[ 1 ] ) < Math.hypot( line[ b ][ 0 ] - c[ 0 ], line[ b ][ 1 ] - c[ 1 ] ) ) b = i;
			line[ b ] = c.slice();

		}
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
		// in the boxes `sharp` ([[ x0, z0, x1, z1 ]]), normals square to the line itself, so corners are mitred
		if ( sharp ) samples.forEach( ( p, i ) => {

			if ( ! sharp.some( ( b ) => p.x >= b[ 0 ] && p.x <= b[ 2 ] && p.z >= b[ 1 ] && p.z <= b[ 3 ] ) ) return;
			const a = samples[ Math.max( 0, i - 1 ) ], b = samples[ Math.min( n - 1, i + 1 ) ];
			const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot( dx, dz ) || 1;
			const f = - dz * p.nx + dx * p.nz >= 0 ? 1 : - 1;
			// a corner: the line turns here (no merlon on it, it would stand askew)
			const ux = p.x - a.x, uz = p.z - a.z, vx = b.x - p.x, vz = b.z - p.z;
			p.corner = ( ux * vx + uz * vz ) < 0.9 * Math.hypot( ux, uz ) * Math.hypot( vx, vz );
			p.nx = - dz / L * f;
			p.nz = dx / L * f;
			p.tx = - p.nz * profile.outward;
			p.tz = p.nx * profile.outward;

		} );
		// no other town-side merlons within a merlon's width of a sharp corner (its post has one)
		if ( sharp ) samples.forEach( ( p, i ) => {

			if ( p.corner ) for ( let k = Math.max( 0, i - 2 ); k <= Math.min( n - 1, i + 2 ); k ++ ) samples[ k ].nearCorner = true;

		} );
		// level treads
		if ( adjust ) adjust( samples ); // a caller's last word on the tops
		for ( const p of samples ) p.y = Math.round( p.top / STEP_RISE ) * STEP_RISE;
		// ramp( p ): a sloping walk here instead of treads, its parapets sloping with it; each piece's ends
		// meet its neighbours' (a tread's own height where a ramp meets one)
		if ( ramp ) for ( const p of samples ) if ( ( p.ramp = ramp( p ) ) ) p.y = p.top;
		const endY = ( k ) => {

			const a = samples[ Math.max( 0, k - 1 ) ], b = samples[ Math.min( n - 1, k ) ];
			return a.ramp && b.ramp ? ( a.y + b.y ) / 2 : a.ramp ? b.y : a.y;

		};
		// cross-sections at the piece boundaries (mid-points between samples)
		// (near a sharp corner an offset point that would cross the corner's bisector is held at the mitre
		// point instead, so the pieces on the inside of the turn don't fold over each other)
		const off = ( p, d ) => {

			const q = [ p.x + p.nx * d, p.z + p.nz * d ], c = p.mitre;
			if ( ! c ) return q;
			const side = ( x, z ) => ( x - c.x ) * - c.bz + ( z - c.z ) * c.bx;
			return Math.sign( side( q[ 0 ], q[ 1 ] ) ) === Math.sign( side( p.x, p.z ) ) ? q : [ c.x + c.bx * d / c.cos, c.z + c.bz * d / c.cos ];

		};
		const edge = [];
		for ( let k = 0; k <= n; k ++ ) {

			const a = samples[ Math.max( 0, k - 1 ) ], b = samples[ Math.min( n - 1, k ) ];
			const m = { x: ( a.x + b.x ) / 2, z: ( a.z + b.z ) / 2, nx: ( a.nx + b.nx ) / 2, nz: ( a.nz + b.nz ) / 2 };
			const l = Math.hypot( m.nx, m.nz ) || 1;
			m.nx /= l; m.nz /= l;
			edge.push( m );

		}

		samples.forEach( ( p, i ) => {

			if ( ! p.corner || i < 1 || i > n - 2 ) return;
			const a = samples[ i - 1 ], b = samples[ i + 1 ];
			let bx = a.nx + b.nx, bz = a.nz + b.nz;
			const l = Math.hypot( bx, bz ) || 1;
			bx /= l; bz /= l;
			const c = { x: p.x, z: p.z, bx, bz, cos: Math.max( 0.3, bx * a.nx + bz * a.nz ) };
			for ( let k = Math.max( 0, i - 3 ); k <= Math.min( n, i + 4 ); k ++ ) edge[ k ].mitre = c;
			// the legs run right into the corner and meet there on its mitre, so it comes to a point: the
			// turning piece shrinks to nothing (off() puts the corner's offsets on the mitre)
			if ( ! p.gate ) edge[ i ] = edge[ i + 1 ] = { x: p.x, z: p.z, nx: bx, nz: bz, mitre: c };

		} );

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

		// fit: the arch centred on the opening the pieces leave (their edges needn't fall evenly about the
		// gate's point), its radius half the opening (or opening, if narrower: span is the gap's half)
		const span = new Map();
		for ( let i = 0; i < n; i ++ ) {

			const g = samples[ i ].gate, p = samples[ i ];
			if ( ! g || ! g.fit ) continue;
			const sp = span.get( g ) || { lo: Infinity, hi: - Infinity, tx: p.tx, tz: p.tz };
			for ( const e of [ edge[ i ], edge[ i + 1 ] ] ) {

				const a = ( e.x - g.x ) * sp.tx + ( e.z - g.z ) * sp.tz;
				sp.lo = Math.min( sp.lo, a ); sp.hi = Math.max( sp.hi, a );

			}

			span.set( g, sp );

		}

		for ( const [ g, sp ] of span ) {

			const mid = ( sp.lo + sp.hi ) / 2;
			g.x += sp.tx * mid; g.z += sp.tz * mid;
			g.span = ( sp.hi - sp.lo ) / 2;
			arcR.set( g, Math.min( g.span, g.opening ?? Infinity ) );

		}

		for ( const [ g, R ] of arcR ) g.R = R;
		const archY = ( g, p, x, z ) => {

			const R = arcR.get( g ), a = ( x - g.x ) * p.tx + ( z - g.z ) * p.tz;
			const spring = g.y + ( g.spring ?? Math.max( 2.4, 4.2 - R ) );
			// flat: a basket arch, rising only that much over its springing
			if ( g.flat ) return spring + g.flat * Math.sqrt( Math.max( 0, 1 - ( a / R ) ** 2 ) );
			// pointed: two arcs of radius R * pointed, each struck from beyond the opposite jamb
			if ( g.pointed ) {

				const rr = R * g.pointed, e = Math.abs( a ) + rr - R;
				return spring + Math.sqrt( Math.max( 0, rr * rr - e * e ) );

			}

			return spring + Math.sqrt( Math.max( 0, R * R - a * a ) );

		};
		// gate.inner { R, spring, depth }: on the town side, for depth from the inner face, the passage is a
		// taller round-arched recess (Porta Este: photo references/...-portaeste3)
		const innerY = ( g, p, x, z ) => {

			const a = ( x - g.x ) * p.tx + ( z - g.z ) * p.tz, I = g.inner, R = I.R ?? g.span ?? arcR.get( g );
			return g.y + I.spring + Math.sqrt( Math.max( 0, R * R - a * a ) );

		};

		const T = this.terrain;
		const kit = this.kit;
		const ground = ( xz ) => T.heightAt( xz[ 0 ], xz[ 1 ] );
		const inner = - W / 2, outer = W / 2;
		kit.vdata = [ seed, 0.8, 0, 0 ];
		let u = 0;
		for ( let i = 0; i < n; i ++ ) {

			const p = samples[ i ];
			// the town side: open, or a parapet too ('high', with merlons; 'void', with low merlons, round
			// Porta da Vila's void; 'low', a plain guard wall). lowOuter: the outer merlons are low ones
			// (not on a sharp corner's turning piece: a square post closes the corner there, after the loop)
			const ts = p.corner && sharp ? null : parapetBoth ? 'high' : town ? town( p ) : null;
			const pIn = ts ? - PARAPET_IN : inner;
			// bare( p ): no parapet on the outer side here either (where another walk runs on from it)
			const open = bare ? bare( p ) : false, PO = open ? outer : PARAPET_IN;
			const A = edge[ i ], B = edge[ i + 1 ];
			const y = p.y, yA = p.ramp ? endY( i ) : y, yB = p.ramp ? endY( i + 1 ) : y;
			const len = Math.hypot( B.x - A.x, B.z - A.z );
			if ( len < 1e-3 ) continue;
			const up = [ 0, 1, 0 ];
			const outN = [ p.nx, 0, p.nz ], inN = [ - p.nx, 0, - p.nz ];
			const IA = off( A, inner ), IB = off( B, inner ), PA = off( A, PARAPET_IN ), PB = off( B, PARAPET_IN );
			const OA = off( A, outer ), OB = off( B, outer );
			const gate = p.gate;
			if ( gate && ! gate.frame ) gate.frame = { tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz };
			// soffit of the passage, sampled in slices across the piece so the arch reads as a curve
			const SUB = 4;
			const arch = gate ? Array.from( { length: SUB + 1 }, ( _, k ) => {

				const t = k / SUB, m = { x: A.x + ( B.x - A.x ) * t, z: A.z + ( B.z - A.z ) * t, nx: A.nx + ( B.nx - A.nx ) * t, nz: A.nz + ( B.nz - A.nz ) * t };
				return { t, m, y: archY( gate, p, m.x, m.z ), yi: gate.inner ? innerY( gate, p, m.x, m.z ) : archY( gate, p, m.x, m.z ) };

			} ) : null;
			const split = gate && gate.inner ? inner + gate.inner.depth : null; // the recess's back, from the wall line
			const yg = gate ? Math.min( arch[ 0 ].y, arch[ SUB ].y ) : null;
			// a face from the arch up to yTop, at offset d from the wall line
			// (key: 'y' the arch, 'yi' the inner recess's)
			const archFace = ( d, yTop, N, u0, key = 'y' ) => {

				for ( let k = 0; k < SUB; k ++ ) {

					const a = arch[ k ], b = arch[ k + 1 ], qa = off( a.m, d ), qb = off( b.m, d ), ya = a[ key ], yb = b[ key ];
					const ua = u0 + len * a.t, ub = u0 + len * b.t;
					kit.quadFacing( [ qa[ 0 ], ya, qa[ 1 ] ], [ qb[ 0 ], yb, qb[ 1 ] ], [ qb[ 0 ], yTop, qb[ 1 ] ], [ qa[ 0 ], yTop, qa[ 1 ] ], N,
						[ [ ua, ya ], [ ub, yb ], [ ub, yTop ], [ ua, yTop ] ] );

				}

			};
			const tone = 0.92 + 0.08 * Math.sin( p.s * 0.05 + seed * 9 );
			kit.color = [ tone * 1.05, tone * 0.84, tone * 0.56 ]; // golden limestone, as in the photos

			// walk
			const WA = open ? OA : PA, WB = open ? OB : PB;
			kit.quadFacing( [ IA[ 0 ], yA, IA[ 1 ] ], [ IB[ 0 ], yB, IB[ 1 ] ], [ WB[ 0 ], yB, WB[ 1 ] ], [ WA[ 0 ], yA, WA[ 1 ] ], up,
				[ [ u, 0 ], [ u + len, 0 ], [ u + len, W / 2 + PO ], [ u, W / 2 + PO ] ] );
			// inner face
			const gIn = Math.min( ground( IA ), ground( IB ) ) - FOOT;
			if ( gate ) archFace( inner, y, inN, u, 'yi' );
			else kit.quadFacing( [ IA[ 0 ], gIn, IA[ 1 ] ], [ IB[ 0 ], gIn, IB[ 1 ] ], [ IB[ 0 ], yB, IB[ 1 ] ], [ IA[ 0 ], yA, IA[ 1 ] ], inN,
				[ [ u, gIn ], [ u + len, gIn ], [ u + len, yB ], [ u, yA ] ] );
			// parapet: inner face, top, outer face (down to the ground outside)
			const ph = open ? 0 : PARAPET_H, yp = y + ph, ypA = yA + ph, ypB = yB + ph;
			if ( ! open ) {

				kit.quadFacing( [ PA[ 0 ], yA, PA[ 1 ] ], [ PB[ 0 ], yB, PB[ 1 ] ], [ PB[ 0 ], ypB, PB[ 1 ] ], [ PA[ 0 ], ypA, PA[ 1 ] ], inN,
					[ [ u, yA ], [ u + len, yB ], [ u + len, ypB ], [ u, ypA ] ] );
				kit.quadFacing( [ PA[ 0 ], ypA, PA[ 1 ] ], [ PB[ 0 ], ypB, PB[ 1 ] ], [ OB[ 0 ], ypB, OB[ 1 ] ], [ OA[ 0 ], ypA, OA[ 1 ] ], up,
					[ [ u, 0 ], [ u + len, 0 ], [ u + len, 0.65 ], [ u, 0.65 ] ] );

			}
			const gOut = Math.min( ground( OA ), ground( OB ) ) - FOOT;
			const foot = ! gate && this._footTone ? this._footTone( OA, OB ) : null;
			if ( gate ) archFace( outer, yp, outN, u );
			else if ( foot ) {

				// a stretch whose lowest courses are greyer (_footTone): the same stone, its tint going over to the
				// golden one between foot.y0 and foot.y1 over the ground there
				const gA = ground( OA ) + foot.y0, gB = ground( OB ) + foot.y0, hA = ground( OA ) + foot.y1, hB = ground( OB ) + foot.y1, gold = kit.color;
				const lum = ( gold[ 0 ] + gold[ 1 ] + gold[ 2 ] ) / 3, grey = gold.map( ( c, k ) => c + ( lum * [ 0.98, 0.96, 0.88 ][ k ] * 0.82 - c ) * foot.k );
				const band = ( y0A, y0B, y1A, y1B, c0, c1 ) => {

					const P = [ [ OA[ 0 ], y0A, OA[ 1 ], u, c0 ], [ OB[ 0 ], y0B, OB[ 1 ], u + len, c0 ], [ OB[ 0 ], y1B, OB[ 1 ], u + len, c1 ], [ OA[ 0 ], y1A, OA[ 1 ], u, c1 ] ];
					const ids = P.map( ( [ x, y, z, uu, c ] ) => {

						kit.color = c;
						return kit.vertex( [ x, y, z ], outN, uu, y );

					} );
					// (wound to face out, as quadFacing would)
					const e1 = [ P[ 1 ][ 0 ] - P[ 0 ][ 0 ], P[ 1 ][ 2 ] - P[ 0 ][ 2 ] ], fwd = - e1[ 1 ] * outN[ 0 ] + e1[ 0 ] * outN[ 2 ];
					if ( fwd >= 0 ) kit.idx.push( ids[ 0 ], ids[ 1 ], ids[ 2 ], ids[ 0 ], ids[ 2 ], ids[ 3 ] );
					else kit.idx.push( ids[ 0 ], ids[ 2 ], ids[ 1 ], ids[ 0 ], ids[ 3 ], ids[ 2 ] );

				};
				band( gOut, gOut, gA, gB, grey, grey );
				band( gA, gB, hA, hB, grey, gold );
				band( hA, hB, ypA, ypB, gold, gold );
				kit.color = gold;

			} else kit.quadFacing( [ OA[ 0 ], gOut, OA[ 1 ] ], [ OB[ 0 ], gOut, OB[ 1 ] ], [ OB[ 0 ], ypB, OB[ 1 ] ], [ OA[ 0 ], ypA, OA[ 1 ] ], outN,
				[ [ u, gOut ], [ u + len, gOut ], [ u + len, ypB ], [ u, ypA ] ] );
			if ( ts ) {

				// a free-standing stretch, or a guarded one: a parapet on the town side too
				const QA = off( A, pIn ), QB = off( B, pIn );
				const qA = yA + PARAPET_H, qB = yB + PARAPET_H;
				kit.quadFacing( [ QA[ 0 ], yA, QA[ 1 ] ], [ QB[ 0 ], yB, QB[ 1 ] ], [ QB[ 0 ], qB, QB[ 1 ] ], [ QA[ 0 ], qA, QA[ 1 ] ], outN );
				kit.quadFacing( [ IA[ 0 ], qA, IA[ 1 ] ], [ IB[ 0 ], qB, IB[ 1 ] ], [ QB[ 0 ], qB, QB[ 1 ] ], [ QA[ 0 ], qA, QA[ 1 ] ], up );
				kit.quadFacing( [ IA[ 0 ], yA, IA[ 1 ] ], [ IB[ 0 ], yB, IB[ 1 ] ], [ IB[ 0 ], qB, IB[ 1 ] ], [ IA[ 0 ], qA, IA[ 1 ] ], inN );

			}

			// the passage: soffit and jambs
			if ( gate ) {

				// the soffit (with a recess, its own from the inner face to the recess's back, and the face
				// stepping down from it to the arch there)
				const mid = split ?? inner;
				for ( let k = 0; k < SUB; k ++ ) {

					const a = arch[ k ], b = arch[ k + 1 ];
					const ia = off( a.m, inner ), ib = off( b.m, inner ), ma = off( a.m, mid ), mb = off( b.m, mid ), oa = off( a.m, outer ), ob = off( b.m, outer );
					kit.quadFacing( [ ma[ 0 ], a.y, ma[ 1 ] ], [ mb[ 0 ], b.y, mb[ 1 ] ], [ ob[ 0 ], b.y, ob[ 1 ] ], [ oa[ 0 ], a.y, oa[ 1 ] ], [ 0, - 1, 0 ] );
					if ( split !== null ) {

						kit.quadFacing( [ ia[ 0 ], a.yi, ia[ 1 ] ], [ ib[ 0 ], b.yi, ib[ 1 ] ], [ mb[ 0 ], b.yi, mb[ 1 ] ], [ ma[ 0 ], a.yi, ma[ 1 ] ], [ 0, - 1, 0 ] );
						kit.quadFacing( [ ma[ 0 ], a.y, ma[ 1 ] ], [ mb[ 0 ], b.y, mb[ 1 ] ], [ mb[ 0 ], b.yi, mb[ 1 ] ], [ ma[ 0 ], a.yi, ma[ 1 ] ], inN );

					}

				}

				const prev = samples[ i - 1 ], next = samples[ i + 1 ];
				const tA = [ - p.tx, 0, - p.tz ], tB = [ p.tx, 0, p.tz ];
				const MA = off( A, mid ), MB = off( B, mid );
				const jamb = ( I, M, O, e, N ) => {

					kit.quadFacing( [ M[ 0 ], gIn, M[ 1 ] ], [ O[ 0 ], gOut, O[ 1 ] ], [ O[ 0 ], e.y, O[ 1 ] ], [ M[ 0 ], e.y, M[ 1 ] ], N );
					if ( split !== null ) kit.quadFacing( [ I[ 0 ], gIn, I[ 1 ] ], [ M[ 0 ], gIn, M[ 1 ] ], [ M[ 0 ], e.yi, M[ 1 ] ], [ I[ 0 ], e.yi, I[ 1 ] ], N );

				};
				if ( ! prev || prev.gate !== gate ) jamb( IA, MA, OA, arch[ 0 ], tB );
				if ( ! next || next.gate !== gate ) jamb( IB, MB, OB, arch[ SUB ], tA );

			}

			// risers to the next tread (or the end caps)
			const next = samples[ i + 1 ];
			const prev = samples[ i - 1 ];
			if ( ! prev && capStart ) this._cap( A, gIn, y, inner, outer, [ - p.tx, 0, - p.tz ] );
			if ( ! next ) this._cap( B, gIn, y, inner, outer, [ p.tx, 0, p.tz ] );
			else if ( next.y !== y && ! p.ramp && ! next.ramp ) {

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
			for ( let m = m0; m <= m1 && ! p.corner && ! open; m ++ ) {

				const sc = m * MERLON_PITCH + MERLON_W / 2;
				if ( sc < p.s - PIECE / 2 || sc >= p.s + PIECE / 2 ) continue;
				const yaw = Math.atan2( - p.tz, p.tx );
				const c = off( p, ( PARAPET_IN + outer ) / 2 );
				const mh = MERLON_H * ( 0.95 + 0.1 * Math.sin( m * 12.9 ) ), mo = lowOuter ? mh * LOW_MERLON : mh;
				kit.box( c[ 0 ] + p.tx * ( sc - p.s ), yp + mo / 2, c[ 1 ] + p.tz * ( sc - p.s ), MERLON_W, mo, outer - PARAPET_IN, yaw, 'bottom' );
				if ( ( ts === 'high' || ts === 'void' ) && ! p.nearCorner ) {

					const c2 = off( p, - ( PARAPET_IN + outer ) / 2 ), mi = ts === 'void' ? mh * LOW_MERLON : mh;
					kit.box( c2[ 0 ] + p.tx * ( sc - p.s ), yp + mi / 2, c2[ 1 ] + p.tz * ( sc - p.s ), MERLON_W, mi, outer - PARAPET_IN, yaw, 'bottom' );

				}

			}

			// colliders: the walk (walkable) and the parapet (solid, too tall to climb)
			const yaw = Math.atan2( - p.tz, p.tx );
			const bottom = gate ? yg : Math.min( gIn, gOut );
			const walkW = PO - pIn;
			const wc = off( p, ( pIn + PO ) / 2 );
			this.colliders.addBox( new Vector3( wc[ 0 ], ( y + bottom ) / 2, wc[ 1 ] ), new Vector3( PIECE / 2 + 0.02, ( y - bottom ) / 2, walkW / 2 ), yaw, { walkable: true, tag: 'wall' } );
			const pc = off( p, ( PARAPET_IN + outer ) / 2 );
			const ptop = y + PARAPET_H + MERLON_H + 0.1;
			if ( ! open ) this.colliders.addBox( new Vector3( pc[ 0 ], ( ptop + bottom ) / 2, pc[ 1 ] ), new Vector3( PIECE / 2 + 0.02, ( ptop - bottom ) / 2, ( outer - PARAPET_IN ) / 2 ), yaw, { walkable: false, tag: 'parapet' } );
			if ( ts ) {

				const qc = off( p, ( inner + pIn ) / 2 ), qtop = ts === 'low' ? y + PARAPET_H + 0.1 : ptop;
				this.colliders.addBox( new Vector3( qc[ 0 ], ( qtop + bottom ) / 2, qc[ 1 ] ), new Vector3( PIECE / 2 + 0.02, ( qtop - bottom ) / 2, ( pIn - inner ) / 2 ), yaw, { walkable: false, tag: 'parapet' } );

			}

			u += len;

		}

		// sharp corners: a block of walk on the turn itself, across the walk, so its pieces close there
		samples.forEach( ( p, i ) => {

			if ( ! p.corner || i < 1 || i > n - 2 || p.gate ) return;
			const a = samples[ i - 1 ], b = samples[ i + 1 ];
			let bx = a.nx + b.nx, bz = a.nz + b.nz;
			const l = Math.hypot( bx, bz ) || 1;
			bx /= l; bz /= l;
			const bottom = T.heightAt( p.x, p.z ) - FOOT;
			// the turning piece has no colliders of its own: square ones in the corner, for the walk and the
			// outer parapet
			const ts = parapetBoth ? 'high' : town ? town( a ) || town( b ) : null;
			const pIn = ts ? - PARAPET_IN : inner, ry = Math.atan2( - a.nz, a.nx ) + Math.PI / 2;
			const square = ( d0, d1, top, walkable ) => {

				const k = ( d0 + d1 ) / 2, h = ( d1 - d0 ) / 2;
				this.colliders.addBox( new Vector3( p.x + ( a.nx + b.nx ) * k, ( top + bottom ) / 2, p.z + ( a.nz + b.nz ) * k ), new Vector3( h, ( top - bottom ) / 2, h ), ry, { walkable, tag: walkable ? 'wall' : 'parapet' } );

			};

			square( pIn, PARAPET_IN, p.y, true );
			square( PARAPET_IN, outer, p.y + PARAPET_H + MERLON_H + 0.1, false );
			// the town side's parapet, if its neighbours have one: a square post in the corner, where theirs meet
			if ( ts ) {

				const w = W / 2 - PARAPET_IN, k = - ( W / 2 - w / 2 );
				const px = p.x + ( a.nx + b.nx ) * k, pz = p.z + ( a.nz + b.nz ) * k; // in from both walls' town faces
				// parapet height, with a merlon on it as high as its neighbours' (none on a plain guard wall)
				const ph = p.y + PARAPET_H + ( ts === 'low' ? 0 : ( ts === 'void' ? LOW_MERLON : 1 ) * MERLON_H );
				kit.box( px, ( ph + bottom ) / 2, pz, w, ph - bottom, w, Math.atan2( - a.nz, a.nx ) + Math.PI / 2, 'bottom' );
				this.colliders.addBox( new Vector3( px, ( ph + bottom ) / 2, pz ), new Vector3( w / 2, ( ph - bottom ) / 2, w / 2 ), Math.atan2( - a.nz, a.nx ) + Math.PI / 2, { walkable: false, tag: 'parapet' } );

			}

		} );

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
		const TALL = { 'Torre de Dom Fernando': 15, 'Torre de Dom Dinis': 10, 'Torre Albarrã': 9, 'Torre do Facho': 7, 'cubelo quadrangular': 4, [ VALE_TOWER.name ]: VALE_TOWER.extra };
		for ( const t of [ ...OSM.towers, VALE_TOWER ] ) {

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
			const top = t === VALE_TOWER && this.valeTowerTop !== undefined ? this.valeTowerTop : walkY + extra;
			const walkable = extra === 0;
			// (open: runs of corners, null between runs; an edge between two corners next in a run is open)
			const at = ( q ) => t.open ? t.open.findIndex( ( o ) => o && Math.hypot( o[ 0 ] - q[ 0 ], o[ 1 ] - q[ 1 ] ) < 1e-6 ) : - 1;
			const openEdge = ( a, b ) => {

				const i = at( a ), j = at( b );
				return i >= 0 && j >= 0 && Math.abs( i - j ) === 1;

			};
			kit.vdata = [ 0.13 + cx * 0.01, 0.9, 0, 0 ];
			kit.color = [ 1, 0.8, 0.53 ];
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
				const onWalk = walkable && near && this._nearestWalk( mx, mz, 1.6 ) || openEdge( a, b );
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
				if ( walkable && near && this._nearestWalk( mx, mz, 1.6 ) || openEdge( a, b ) ) continue;
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
			// not in or by Porta da Vila's tower: its way up is the L-shaped flight, beside the stepped lane
			if ( Math.hypot( p.x + 54.5, p.z - 230 ) < 20 ) continue;
			const fx = p.x - p.nx * 2.0, fz = p.z - p.nz * 2.0; // the stair's line, just inside
			const rise = p.y - T.heightAt( fx, fz ) - ( p.raised || 0 ); // (as before a stretch was raised from the photos)
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
			// either side of Porta Este there is no flight up onto the walls; the stretch north of it, where
			// one used to stand, keeps the others at their spacing
			const p = S[ c.i ];
			if ( p.x > 60 && p.x < 95 && p.z > 12 && p.z < 85 ) {

				if ( p.z < 40 ) chosen.push( { i: c.i, dir: 0 } );
				continue;

			}
			for ( const dir of [ - 1, 1 ] ) {

				const st = this._stairAt( c.i, dir, true );
				if ( st ) {

					chosen.push( { i: c.i, dir } );
					break;

				}

			}

			// the one that would have come down into Porta do Vale's passage still keeps the others at their
			// spacing
			if ( ! chosen.some( ( o ) => o.i === c.i ) && Math.hypot( p.x - VALE_GATE[ 0 ], p.z - VALE_GATE[ 1 ] ) < 16 ) chosen.push( { i: c.i, dir: 0 } );

		}

		for ( const c of chosen ) if ( c.dir ) this._stairAt( c.i, c.dir, false );

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
			// not in or beside the narrow way along the curtain west of Porta da Vila (none in the video: it
			// would fill the way, or stand in the garden past its wall)
			for ( let e = 0; e + 1 < PV_ALLEY.length; e ++ ) if ( segDist( cx, cz, PV_ALLEY[ e ], PV_ALLEY[ e + 1 ] ) < 3.5 ) return null;
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
				// nor in Porta do Vale's covered passage (the block round it reaches 6 m north of the gate)
				const dx = st.x - VALE_GATE[ 0 ], dz = st.z - VALE_GATE[ 1 ];
				if ( Math.hypot( dx, dz ) < 9 && dx * 0.43 - dz * 0.9 < 7 ) return null;
				// nor against a tower (you'd walk into it before reaching the walk)
				for ( const b of this.colliders.boxes ) {

					if ( b.tag !== 'tower' ) continue;
					const dx = st.x - b.center.x, dz = st.z - b.center.z;
					const lx = dx * b.cos - dz * b.sin, lz = dx * b.sin + dz * b.cos;
					if ( Math.abs( lx ) < b.half.x + width && Math.abs( lz ) < b.half.z + width ) return null;

				}
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
