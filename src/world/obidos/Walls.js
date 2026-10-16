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
const MERLON_PITCH = 1.85;
const PIECE = 0.6;
const STEP_RISE = 0.18;
const FOOT = 2.0; // the faces go this far below the ground
// Porta da Vila's town and west walls (after OSM way 475653576): east end, inner arch, corner, curtain
const PORTA_DA_VILA = [ [ - 44, 225.7 ], [ - 51.1, 225 ], [ - 61.2, 223.9 ], [ - 61.8, 233.3 ] ];
const PV_TOWER = 13.2; // Porta da Vila's tower: its four walls' walk this high over its floor
const PV_FLIGHT = 2.3; // the L-shaped flight's width, as in the photo (references/...-duasescadas)
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
		// the curtain round the town; on Porta da Vila's tower (its outer and east sides) it stands as high
		// as the tower's town wall, coming down to the curtain's walk either way
		const wall = { ...terrain.wall, pts: terrain.wall.pts.map( ( p ) => ( { ...p } ) ) };
		const tower = wall.pts.filter( ( p ) => p.x > - 61.5 && p.x < - 46 && p.z > 226 && p.z < 236.5 );
		if ( tower.length ) {

			const top = terrain.heightAt( - 51.1, 225 ) + PV_TOWER, s0 = Math.min( ...tower.map( ( p ) => p.s ) ), s1 = Math.max( ...tower.map( ( p ) => p.s ) );
			for ( const p of wall.pts ) p.top = Math.max( p.top, top - Math.max( 0, s0 - p.s, p.s - s1 ) / 2.5 );

		}

		// its corners round Porta da Vila's east side are sharp: the profile's normals, smoothed over a few
		// metres, twist the faces there and open holes into the tower
		this.curtain = this._wallLine( wall, terrain.gates, 0.37, { sharp: [ - 50.5, 225, - 43, 236.5 ] } );
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
		this._praceta();
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
		// the west wall rises to meet the curtain's walk where it joins it, as a flight of the walk would
		const end = this._nearestWalk( pts[ 3 ][ 0 ], pts[ 3 ][ 1 ] + 1, 4 );
		if ( end ) for ( const p of prof.pts ) p.top = Math.max( p.top, end.p.y - ( prof.length - p.s ) / 2.5 );
		// the tower stands well above the curtain (photo references/...-debaixodaportadavila): its town and
		// west walls, like its other two (the curtain's), about 13 m over its floor, from the curtain's line
		const high = inner.y + PV_TOWER;
		for ( const p of prof.pts ) if ( p.s > 3.5 ) p.top = Math.max( p.top, high );
		this.portaDaVila = this._wallLine( prof, [ inner ], 0.37 );
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
	_wallLine( profile, gates, seed, { parapetBoth = false, sharp = null } = {} ) {

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
		// in the box `sharp` ([ x0, z0, x1, z1 ]), normals square to the line itself, so corners are mitred
		if ( sharp ) samples.forEach( ( p, i ) => {

			if ( p.x < sharp[ 0 ] || p.x > sharp[ 2 ] || p.z < sharp[ 1 ] || p.z > sharp[ 3 ] ) return;
			const a = samples[ Math.max( 0, i - 1 ) ], b = samples[ Math.min( n - 1, i + 1 ) ];
			const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot( dx, dz ) || 1;
			const f = - dz * p.nx + dx * p.nz >= 0 ? 1 : - 1;
			p.nx = - dz / L * f;
			p.nz = dx / L * f;
			p.tx = - p.nz * profile.outward;
			p.tz = p.nx * profile.outward;

		} );
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
			const spring = g.y + Math.max( 2.4, 4.2 - R );
			// pointed: two arcs of radius R * pointed, each struck from beyond the opposite jamb
			if ( g.pointed ) {

				const rr = R * g.pointed, e = Math.abs( a ) + rr - R;
				return spring + Math.sqrt( Math.max( 0, rr * rr - e * e ) );

			}

			return spring + Math.sqrt( Math.max( 0, R * R - a * a ) );

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
			kit.color = [ tone * 1.05, tone * 0.84, tone * 0.56 ]; // golden limestone, as in the photos

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
