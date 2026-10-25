import { Group, Mesh, Vector3, Color } from '../../engine/index.js';
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
const LOW_MERLON = 0.5; // the merlons round Porta da Vila's void, lower than the curtain's
const MERLON_PITCH = 1.85;
const PIECE = 0.6;
const STEP_RISE = 0.18;
const FOOT = 2.0; // the faces go this far below the ground
// Porta da Vila's town and west walls (after OSM way 475653576): east end (at the curtain), inner arch,
// corner, curtain
const PORTA_DA_VILA = [ [ - 46.95, 225.42 ], [ - 51.1, 225 ], [ - 61.2, 223.9 ], [ - 61.8, 233.3 ] ]; // from the curtain's corner
const PV_TOWER = 13.2; // Porta da Vila's tower: its four walls' walk this high over its floor
const PV_EAST_FACE = - 48.6; // the tower's east side (the curtain): its face on the void
const PV_FLIGHT = 2.3; // the L-shaped flight's width, as in the photo (references/...-duasescadas)
const clamp01 = ( v ) => Math.min( 1, Math.max( 0, v ) );
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
		// the curtain round the town; on Porta da Vila's tower (its outer and east sides) it stands as high
		// as the tower's town wall
		const wall = { ...terrain.wall, pts: terrain.wall.pts.map( ( p ) => ( { ...p } ) ) };
		this._pvCurtainCorner( wall );
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
		this.curtain = this._wallLine( wall, terrain.gates, 0.37, { sharp: [ - 50.5, 190, - 18, 236.5 ], adjust: westOfTower, town: onTower, ramp: NE } );
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
		if ( this.portaDaVila ) this._oratorio( this.portaDaVila.gates[ 1 ], materials );

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
		this.portaDaVila = this._wallLine( prof, [ inner ], 0.37, { sharp: [ - 64, 221, - 58.5, 227 ], exact: pts, town: () => 'low', lowOuter: true, bare: ( p ) => p.x > PV_EAST_FACE, capStart: false } ); // (its east end runs into the curtain's corner)
		this.portaDaVila.gates = [ outerGate, inner ];

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
		const put = ( p, l, len, rise ) => {

			const g = T.heightAt( p[ 0 ], p[ 1 ] ), ahead = T.heightAt( p[ 0 ] + l.dx * len / 2, p[ 1 ] + l.dz * len / 2 );
			y = y === - Infinity ? ahead + 0.12 : y + Math.min( rise[ 1 ], Math.max( rise[ 0 ], ahead + 0.08 - y ) );
			steps.push( { x: p[ 0 ], z: p[ 1 ], y, g: Math.min( g, ahead ), yaw: Math.atan2( - l.dz, l.dx ), len } );

		};
		// three short steps, two long, again and again, each 6-16 cm up, keeping to the ground
		const PATTERN = [ 0.45, 0.45, 0.45, 1.1, 1.1 ];
		let k = 0;
		const flight = ( from, l, length ) => {

			for ( let d = 0; d < length - 0.2; k ++ ) {

				const len = Math.min( PATTERN[ k % PATTERN.length ], length - d );
				put( at( from, l, d + len / 2 ), l, len, [ 0.06, 0.16 ] );
				d += len;

			}

		};
		const dStart = ( corner[ 0 ] - startX ) / north.dx;
		flight( at( corner, north, - dStart ), north, dStart - width / 2 );
		put( corner, west, width, [ 0.06, 0.16 ] ); // the corner
		const stepsEnd = turn[ 1 ] - 5 - width / 2;
		flight( at( corner, west, width / 2 ), west, ( stepsEnd - corner[ 1 ] ) / west.dz - width / 2 );
		// the sloping path, following the ground, to the turn and a few metres along the curtain
		const RUN = 0.3;
		const slope = ( from, l, length ) => {

			for ( let d = RUN / 2; d < length; d += RUN ) put( at( from, l, d ), l, RUN, [ 0, 0.1 ] );

		};
		const sEnd = at( corner, west, width / 2 + ( stepsEnd - corner[ 1 ] ) / west.dz - width / 2 );
		slope( sEnd, west, ( turn[ 1 ] - sEnd[ 1 ] ) / west.dz - width / 2 );
		put( turn, curtain, width, [ 0, 0.06 ] );
		slope( at( turn, curtain, width / 2 ), curtain, 5 );

		// a landing level with the Casa da Música's terrace where you step onto it, part way up the first
		// leg: the steps it covers become one, the steps below climb to it in even rises, those above ease back
		const casa = this.casaOutline = this._casaOutline( { corner, north, width } );
		const yT = casa.yT, nLeg = steps.findIndex( ( st ) => st.x < corner[ 0 ] + width / 2 );
		let g = - 1;
		steps.forEach( ( st, i ) => {

			if ( i < nLeg && st.x < - 57.6 && st.x > - 59.9 && ( g < 0 || Math.abs( st.y - yT + 0.15 ) < Math.abs( steps[ g ].y - yT + 0.15 ) ) ) g = i;

		} );
		if ( g > 0 ) {

			const LAND = 0.85, gx = steps[ g ].x;
			let a = g, b = g;
			while ( a > 1 && Math.abs( steps[ a - 1 ].x - gx ) < LAND ) a --;
			while ( b + 1 < nLeg && Math.abs( steps[ b + 1 ].x - gx ) < LAND ) b ++;
			// from the first step's lower end to the last one's upper end (going up is westward, - x)
			const x0 = steps[ a ].x - north.dx * steps[ a ].len / 2, x1 = steps[ b ].x + north.dx * steps[ b ].len / 2;
			const y0 = steps[ 0 ].y;
			for ( let i = 1; i < a; i ++ ) steps[ i ].y = y0 + ( yT - y0 ) * i / a;
			const delta = yT - steps[ b ].y;
			for ( let i = b + 1, j = 1; i < steps.length; i ++, j ++ ) steps[ i ].y += delta * Math.max( 0, 1 - j / 10 );
			const lx = ( x0 + x1 ) / 2, d = ( lx - corner[ 0 ] ) / north.dx;
			const landing = { x: lx, z: corner[ 1 ] + north.dz * d, y: yT, g: Math.min( ...steps.slice( a, b + 1 ).map( ( st ) => st.g ) ), yaw: steps[ a ].yaw, len: Math.abs( x1 - x0 ) };
			steps.splice( a, b - a + 1, landing );
			this.laneGate = landing;

		}

		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 1.06, 1.05, 1.02 ]; // pale limestone
		steps.forEach( ( st ) => {

			const bottom = st.g - 0.6, h = st.y - bottom;
			kit.box( st.x, bottom + h / 2, st.z, st.len + 0.02, h, width, st.yaw, 'bottom' );
			this.colliders.addBox( new Vector3( st.x, bottom + h / 2, st.z ), new Vector3( st.len / 2 + 0.01, h / 2, width / 2 ), st.yaw, { walkable: true, tag: 'stair' } );

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

	// Rua Dom João de Ornelas, going down from the square outside the gate (TerrainData shapes it), as in the
	// photo: a short flight of cobbled steps beside the slope, from the square to the start of the wall that
	// holds the square up; the wall whitewashed, with a blue band along its foot that follows the street, a
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

		// the square's edge over the slope, as far as the steps: a kerb of setts, its face standing over the street
		const box = ( s0, s1, d0, d1, top, bottom, walkable, tag ) => {

			const sm = ( s0 + s1 ) / 2, [ x, z ] = pt( sm, ( d0 + d1 ) / 2 ), yaw = yawAt( sm );
			kit.box( x, ( top + bottom ) / 2, z, s1 - s0 + 0.02, top - bottom, d1 - d0, yaw, 'bottom' );
			this.colliders.addBox( new Vector3( x, ( top + bottom ) / 2, z ), new Vector3( ( s1 - s0 ) / 2 + 0.01, ( top - bottom ) / 2, ( d1 - d0 ) / 2 ), yaw, { walkable, tag } );

		};
		const FL = o.S_W - o.FLIGHT, a0 = o.WALL_OFF, a1 = o.HALF + 1.8;
		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 0.8, 0.78, 0.74 ]; // grey setts
		for ( let sv = o.S0; sv < FL - 0.01; sv += 1 ) {

			const s1 = Math.min( FL, sv + 1 );
			box( sv, s1, a0, o.HALF + 2.2, o.F + 0.01, o.roadY( s1 ) - 0.5, true, 'praceta' );

		}

		// the steps: five, in line with the wall, down from the square to its foot, each with a nosing of
		// pale stone; their sides stand over the street
		const N = 5, tread = o.FLIGHT / N;
		for ( let i = 0; i < N; i ++ ) {

			const s0 = FL + tread * i, top = o.F - o.DROP * ( i + 1 ) / N, yaw = yawAt( s0 + tread / 2 );
			kit.vdata = [ 0.29, 0.6, 0, 0 ];
			kit.color = [ 0.8, 0.78, 0.74 ];
			box( s0, s0 + tread, a0, a1, top, o.roadY( s0 + tread ) - 0.5, true, 'stair' );
			const [ nx, nz ] = pt( s0 + tread - 0.11, ( a0 + a1 ) / 2 );
			kit.vdata = [ 0.43, 0.5, 0, 0 ];
			kit.color = [ 0.95, 0.9, 0.8 ]; // worn limestone
			kit.box( nx, top - 0.1 + 0.005, nz, 0.22, 0.2, a1 - a0 + 0.02, yaw );

		}

		// the square beside the steps: paved over the ground's dip down to them
		kit.vdata = [ 0.29, 0.6, 0, 0 ];
		kit.color = [ 0.8, 0.78, 0.74 ];
		box( FL, o.S_W, a1 + 0.45, o.HALF + 4.2, o.F + 0.01, o.roadY( o.S_W ) - 0.5, true, 'praceta' );

		// the wall, whitewashed: its faces built here so the blue band (the plaster's barra) runs along the
		// street's slope, 1.25 m up, rather than level
		const BLUE = lin( [ 0.1, 0.27, 0.78 ] );
		const STEP_AT = o.S_W + 5, topAt = ( s ) => o.F + ( s < STEP_AT ? 1.1 : 1.45 ), TH = 0.6;
		const BAR = 0.75; // v scale on the street side: the barra's 0.95 m becomes 1.25 m
		plaster.color = BLUE;
		plaster.vdata = [ 20, 0, 0.0722, 0 ];
		const cuts = [ o.S_W ];
		for ( let sv = o.S_W + 1; sv < o.WALL_END - 0.3; sv += 1 ) cuts.push( sv );
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

		// the steps' side wall on the square's side, low, whitewashed, running into the wall's end
		{

			const top = o.F + 0.45, d0 = a1, d1 = a1 + 0.45;
			for ( let k = 0; k < 2; k ++ ) {

				const sa = FL + o.FLIGHT * k / 2, sb = FL + o.FLIGHT * ( k + 1 ) / 2;
				const A = pt( sa, d0 ), B = pt( sb, d0 ), A2 = pt( sa, d1 ), B2 = pt( sb, d1 );
				const ya = o.F - o.DROP * k / 2 - 0.3, yb = o.F - o.DROP * ( k + 1 ) / 2 - 0.3;
				const [ lx, lz ] = left( ( sa + sb ) / 2 ), p = o.at( sa );
				plaster.quadFacing( [ A[ 0 ], ya, A[ 1 ] ], [ B[ 0 ], yb, B[ 1 ] ], [ B[ 0 ], top, B[ 1 ] ], [ A[ 0 ], top, A[ 1 ] ], [ - lx, 0, - lz ],
					[ [ sa, 2 ], [ sb, 2 ], [ sb, 3 ], [ sa, 3 ] ] );
				plaster.quadFacing( [ A2[ 0 ], o.F - 0.3, A2[ 1 ] ], [ B2[ 0 ], o.F - 0.3, B2[ 1 ] ], [ B2[ 0 ], top, B2[ 1 ] ], [ A2[ 0 ], top, A2[ 1 ] ], [ lx, 0, lz ],
					[ [ sa, 2 ], [ sb, 2 ], [ sb, 3 ], [ sa, 3 ] ] );
				plaster.quadFacing( [ A[ 0 ], top, A[ 1 ] ], [ B[ 0 ], top, B[ 1 ] ], [ B2[ 0 ], top, B2[ 1 ] ], [ A2[ 0 ], top, A2[ 1 ] ], [ 0, 1, 0 ],
					[ [ sa, 5 ], [ sb, 5 ], [ sb, 5.5 ], [ sa, 5.5 ] ] );
				if ( k === 0 ) plaster.quadFacing( [ A[ 0 ], o.F - 0.3, A[ 1 ] ], [ A2[ 0 ], o.F - 0.3, A2[ 1 ] ], [ A2[ 0 ], top, A2[ 1 ] ], [ A[ 0 ], top, A[ 1 ] ], [ - p.dx, 0, - p.dz ],
					[ [ 0, 2 ], [ 0.45, 2 ], [ 0.45, 3 ], [ 0, 3 ] ] );
				const sm = ( sa + sb ) / 2, [ cx, cz ] = pt( sm, ( d0 + d1 ) / 2 );
				this.colliders.addBox( new Vector3( cx, ( top + yb ) / 2, cz ), new Vector3( ( sb - sa ) / 2, ( top - yb ) / 2, 0.225 ), yawAt( sm ), { walkable: false, tag: 'wall' } );

			}

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

		// limestone slabs along the street's far side, a kerb's height over it
		kit.vdata = [ 0.43, 0.5, 0, 0 ];
		kit.color = [ 1.04, 1.02, 0.98 ];
		for ( let sv = o.S_W; sv < o.WALL_END + 6; sv += 1 ) {

			const sm = sv + 0.5, [ x, z ] = pt( sm, - o.HALF + 0.5 ), y = o.roadY( sm ) + 0.12, yaw = yawAt( sm );
			kit.box( x, y - 0.4, z, 1.02, 0.8, 1.3, yaw );
			this.colliders.addBox( new Vector3( x, y - 0.4, z ), new Vector3( 0.51, 0.4, 0.65 ), yaw, { walkable: true, tag: 'stair' } );

		}

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

		// a bar of iron from a to b ([ x, y, z ]), w thick
		const beam = ( a, b, w ) => {

			const dx = b[ 0 ] - a[ 0 ], dz = b[ 2 ] - a[ 2 ], l = Math.hypot( dx, dz );
			// (a vertical bar: any horizontal side will do)
			const ux = l > 1e-4 ? dx / l : f.tx, uz = l > 1e-4 ? dz / l : f.tz;
			const sx = - uz * w / 2, sz = ux * w / 2, h = w / 2;
			const vert = l < 1e-4;
			const c = ( p, i, j ) => vert ? [ p[ 0 ] + sx * i + ux * h * j, p[ 1 ], p[ 2 ] + sz * i + uz * h * j ] : [ p[ 0 ] + sx * i, p[ 1 ] + h * j, p[ 2 ] + sz * i ];
			const ax = vert ? [ 0, Math.sign( b[ 1 ] - a[ 1 ] ), 0 ] : [ ux, 0, uz ];
			const up = vert ? [ ux, 0, uz ] : [ 0, 1, 0 ];
			iron.quadFacing( c( a, - 1, 1 ), c( b, - 1, 1 ), c( b, 1, 1 ), c( a, 1, 1 ), up );
			iron.quadFacing( c( a, - 1, - 1 ), c( b, - 1, - 1 ), c( b, 1, - 1 ), c( a, 1, - 1 ), up.map( ( v ) => - v ) );
			iron.quadFacing( c( a, 1, - 1 ), c( b, 1, - 1 ), c( b, 1, 1 ), c( a, 1, 1 ), [ sx, 0, sz ] );
			iron.quadFacing( c( a, - 1, - 1 ), c( b, - 1, - 1 ), c( b, - 1, 1 ), c( a, - 1, 1 ), [ - sx, 0, - sz ] );
			iron.quadFacing( c( a, - 1, - 1 ), c( a, 1, - 1 ), c( a, 1, 1 ), c( a, - 1, 1 ), ax.map( ( v ) => - v ) );
			iron.quadFacing( c( b, - 1, - 1 ), c( b, 1, - 1 ), c( b, 1, 1 ), c( b, - 1, 1 ), ax );

		};

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
		const leftTop = ( sv ) => pe.surf( sv ) + pe.BED + 0.15;
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

		const ls = wallRun( 1, BS1 + 0.1, pe.ST + 1.6, leftTop );
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
		const RET = TR.depth, PLANT0 = 2.6, PLANT_OUT = 1.3; // its length (the terrace's depth); the planter from 2.6 m along, 1.3 m deep
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

		// the planter in front of it: a low wall with a blue band, its top level, plants over it
		const BLUE = lin( [ 0.1, 0.27, 0.78 ] );
		const Q0 = [ C0[ 0 ] + along[ 0 ] * PLANT0 - intoT[ 0 ] * PLANT_OUT, C0[ 1 ] + along[ 1 ] * PLANT0 - intoT[ 1 ] * PLANT_OUT ];
		const Q1 = [ C1[ 0 ] - intoT[ 0 ] * PLANT_OUT, C1[ 1 ] - intoT[ 1 ] * PLANT_OUT ];
		const plantTop = T.heightAt( ...Q0 ) + 1.5;
		straightWall( Q0, Q1, intoT, () => plantTop, BLUE, 0.62 );
		const S0 = [ C0[ 0 ] + along[ 0 ] * PLANT0, C0[ 1 ] + along[ 1 ] * PLANT0 ];
		straightWall( S0, [ S0[ 0 ] - intoT[ 0 ] * ( PLANT_OUT - TH ), S0[ 1 ] - intoT[ 1 ] * ( PLANT_OUT - TH ) ], along, () => plantTop, BLUE, 0.62, [ false, false ] );
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

		{

			// the black gate at its end, in the wall's line, into the terrace's garden
			iron.vdata = [ 0, 0, 0, 0 ];
			const G0 = [ Q1[ 0 ] + along[ 0 ] * 0.05, Q1[ 1 ] + along[ 1 ] * 0.05 ], GL = 1.6, g0 = T.heightAt( ...G0 );
			const mid = [ G0[ 0 ] + along[ 0 ] * GL / 2, G0[ 1 ] + along[ 1 ] * GL / 2 ], yaw = Math.atan2( - along[ 1 ], along[ 0 ] );
			iron.box( mid[ 0 ], g0 + 1.15, mid[ 1 ], GL, 2.3, 0.06, yaw );
			this.colliders.addBox( new Vector3( mid[ 0 ], g0 + 1.15, mid[ 1 ] ), new Vector3( GL / 2, 1.15, 0.05 ), yaw, { walkable: false, tag: 'gate' } );

		}

		// on the left, part way up, a pier: its foot yellow, whitewashed, a stone cap and a terracotta urn;
		// the balustrade runs on from it up beside the flight
		{

			const sP = pe.SF + 2.4, [ x, z ] = lanePt( sP, H + TH / 2 ), yaw = yawAt( sP ), r = pe.surf( sP );
			const bottom = r - 0.4, top = leftTop( sP ) + 0.85, band = r + 0.45, W2 = 0.56;
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
			balustrade( 1, sP + W2 / 2, pe.ST + 1.6, ( sv ) => leftTop( sv ) + 0.06 );

		}

		// the two old plane trees in the bed (Trees grows them)
		this.extraTrees = [ [ 6.5, H + TH + 2.6, 1.0 ], [ 11.8, H + TH + 3.2, 0.92 ] ].map( ( [ sv, dd, scale ] ) => {

			const [ x, z ] = lanePt( sv, dd );
			return { kind: 'plane', x, z, scale };

		} );

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
	_wallLine( profile, gates, seed, { parapetBoth = false, sharp = null, adjust = null, exact = null, town = null, lowOuter = false, bare = null, capStart = true, ramp = null } = {} ) {

		const P = profile.pts;
		if ( P.length < 2 ) return null;
		// resample positions at PIECE; interpolate top and normal from the 2 m profile by arc length
		// (the profile's 2 m points cut corners; `exact`, the wall's own polyline, keeps them, each side
		// resampled on its own)
		const line = exact ? exact.slice( 0, - 1 ).flatMap( ( a, i ) => {

			const b = exact[ i + 1 ], k = Math.max( 1, Math.round( Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) / PIECE ) );
			return Array.from( { length: k + ( i === exact.length - 2 ? 1 : 0 ) }, ( _, j ) => [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * j / k, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * j / k ] );

		} ) : resample( P.map( ( p ) => [ p.x, p.z ] ), PIECE );
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
		// in the box `sharp` ([ x0, z0, x1, z1 ]), normals square to the line itself, so corners are mitred
		if ( sharp ) samples.forEach( ( p, i ) => {

			if ( p.x < sharp[ 0 ] || p.x > sharp[ 2 ] || p.z < sharp[ 1 ] || p.z > sharp[ 3 ] ) return;
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
			if ( gate ) archFace( outer, yp, outN, u );
			else kit.quadFacing( [ OA[ 0 ], gOut, OA[ 1 ] ], [ OB[ 0 ], gOut, OB[ 1 ] ], [ OB[ 0 ], ypB, OB[ 1 ] ], [ OA[ 0 ], ypA, OA[ 1 ] ], outN,
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
			// not in or by Porta da Vila's tower: its way up is the L-shaped flight, beside the stepped lane
			if ( Math.hypot( p.x + 54.5, p.z - 230 ) < 20 ) continue;
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
