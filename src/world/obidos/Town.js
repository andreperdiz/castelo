import { Group, Mesh, Vector3, Color } from '../../engine/index.js';
import { MeshKit } from './MeshKit.js';
import { OSM, pointInPolygon, polygonArea, SegmentIndex } from './Geo.js';
import { orientedBox } from './Walls.js';
import { mulberry32 } from '../../util/Noise.js';

// The houses of Óbidos (and the suburbs round the walls) from the OpenStreetMap footprints:
// whitewashed walls with a painted base band and window / door surrounds (blue, yellow or ochre),
// terracotta canudo-tile roofs, chimneys. Every footprint gets one gable roof: its ridge runs along
// the footprint's oriented box, through its middle, at a 24° pitch (capped, so wide buildings get a
// flat-topped ridge); the walls rise to the roof planes, so they end in gables where they cross the
// ridge. Churches and chapels stand taller with fewer, higher openings.
//
// Colliders: a thin solid box along every wall edge.
const PITCH = 0.45; // rise per metre (~24°)
const MAX_RISE = 3.0;
const STOREY = 3.0;
const SKIP = new Set( [ 'roof', 'static_caravan', 'transformer_tower' ] );
const SKIP_MAN_MADE = new Set( [ 'bridge', 'water_tap', 'storage_tank', 'windmill' ] );
// the Oratório inside Porta da Vila (the gate tower is open to the sky in the game), and the Passo da Porta
// da Vila, built as a portal on the tower's face (Walls._passoPortal); the Chafariz Novo below Porta Este, a
// fountain, not a house (Walls._portaEste); the Oratório da Nossa Senhora da Graça, inside the tower by
// Porta do Vale (Walls builds the tower)
const SKIP_ID = new Set( [ 1276312776, 1276312777, 475653566, 1276297062 ] );
// streets passing under a building (OSM building_passage) built as such: the building split along the
// passage into its two wings, and over the passage the body joining them, arched on both sides. By the
// building's id: the passage's street, its half width (Rua Padre António Almeida, between the two wings of
// the house it runs under, on its way to the Calçada da Misericórdia)
const PASSAGES = { 299064346: { street: 1177937020, half: 1.3 } };
// the Auditório (Casa da Música) without its south wing, where the steps by Porta da Vila are built (its
// terrace along Rua Direita: Walls._casaDaMusicaTerrace)
const OUTLINE = { 298902328: [ [ - 64.4, 195.6 ], [ - 68.3, 195.2 ], [ - 76.8, 197.3 ], [ - 75, 206.1 ], [ - 72, 214 ], [ - 70.5, 214.5 ], [ - 60.2, 214.5 ], [ - 64.4, 195.6 ] ] };
// as in the photos: the Casa da Música is white with strong blue trim, two storeys
const PAINT = { 298902328: [ 0.08, 0.2, 0.72 ],
	// the house on the left going up Travessa do Beneficiado: yellow (photo references/...-ruaperpendiculara)
	299068737: [ 0.86, 0.64, 0.17 ],
	// the house on the right going up the Calçada da Misericórdia: a charcoal foot (photo
	// references/...-whatsapp-image-2026-10-21-at-10-05-24)
	299064166: [ 0.27, 0.27, 0.28 ],
	// down Rua Porta do Vale from the tower by the gate (photo references/...-img-4397): on the right, between
	// it and Rua da Porta da Senhora da Graça, red; on the left a yellow foot, then blue
	299086795: [ 0.62, 0.13, 0.1 ],
	299135575: [ 0.86, 0.64, 0.17 ],
	299135581: [ 0.13, 0.27, 0.58 ],
	// the first house going up Rua Dom João de Ornelas: an orange foot and surrounds (photo references/...-img-4391)
	299088484: [ 0.86, 0.55, 0.17 ],
	// down to the fork (photo references/...-img-4390): a low house with a blue foot; the long one, a yellow foot
	299088432: [ 0.13, 0.24, 0.6 ],
	299088405: [ 0.88, 0.66, 0.2 ] };
// the eave itself, for houses the footprint's size and slope would make too tall: going up Rua Dom João de
// Ornelas, the long footprint holding the blue house and the white one beyond it, two low storeys, then a
// lower one (photo references/...-img-4391; the street fronts: Town._ornelasFronts)
const EAVE = { 299088554: 43.2, 299088587: 43.5,
	// and the other way, down to the fork: the two-storey house, and the long low one past it behind the green
	// gate (photo references/...-img-4390)
	299088474: 40.6, 299088405: 39.2 };
const STOREYS = { 298902328: 2,
	// Casa da Picva, outside Porta Este: one storey (photos references/...-img-4392, -inicio-de-rua-...)
	299088208: 1,
	// the houses either side of the top of Rua Porta do Vale: one storey (photo references/...-img-4397)
	299086795: 1, 299135575: 1, 299135581: 1,
	// behind the garden wall across the lane from Porta do Vale's block: only trees show over it (photo
	// references/...-img-4410)
	299083844: 1 };

// trim paints: Óbidos blue and yellow, some ochre red, a few grey
const TRIMS = [
	[ 0.45, [ 0.13, 0.27, 0.58 ] ],
	[ 0.3, [ 0.86, 0.64, 0.17 ] ],
	[ 0.1, [ 0.58, 0.26, 0.16 ] ],
	[ 0.08, [ 0.42, 0.44, 0.44 ] ],
	[ 0.07, [ 0.93, 0.92, 0.89 ] ], // no colour: all white
];
const srgbToLinear = ( c ) => c.map( ( v ) => ( v <= 0.04045 ? v / 12.92 : ( ( v + 0.055 ) / 1.055 ) ** 2.4 ) );

export class Town {

	constructor( { scene, terrain, colliders, materials, walls = null, bounds = 1000 } ) {

		this.terrain = terrain;
		this.colliders = colliders;
		this.wallsRef = walls;
		this.group = new Group();
		this.group.name = 'Town';
		this.walls = new MeshKit();
		this.roofs = new MeshKit();
		this.lights = []; // lamp positions for the night (LocalLights)
		this.buildings = [];
		const rand = mulberry32( 1415 );

		// street clearance: footprint corners closer than this to a street's centre line are pushed back
		// (the OSM outlines and centre lines are a metre or so apart in the narrow lanes)
		const CLEAR = { pedestrian: 1.5, residential: 2.2, living_street: 1.8, service: 1.6, unclassified: 2.4, tertiary: 3, secondary: 3.2, primary: 3.6, footway: 0.8, steps: 0.9, path: 0.6 };
		const streetLines = OSM.streets.filter( ( st ) => CLEAR[ st.highway ] && ! st.tunnel ).map( ( st ) => ( { pts: st.pts, clear: CLEAR[ st.highway ] } ) );
		const streetIndex = new SegmentIndex( streetLines, 16 );
		// what the walls build in the town (the steps by Porta da Vila): houses are pushed back to the left of
		// these lines (away from the walls), even from the wrong side
		const clearIndex = new SegmentIndex( walls?.clearLines || [], 16 );

		// footprints, cleaned, with a grid for "is this point inside another building" queries
		const list = [];
		this.passages = [];
		for ( const b of OSM.buildings ) for ( let poly of this._pieces( b ) ) {

			if ( SKIP.has( b.building ) || SKIP_MAN_MADE.has( b.man_made ) || SKIP_ID.has( b.id ) ) continue;
			poly = cleanPolygon( poly );
			if ( poly.length < 3 ) continue;
			poly = poly.map( ( q ) => {

				const near = streetIndex.nearest( q[ 0 ], q[ 1 ], 3.6 );
				if ( ! near || near.d >= near.seg.line.clear ) return q;
				const { a, b: e } = near.seg;
				const px = a[ 0 ] + ( e[ 0 ] - a[ 0 ] ) * near.t, pz = a[ 1 ] + ( e[ 1 ] - a[ 1 ] ) * near.t;
				let dx = q[ 0 ] - px, dz = q[ 1 ] - pz;
				const d = Math.hypot( dx, dz );
				if ( d < 1e-3 ) return q; // on the centre line: a passage, leave it
				dx /= d; dz /= d;
				return [ px + dx * near.seg.line.clear, pz + dz * near.seg.line.clear ];

			} ).map( ( q ) => {

				const near = clearIndex.nearest( q[ 0 ], q[ 1 ], 6 );
				if ( ! near ) return q;
				const { a, b: e } = near.seg, clear = near.seg.line.clear;
				const L = Math.hypot( e[ 0 ] - a[ 0 ], e[ 1 ] - a[ 1 ] ) || 1;
				const nx = - ( e[ 1 ] - a[ 1 ] ) / L, nz = ( e[ 0 ] - a[ 0 ] ) / L;
				const px = a[ 0 ] + ( e[ 0 ] - a[ 0 ] ) * near.t, pz = a[ 1 ] + ( e[ 1 ] - a[ 1 ] ) * near.t;
				const side = ( q[ 0 ] - px ) * nx + ( q[ 1 ] - pz ) * nz;
				// round the outside of a bend: beyond a segment's end, push out from the bend itself
				if ( side > 0 && ( near.t <= 0 || near.t >= 1 ) ) return near.d >= clear ? q : [ px + ( q[ 0 ] - px ) / near.d * clear, pz + ( q[ 1 ] - pz ) / near.d * clear ];
				if ( side >= clear ) return q;
				return [ px + nx * clear, pz + nz * clear ];

			} );
			poly = cleanPolygon( poly );
			if ( poly.length < 3 ) continue;
			const area = polygonArea( poly );
			if ( Math.abs( area ) < 6 ) continue;
			if ( area < 0 ) poly = poly.reverse();
			const cx = poly.reduce( ( a, q ) => a + q[ 0 ], 0 ) / poly.length, cz = poly.reduce( ( a, q ) => a + q[ 1 ], 0 ) / poly.length;
			if ( Math.abs( cx ) > bounds || Math.abs( cz ) > bounds ) continue;
			list.push( { b, poly, area: Math.abs( area ), cx, cz } );

		}

		this.grid = new Map();
		const key = ( x, z ) => Math.floor( x / 20 ) * 73856093 ^ Math.floor( z / 20 ) * 19349663;
		for ( const f of list ) {

			let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
			for ( const [ x, z ] of f.poly ) {

				x0 = Math.min( x0, x ); x1 = Math.max( x1, x ); z0 = Math.min( z0, z ); z1 = Math.max( z1, z );

			}

			f.bbox = [ x0, z0, x1, z1 ];
			for ( let gz = Math.floor( z0 / 20 ); gz <= Math.floor( z1 / 20 ); gz ++ ) for ( let gx = Math.floor( x0 / 20 ); gx <= Math.floor( x1 / 20 ); gx ++ ) {

				const k = gx * 73856093 ^ gz * 19349663;
				let c = this.grid.get( k );
				if ( ! c ) this.grid.set( k, c = [] );
				c.push( f );

			}

		}

		this._inOther = ( x, z, self ) => {

			for ( const f of this.grid.get( key( x, z ) ) || [] ) {

				if ( f === self ) continue;
				const [ x0, z0, x1, z1 ] = f.bbox;
				if ( x < x0 || x > x1 || z < z0 || z > z1 ) continue;
				if ( pointInPolygon( x, z, f.poly ) ) return true;

			}

			return false;

		};

		// street segments binned for the passage test
		this.streetSegs = new Map();
		for ( const st of OSM.streets ) {

			if ( ! /pedestrian|footway|steps|residential|living_street|path|service/.test( st.highway ) ) continue;
			for ( let i = 0; i + 1 < st.pts.length; i ++ ) {

				const a = st.pts[ i ], b = st.pts[ i + 1 ];
				for ( let gz = Math.floor( Math.min( a[ 1 ], b[ 1 ] ) / 20 ); gz <= Math.floor( Math.max( a[ 1 ], b[ 1 ] ) / 20 ); gz ++ ) for ( let gx = Math.floor( Math.min( a[ 0 ], b[ 0 ] ) / 20 ); gx <= Math.floor( Math.max( a[ 0 ], b[ 0 ] ) / 20 ); gx ++ ) {

					const k = gx * 73856093 ^ gz * 19349663;
					let c = this.streetSegs.get( k );
					if ( ! c ) this.streetSegs.set( k, c = [] );
					c.push( [ a, b ] );

				}

			}

		}

		for ( const f of list ) this._building( f, rand );
		for ( const p of this.passages ) this._passageBody( p, rand );
		this._slabPath( [ [ - 58.5, 236.4 ], [ - 58.7, 241.1 ], [ - 56.6, 246.5 ], [ - 54.6, 261 ] ] );
		// a narrower one through Porta do Vale's hall and out of it (photo references/...-img-4407)
		if ( walls?.valePath ) this._slabPath( walls.valePath, 0.62, 0.03 );
		// the line of pale stones between Rua Dom João de Ornelas' setts and the worn strip by the curtain
		if ( terrain.ornelasEast ) this._stoneLine( terrain.ornelasEast.guide );
		// the Passo da Porta da Vila's dressed stone (Walls._passoPortal): smooth, pale cream
		if ( walls?.passo ) {

			this.walls.color = srgbToLinear( [ 0.93, 0.88, 0.76 ] );
			for ( const b of walls.passo ) {

				this.walls.vdata = [ b.sx, 1, 0.37, 0 ]; // no windows
				this.walls.box( b.x, b.y, b.z, b.sx, b.sy, b.sz, b.yaw, 'bottom' );

			}

		}

		if ( walls?.casaTerrace ) for ( const pts of walls.casaTerrace.lines ) this._parapet( { ...walls.casaTerrace, pts }, PAINT[ 298902328 ] );
		this._ornelasFronts( list );
		this._ornelasGardenWall();
		this._ornelasFork( list );
		this.edges = list;
		this._lanterns( materials, rand );

		for ( const [ kit, mat, name ] of [ [ this.walls, materials.plaster, 'town-walls' ], [ this.roofs, materials.roof, 'town-roofs' ] ] ) {

			if ( kit.empty ) continue;
			const mesh = new Mesh( kit.build(), mat );
			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.staticVelocity = true;
			this.group.add( mesh );

		}

		scene.add( this.group );

	}

	// Wall lanterns along the lanes (every ~22 m, on the nearest house wall, 3.3 m up), lit from
	// dusk: a small iron lantern with glowing glass, and a light source for LocalLights.
	_lanterns( materials, rand ) {

		const T = this.terrain;
		const kit = new MeshKit();
		const warm = new Color( 1.0, 0.66, 0.36 );
		const SPACING = 22;
		const placed = [];
		for ( const st of OSM.streets ) {

			if ( ! /pedestrian|residential|living_street|steps|service|footway/.test( st.highway ) ) continue;
			let carry = SPACING * 0.5;
			for ( let i = 0; i + 1 < st.pts.length; i ++ ) {

				const a = st.pts[ i ], b = st.pts[ i + 1 ];
				const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
				let t = carry;
				while ( t < L ) {

					const x = a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t / L, z = a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t / L;
					t += SPACING;
					if ( Math.hypot( x, z * 0.7 ) > 520 ) continue;
					if ( placed.some( ( p ) => Math.hypot( p[ 0 ] - x, p[ 1 ] - z ) < 12 ) ) continue;
					const wall = this._nearestWallEdge( x, z, 5 );
					if ( ! wall ) continue;
					const { px, pz, nx, nz } = wall;
					const g = T.heightAt( px + nx, pz + nz );
					const lx = px + nx * 0.32, lz = pz + nz * 0.32, ly = g + 3.3;
					placed.push( [ x, z ] );
					const yaw = Math.atan2( - nz, nx );
					// bracket, cap, glass, base
					kit.vdata = [ 0, 0, 0, 0 ];
					kit.box( px + nx * 0.17, ly + 0.28, pz + nz * 0.17, 0.34, 0.04, 0.04, yaw );
					kit.box( lx, ly + 0.2, lz, 0.26, 0.05, 0.26, yaw );
					kit.box( lx, ly - 0.2, lz, 0.2, 0.05, 0.2, yaw );
					kit.vdata = [ 1, 0, 0, 0 ];
					kit.box( lx, ly, lz, 0.2, 0.36, 0.2, yaw, 'top bottom' );
					this.lights.push( { position: new Vector3( lx + nx * 0.25, ly - 0.05, lz + nz * 0.25 ), color: warm, intensity: 7, range: 13, kind: 'lantern', flicker: 0.05 } );

				}

				carry = t - L;

			}

		}

		// the big lantern the photo shows on the blue house going up Rua Dom João de Ornelas
		if ( this.blueLantern ) {

			const { x, z, wx, wz, y, yaw } = this.blueLantern;
			kit.vdata = [ 0, 0, 0, 0 ];
			kit.box( ( x + wx ) / 2, y + 0.42, ( z + wz ) / 2, 0.04, 0.05, Math.hypot( x - wx, z - wz ), Math.atan2( x - wx, z - wz ) );
			kit.box( x, y + 0.27, z, 0.34, 0.05, 0.34, yaw );
			kit.box( x, y + 0.36, z, 0.14, 0.12, 0.14, yaw );
			kit.box( x, y - 0.24, z, 0.18, 0.05, 0.18, yaw );
			const cos = Math.cos( yaw ), sin = Math.sin( yaw );
			for ( const [ u, v ] of [ [ 1, 1 ], [ 1, - 1 ], [ - 1, 1 ], [ - 1, - 1 ] ] ) kit.box( x + ( u * cos + v * sin ) * 0.115, y, z + ( v * cos - u * sin ) * 0.115, 0.03, 0.5, 0.03, yaw );
			kit.vdata = [ 1, 0, 0, 0 ];
			kit.box( x, y, z, 0.22, 0.46, 0.22, yaw, 'top bottom' );
			this.lights.push( { position: new Vector3( x, y - 0.05, z ), color: warm, intensity: 7, range: 13, kind: 'lantern', flicker: 0.05 } );

		}

		if ( kit.empty ) return;
		const mesh = new Mesh( kit.build(), materials.lantern );
		mesh.name = 'lanterns';
		mesh.castShadow = false;
		mesh.receiveShadow = true;
		mesh.staticVelocity = true;
		this.group.add( mesh );

	}

	// nearest house wall to (x, z) within r: the closest point and the wall's outward normal
	_nearestWallEdge( x, z, r ) {

		let best = null, bd = r;
		const key = Math.floor( x / 20 ) * 73856093 ^ Math.floor( z / 20 ) * 19349663;
		for ( const f of this.grid.get( key ) || [] ) {

			const P = f.poly;
			for ( let i = 0; i < P.length; i ++ ) {

				const a = P[ i ], b = P[ ( i + 1 ) % P.length ];
				const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ], L2 = dx * dx + dz * dz;
				if ( L2 < 1 ) continue;
				const t = Math.max( 0.1, Math.min( 0.9, ( ( x - a[ 0 ] ) * dx + ( z - a[ 1 ] ) * dz ) / L2 ) );
				const px = a[ 0 ] + dx * t, pz = a[ 1 ] + dz * t;
				const d = Math.hypot( x - px, z - pz );
				if ( d < bd ) {

					const L = Math.sqrt( L2 );
					// outward for the counter-clockwise footprints; must face the street point
					const nx = dz / L, nz = - dx / L;
					if ( ( x - px ) * nx + ( z - pz ) * nz <= 0 ) continue;
					bd = d;
					best = { px, pz, nx, nz };

				}

			}

		}

		return best;

	}

	// A path of big pale limestone slabs set in the setts (the one across the square to Porta da Vila, as in
	// the photo): about a metre wide (or width), each slab 0.5-0.9 m long, nudged a little left or right of the
	// line (up to nudge either way).
	_slabPath( pts, width = 1, nudge = 0.15 ) {

		const T = this.terrain, kit = this.walls, rand = mulberry32( 2207 );
		kit.color = srgbToLinear( [ 0.82, 0.8, 0.74 ] );
		for ( let i = 0; i + 1 < pts.length; i ++ ) {

			const a = pts[ i ], b = pts[ i + 1 ];
			const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ), ux = ( b[ 0 ] - a[ 0 ] ) / L, uz = ( b[ 1 ] - a[ 1 ] ) / L;
			const yaw = Math.atan2( - uz, ux );
			for ( let d = 0; d < L - 0.3; ) {

				const len = Math.min( 0.5 + rand() * 0.4, L - d ), w = ( 0.85 + rand() * 0.3 ) * width, off = ( rand() - 0.5 ) * 2 * nudge;
				const x = a[ 0 ] + ux * ( d + len / 2 ) - uz * off, z = a[ 1 ] + uz * ( d + len / 2 ) + ux * off;
				const y = T.heightAt( x, z );
				kit.vdata = [ len, 1, rand(), 0 ]; // no windows
				kit.box( x, y - 0.05, z, len - 0.03, 0.14, w, yaw, 'bottom' );
				d += len;

			}

		}

	}

	// for a street front laid over footprint f's wall along the line FRONT: its points (t metres along), the
	// ground, its plaster, and flat-painted parts, openings and pots standing out from it. The street is on the
	// side away from the footprint, unless streetSign says (a line closing off a yard, with the yard behind it)
	_frontTools( f, FRONT, streetSign = 0 ) {

		const T = this.terrain, kit = this.walls;
		const at = ( t ) => {

			let t0 = 0, i = 0;
			for ( ; i + 2 < FRONT.length; i ++ ) {

				const L = Math.hypot( FRONT[ i + 1 ][ 0 ] - FRONT[ i ][ 0 ], FRONT[ i + 1 ][ 1 ] - FRONT[ i ][ 1 ] );
				if ( t <= t0 + L ) break;
				t0 += L;

			}

			const a = FRONT[ i ], b = FRONT[ i + 1 ], L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ), ux = ( b[ 0 ] - a[ 0 ] ) / L, uz = ( b[ 1 ] - a[ 1 ] ) / L;
			return { x: a[ 0 ] + ux * ( t - t0 ), z: a[ 1 ] + uz * ( t - t0 ), ux, uz, nx: - uz, nz: ux, yaw: Math.atan2( - uz, ux ) };

		};
		const sign = streetSign || ( pointInPolygon( at( 1 ).x + at( 1 ).nx * 0.5, at( 1 ).z + at( 1 ).nz * 0.5, f.poly ) ? - 1 : 1 );
		const out = ( t, d ) => {

			const p = at( t );
			return [ p.x + p.nx * sign * d, p.z + p.nz * sign * d ];

		};
		const ground = ( t ) => T.heightAt( ...out( t, 0.6 ) );
		// the plaster, a little proud of the wall, its foot painted and following the street
		const plaster = ( t0, t1, paint, seed ) => {

			const A = out( t0, 0.03 ), C = out( t1, 0.03 ), L = t1 - t0, ga = ground( t0 ), gc = ground( t1 ), g = Math.min( ga, gc ), base = f.base;
			const ha = f.roofH( A[ 0 ], A[ 1 ] ), hc = f.roofH( C[ 0 ], C[ 1 ] );
			kit.color = srgbToLinear( paint );
			kit.vdata = [ L, 1, seed, Math.max( - 0.95, Math.min( 0.95, ( gc - ga ) / L ) ) * 0.4 ];
			const p = at( ( t0 + t1 ) / 2 );
			kit.quadFacing( [ A[ 0 ], base, A[ 1 ] ], [ C[ 0 ], base, C[ 1 ] ], [ C[ 0 ], hc, C[ 1 ] ], [ A[ 0 ], ha, A[ 1 ] ], [ p.nx * sign, 0, p.nz * sign ],
				[ [ 0, base - g ], [ L, base - g ], [ L, hc - g ], [ 0, ha - g ] ] );

		};
		// flat-painted boxes standing out from the front, from t0 to t1, y0 to y1
		const PAINTED = [ 0, 0, 0.53, 4 ];
		const part = ( t0, t1, y0, y1, proud, c ) => {

			const [ x, z ] = out( ( t0 + t1 ) / 2, proud / 2 );
			kit.color = c;
			kit.vdata = PAINTED;
			kit.box( x, ( y0 + y1 ) / 2, z, t1 - t0, y1 - y0, proud, at( ( t0 + t1 ) / 2 ).yaw, 'bottom' );

		};
		const STONE = srgbToLinear( [ 0.72, 0.67, 0.56 ] );
		const GLASS = srgbToLinear( [ 0.07, 0.09, 0.11 ] ), DOOR = srgbToLinear( [ 0.08, 0.12, 0.28 ] ), BARS = srgbToLinear( [ 0.9, 0.9, 0.87 ] );
		const opening = ( t, y0, w, h, isDoor, door = DOOR, bars = BARS ) => {

			const F = 0.14;
			part( t - w / 2, t + w / 2, y0, y0 + h, 0.06, isDoor ? door : GLASS );
			if ( ! isDoor ) {

				part( t - 0.025, t + 0.025, y0, y0 + h, 0.075, bars );
				for ( const k of [ 0.33, 0.66 ] ) part( t - w / 2, t + w / 2, y0 + h * k - 0.02, y0 + h * k + 0.02, 0.075, bars );

			}

			part( t - w / 2 - F, t - w / 2, y0 - ( isDoor ? 0.2 : 0 ), y0 + h + F, 0.1, STONE );
			part( t + w / 2, t + w / 2 + F, y0 - ( isDoor ? 0.2 : 0 ), y0 + h + F, 0.1, STONE );
			part( t - w / 2, t + w / 2, y0 + h, y0 + h + F, 0.1, STONE );
			if ( ! isDoor ) part( t - w / 2 - F - 0.05, t + w / 2 + F + 0.05, y0 - 0.09, y0, 0.22, STONE );

		};
		// a pot on a sill: terracotta, leaves, a few flowers
		const pot = ( t, y, seed ) => {

			const r = mulberry32( seed );
			part( t - 0.1, t + 0.1, y, y + 0.17, 0.3, srgbToLinear( [ 0.66, 0.34, 0.2 ] ) );
			for ( let i = 0; i < 7; i ++ ) {

				const dt = ( r() - 0.5 ) * 0.34, dy = r() * 0.24, s = 0.05 + r() * 0.05, flower = i > 3;
				const c = flower ? srgbToLinear( [ 0.85, 0.12, 0.14 ] ) : srgbToLinear( [ 0.2, 0.38, 0.14 ] );
				part( t + dt - s, t + dt + s, y + 0.17 + dy, y + 0.17 + dy + s * 2, 0.26 + r() * 0.08, c );

			}

		};
		return { at, out, ground, plaster, part, opening, pot, STONE };

	}

	// Rua Dom João de Ornelas going up from the curtain's corner (photo references/...-img-4391), over the long
	// footprint's street walls: the blue house, a blue foot, corner pilasters and frieze, stone window frames, pots
	// on the sills; then the white one, a yellow pilaster where it starts, a stone ledge along the first floor,
	// pots on it. Each opening is placed as in the photo, so these fronts cover the wall's regular rhythm.
	_ornelasFronts( list ) {

		const f = list.find( ( q ) => q.b.id === 299088554 );
		if ( ! f ) return;
		const FRONT = [ [ 66.4, 118.9 ], [ 57.7, 125.3 ], [ 50, 129.3 ] ], BLUE_END = 6.8, BEND = Math.hypot( 8.7, 6.4 ), END = BEND + Math.hypot( 7.7, 4 );
		const { at, out, ground, plaster, part, opening, pot, STONE } = this._frontTools( f, FRONT );
		const BLUE = srgbToLinear( [ 0.08, 0.2, 0.72 ] ), YELLOW = srgbToLinear( [ 0.88, 0.66, 0.2 ] ), WHITE = srgbToLinear( [ 0.92, 0.91, 0.87 ] );
		for ( const [ t0, t1, paint, seed ] of [ [ 0, BLUE_END, [ 0.08, 0.2, 0.72 ], 0.0722 ], [ BLUE_END, BEND, [ 0.93, 0.92, 0.89 ], 0.31 ], [ BEND, END, [ 0.93, 0.92, 0.89 ], 0.37 ] ] ) plaster( t0, t1, paint, seed );

		const eave = ( t ) => f.roofH( ...out( t, 0.1 ) );
		// the blue house: its door and two windows, three windows over them
		part( 0, 0.7, f.base, eave( 0 ), 0.14, BLUE ); // the corner pilaster
		part( BLUE_END - 0.35, BLUE_END, f.base, eave( BLUE_END ), 0.12, BLUE );
		part( 0, BLUE_END, eave( 3 ) - 1.2, eave( 3 ) - 0.8, 0.08, BLUE ); // the frieze's bands
		part( 0, BLUE_END, eave( 3 ) - 0.32, eave( 3 ), 0.22, BLUE );
		const g = ( t ) => ground( t );
		opening( 2.3, g( 2.3 ), 1.1, 2.3, true );
		opening( 4, g( 4 ) + 0.95, 0.72, 1.2, false );
		opening( 5.5, g( 5.5 ) + 0.95, 0.62, 1.2, false );
		const upBlue = 40;
		for ( const [ i, t ] of [ 1.9, 3.8, 5.45 ].entries() ) {

			opening( t, upBlue, 0.78, 1.35, false );
			pot( t - 0.22, upBlue, 11 + i );
			pot( t + 0.22, upBlue, 21 + i );

		}

		// the white house: a yellow pilaster, doors and windows, a stone ledge, four windows over it
		part( BLUE_END, BLUE_END + 0.25, f.base, eave( BLUE_END ), 0.08, YELLOW );
		part( END - 2.6, END - 2.4, f.base, eave( END - 2.5 ), 0.06, YELLOW );
		for ( const [ t, door ] of [ [ 8.2, true ], [ 9.6, false ], [ 12.1, false ], [ 13.6, true ], [ 15.2, false ], [ 16.7, true ] ] ) door ? opening( t, g( t ), 1, 2.2, true ) : opening( t, g( t ) + 0.95, 0.68, 1.15, false );
		const ledge = 40.35, upWhite = 40.8;
		part( BLUE_END + 0.25, BEND - 0.02, ledge - 0.1, ledge, 0.28, STONE );
		part( BEND + 0.02, 15, ledge - 0.1, ledge, 0.28, STONE );
		for ( const [ i, t ] of [ 8.3, 9.9, 12.1, 13.7 ].entries() ) {

			opening( t, upWhite, 0.72, 1.2, false );
			pot( t + 0.75, ledge, 31 + i );

		}

		// the white house's roof stands a little over the blue one's, its tiles older and greyer: laid over the
		// footprint's single roof from the cornice to the ridge. The cornice and its course of tiles follow the eave.
		const kit = this.walls, LIFT = 0.25, TILE = srgbToLinear( [ 0.5, 0.3, 0.22 ] );
		const band = ( t0, t1, y0, y1, proud, c ) => {

			const A = out( t0, proud ), C = out( t1, proud ), A0 = out( t0, 0 ), C0 = out( t1, 0 ), ya = eave( t0 ), yc = eave( t1 ), p = at( ( t0 + t1 ) / 2 ), n = out( ( t0 + t1 ) / 2, 1 ), m = out( ( t0 + t1 ) / 2, 0 );
			const want = [ n[ 0 ] - m[ 0 ], 0, n[ 1 ] - m[ 1 ] ], uv = [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ];
			kit.color = c;
			kit.vdata = [ 0, 0, 0.53, 4 ];
			kit.quadFacing( [ A[ 0 ], ya + y0, A[ 1 ] ], [ C[ 0 ], yc + y0, C[ 1 ] ], [ C[ 0 ], yc + y1, C[ 1 ] ], [ A[ 0 ], ya + y1, A[ 1 ] ], want, uv );
			kit.quadFacing( [ A[ 0 ], ya + y1, A[ 1 ] ], [ C[ 0 ], yc + y1, C[ 1 ] ], [ C0[ 0 ], yc + y1, C0[ 1 ] ], [ A0[ 0 ], ya + y1, A0[ 1 ] ], [ 0, 1, 0 ], uv );
			kit.quadFacing( [ A[ 0 ], ya + y0, A[ 1 ] ], [ C[ 0 ], yc + y0, C[ 1 ] ], [ C0[ 0 ], yc + y0, C0[ 1 ] ], [ A0[ 0 ], ya + y0, A0[ 1 ] ], [ 0, - 1, 0 ], uv );
			kit.quadFacing( [ A[ 0 ], ya + y0, A[ 1 ] ], [ A0[ 0 ], ya + y0, A0[ 1 ] ], [ A0[ 0 ], ya + y1, A0[ 1 ] ], [ A[ 0 ], ya + y1, A[ 1 ] ], [ - p.ux, 0, - p.uz ], uv );

		};
		for ( const [ t0, t1 ] of [ [ BLUE_END, BEND ], [ BEND, END ] ] ) {

			band( t0, t1, - 0.22, LIFT, 0.27, WHITE );
			band( t0, t1, LIFT, LIFT + 0.1, 0.36, TILE );

		}

		{

			const roof = this.roofs;
			const toRidge = ( t ) => {

				let d = 0;
				while ( d < 9 && pointInPolygon( ...out( t, - d - 0.2 ), f.poly ) && f.roofH( ...out( t, - d - 0.2 ) ) > f.roofH( ...out( t, - d ) ) + 0.001 ) d += 0.2;
				return d;

			};
			const rows = [ BLUE_END, BEND, END ].map( ( t ) => {

				const z = out( t, 0 ), r = out( t, - toRidge( t ) );
				return { front: [ z[ 0 ], f.roofH( ...z ) + LIFT + 0.08, z[ 1 ] ], ridge: [ r[ 0 ], f.roofH( ...r ) + LIFT, r[ 1 ] ], t };

			} );
			roof.color = [ 0.74, 0.72, 0.7 ];
			roof.vdata = [ 0.71, 0.95, 0, 0 ];
			for ( let i = 0; i + 1 < rows.length; i ++ ) {

				const a = rows[ i ], b = rows[ i + 1 ], D = Math.hypot( a.ridge[ 0 ] - a.front[ 0 ], a.ridge[ 2 ] - a.front[ 2 ] );
				roof.quadFacing( a.front, b.front, b.ridge, a.ridge, [ 0, 1, 0 ], [ [ a.t, D ], [ b.t, D ], [ b.t, 0 ], [ a.t, 0 ] ] );

			}

			// its end over the blue house's roof
			const a = rows[ 0 ];
			roof.quadFacing( a.front, a.ridge, [ a.ridge[ 0 ], a.ridge[ 1 ] - LIFT, a.ridge[ 2 ] ], [ a.front[ 0 ], a.front[ 1 ] - LIFT, a.front[ 2 ] ], [ - at( BLUE_END ).ux, 0, - at( BLUE_END ).uz ], [ [ 0, 0 ], [ 3, 0 ], [ 3, 0.25 ], [ 0, 0.25 ] ] );

		}

		// the lantern on the blue house, on its bracket by the corner, a pot hanging under it (lit in Town._lanterns)
		pot( 1, 40.75, 61 );
		part( 0.96, 1.04, 40.98, 41.02, 0.45, srgbToLinear( [ 0.1, 0.1, 0.1 ] ) );
		const [ lx, lz ] = out( 1, 0.62 ), [ wx, wz ] = out( 1, 0 );
		this.blueLantern = { x: lx, z: lz, wx, wz, y: 41.1, yaw: at( 1 ).yaw };

	}

	// ORNELAS_EAST's wall: whitewashed, a yellow foot that follows the street, its top level (the garden's edge),
	// 1.7 m over the street at the corner and meeting it where the street has climbed.
	_ornelasGardenWall() {

		const E = this.terrain.ornelasEast;
		if ( ! E ) return;
		this._footedWall( E.wall, E.top );
		// the drainpipe down the curtain just short of the wall, turning out at its foot
		const kit = this.walls, x = 59.99, z = 114.2, g = this.terrain.heightAt( x, z ), nx = 0.368, nz = 0.93;
		kit.vdata = [ 0, 0, 0.53, 4 ];
		kit.color = srgbToLinear( [ 0.2, 0.21, 0.22 ] );
		kit.box( x, g + 1.75, z, 0.07, 3.3, 0.07, 0, 'bottom' );
		kit.box( x + nx * 0.1, g + 0.13, z + nz * 0.1, 0.09, 0.09, 0.28, Math.atan2( nx, nz ), 'bottom' );
		for ( const y of [ 1.1, 2.3, 3.3 ] ) kit.box( x - nx * 0.05, g + y, z - nz * 0.05, 0.14, 0.04, 0.14, 0 );

	}

	// a whitewashed wall along pts, its outside on the left going along (x, z), a yellow foot following the
	// ground, its top level
	_footedWall( wall, top ) {

		const T = this.terrain, kit = this.walls, TH = 0.6;
		kit.color = srgbToLinear( [ 0.88, 0.66, 0.2 ] );
		for ( let i = 0; i + 1 < wall.length; i ++ ) {

			const a = wall[ i ], c = wall[ i + 1 ], L = Math.hypot( c[ 0 ] - a[ 0 ], c[ 1 ] - a[ 1 ] );
			const ux = ( c[ 0 ] - a[ 0 ] ) / L, uz = ( c[ 1 ] - a[ 1 ] ) / L;
			// outward, the street's side
			const nx = uz, nz = - ux;
			const ga = T.heightAt( a[ 0 ] + nx * 0.4, a[ 1 ] + nz * 0.4 ), gc = T.heightAt( c[ 0 ] + nx * 0.4, c[ 1 ] + nz * 0.4 ), g = Math.min( ga, gc ), base = g - 0.8;
			const slope = Math.max( - 0.95, Math.min( 0.95, ( gc - ga ) / L ) );
			const p = ( q, d ) => [ q[ 0 ] - nx * d, q[ 1 ] - nz * d ];
			const B = [ p( a, TH ), p( c, TH ) ];
			kit.vdata = [ L, 1, 0.073, slope * 0.4 ];
			kit.quadFacing( [ a[ 0 ], base, a[ 1 ] ], [ c[ 0 ], base, c[ 1 ] ], [ c[ 0 ], top, c[ 1 ] ], [ a[ 0 ], top, a[ 1 ] ], [ nx, 0, nz ],
				[ [ 0, base - g ], [ L, base - g ], [ L, top - g ], [ 0, top - g ] ] );
			// its back and top, white (well above the foot); the end at the street's far corner
			kit.vdata = [ L, 1, 0.073, 0 ];
			kit.quadFacing( [ B[ 0 ][ 0 ], base, B[ 0 ][ 1 ] ], [ B[ 1 ][ 0 ], base, B[ 1 ][ 1 ] ], [ B[ 1 ][ 0 ], top, B[ 1 ][ 1 ] ], [ B[ 0 ][ 0 ], top, B[ 0 ][ 1 ] ], [ - nx, 0, - nz ],
				[ [ 0, 3 ], [ L, 3 ], [ L, 5 ], [ 0, 5 ] ] );
			kit.quadFacing( [ a[ 0 ], top, a[ 1 ] ], [ c[ 0 ], top, c[ 1 ] ], [ B[ 1 ][ 0 ], top, B[ 1 ][ 1 ] ], [ B[ 0 ][ 0 ], top, B[ 0 ][ 1 ] ], [ 0, 1, 0 ],
				[ [ 0, 5 ], [ L, 5 ], [ L, 5.6 ], [ 0, 5.6 ] ] );
			if ( i === wall.length - 2 ) kit.quadFacing( [ c[ 0 ], base, c[ 1 ] ], [ B[ 1 ][ 0 ], base, B[ 1 ][ 1 ] ], [ B[ 1 ][ 0 ], top, B[ 1 ][ 1 ] ], [ c[ 0 ], top, c[ 1 ] ], [ ux, 0, uz ],
				[ [ 0, 3 ], [ TH, 3 ], [ TH, 5 ], [ 0, 5 ] ] );
			this.colliders.addBox( new Vector3( ( a[ 0 ] + c[ 0 ] ) / 2 - nx * TH / 2, ( base + top ) / 2, ( a[ 1 ] + c[ 1 ] ) / 2 - nz * TH / 2 ), new Vector3( L / 2, ( top - base ) / 2, TH / 2 ), Math.atan2( - uz, ux ), { walkable: false, tag: 'wall' } );

		}

	}

	// the fork at the end of the climb down the curtain (photo references/...-img-4390): the two houses before it,
	// the wall between the streets, the long low house past it with its green gate, the signs
	_ornelasFork( list ) {

		const E = this.terrain.ornelasEast, find = ( id ) => list.find( ( q ) => q.b.id === id );
		if ( ! E ) return;
		const T = this.terrain, kit = this.walls;
		const YELLOW = srgbToLinear( [ 0.88, 0.66, 0.2 ] ), CREAM = srgbToLinear( [ 0.92, 0.86, 0.71 ] ), WOOD = srgbToLinear( [ 0.2, 0.12, 0.07 ] ), FRAME = srgbToLinear( [ 0.3, 0.36, 0.28 ] );
		const GREEN = srgbToLinear( [ 0.36, 0.6, 0.48 ] ), GREEN_DARK = srgbToLinear( [ 0.25, 0.44, 0.35 ] ), WHITE = srgbToLinear( [ 0.93, 0.92, 0.88 ] ), BLUE = srgbToLinear( [ 0.08, 0.25, 0.68 ] );
		this._footedWall( E.forkWall, E.forkTop );

		// the house with the steps: cream over a yellow foot, a yellow pilaster at its far corner
		const h1 = find( 299088474 );
		if ( h1 ) {

			const L = Math.hypot( 1.5, 6.7 ), { at, out, ground: g, part, opening, pot, STONE } = this._frontTools( h1, [ [ 75.7, 109.4 ], [ 77.2, 102.7 ] ] );
			const A = out( 0, 0.03 ), C = out( L, 0.03 ), ha = h1.roofH( A[ 0 ], A[ 1 ] ), hc = h1.roofH( C[ 0 ], C[ 1 ] ), p = at( 1 ), n = out( 1, 1 ), o = out( 1, 0 ), want = [ n[ 0 ] - o[ 0 ], 0, n[ 1 ] - o[ 1 ] ];
			kit.color = CREAM;
			kit.vdata = [ 0, 0, 0.53, 4 ];
			kit.quadFacing( [ A[ 0 ], h1.base, A[ 1 ] ], [ C[ 0 ], h1.base, C[ 1 ] ], [ C[ 0 ], hc, C[ 1 ] ], [ A[ 0 ], ha, A[ 1 ] ], want, [ [ 0, 0 ], [ L, 0 ], [ L, 1 ], [ 0, 1 ] ] );
			const FA = out( 0, 0.05 ), FC = out( L, 0.05 ), ga = g( 0 ), gc = g( L ), FOOT = 0.85;
			kit.color = YELLOW;
			kit.quadFacing( [ FA[ 0 ], h1.base, FA[ 1 ] ], [ FC[ 0 ], h1.base, FC[ 1 ] ], [ FC[ 0 ], gc + FOOT, FC[ 1 ] ], [ FA[ 0 ], ga + FOOT, FA[ 1 ] ], want, [ [ 0, 0 ], [ L, 0 ], [ L, 1 ], [ 0, 1 ] ] );
			part( L - 0.34, L, h1.base, h1.roofH( ...out( L, 0.1 ) ), 0.1, YELLOW );
			const DOOR_T = 5, up = g( DOOR_T ) + 2.95;
			// the door over two worn steps, a window beside it, two over them, a pot on its hoop
			const stepY = g( DOOR_T + 1 ) + 0.02;
			part( DOOR_T - 1.1, DOOR_T + 1.1, h1.base, stepY + 0.17, 1.05, STONE );
			part( DOOR_T - 0.95, DOOR_T + 0.95, h1.base, stepY + 0.34, 0.55, STONE );
			{

				const yaw = at( DOOR_T ).yaw, foot = stepY - 0.4;
				for ( const [ proud, half, top ] of [ [ 1.05, 1.1, 0.17 ], [ 0.55, 0.95, 0.34 ] ] ) {

					const [ cx, cz ] = out( DOOR_T, proud / 2 ), y1 = stepY + top;
					this.colliders.addBox( new Vector3( cx, ( foot + y1 ) / 2, cz ), new Vector3( half, ( y1 - foot ) / 2, proud / 2 ), yaw, { walkable: true, tag: 'stair' } );

				}

			}

			opening( DOOR_T, stepY + 0.34, 1, 2.2, true, WOOD );
			opening( 2.2, g( 2.2 ) + 1, 0.8, 1.2, false, undefined, FRAME );
			opening( DOOR_T, up, 0.85, 1.2, false, undefined, FRAME );
			opening( 2.2, up, 0.85, 1.2, false, undefined, FRAME );
			pot( DOOR_T + 1, up + 0.65, 51 );

		}

		// the low one after it: a blue foot, one window with wooden shutters, a meter box
		const h2 = find( 299088432 );
		if ( h2 ) {

			const L = Math.hypot( 2.4, 5.2 ), { ground: g, plaster, part, opening } = this._frontTools( h2, [ [ 77.2, 102.7 ], [ 79.6, 97.5 ] ] );
			plaster( 0, L, [ 0.13, 0.24, 0.6 ], 0.073 );
			opening( 3.1, g( 3.1 ) + 1.05, 0.8, 1.1, false, undefined, WOOD );
			part( 1.2, 1.55, g( 1.2 ) + 0.6, g( 1.2 ) + 1.05, 0.05, srgbToLinear( [ 0.78, 0.76, 0.7 ] ) );

		}

		// the long one: white, a yellow foot, the wall across its yard's mouth carrying on its line; the green gate
		// in that; a blue sign on the wall beside it; on the stone wall's
		// return (Walls._ornelasForkStone) a tile plaque and a lamp
		const h3 = find( 299088405 );
		if ( h3 ) {

			const LINE = [ [ 83.4, 81.4 ], [ 81.8, 68.8 ], [ 83.3, 51.6 ] ], B = Math.hypot( 1.6, 12.6 ), END = B + Math.hypot( 1.5, 17.2 );
			const { ground: g, plaster, part } = this._frontTools( h3, LINE, - 1 );
			this.colliders.addBox( new Vector3( 82.6, g( 6 ) + 1, 75.1 ), new Vector3( 6.35, 3, 0.2 ), Math.atan2( 0.992, - 0.126 ), { walkable: false, tag: 'wall' } );
			plaster( 0, B, [ 0.88, 0.66, 0.2 ], 0.073 );
			plaster( B, END, [ 0.88, 0.66, 0.2 ], 0.073 );
			const y0 = g( 3.1 ) - 0.1, t0 = 0.9, t1 = 5.4;
			part( t0, t1, y0, y0 + 2.5, 0.08, GREEN );
			for ( let t = t0 + 0.14; t < t1; t += 0.28 ) part( t - 0.02, t + 0.02, y0, y0 + 2.5, 0.1, GREEN_DARK );
			part( ( t0 + t1 ) / 2 - 0.04, ( t0 + t1 ) / 2 + 0.04, y0, y0 + 2.5, 0.12, GREEN_DARK );
			for ( const y of [ 0.15, 1.2, 2.4 ] ) part( t0, t1, y0 + y - 0.05, y0 + y + 0.05, 0.12, GREEN_DARK );
			part( 6.9, 7.4, g( 7 ) + 1.9, g( 7 ) + 2.4, 0.05, BLUE );
			part( 7.08, 7.22, g( 7 ) + 1.98, g( 7 ) + 2.28, 0.06, WHITE );

			const R = this._frontTools( h3, [ [ 83.4, 81.4 ], [ 86, 83.1 ] ] ), gr = R.ground( 1.5 ) + 0.2;
			R.part( 0.7, 1.6, gr + 1.5, gr + 2.05, 0.3, WHITE );
			R.part( 0.8, 1.5, gr + 1.6, gr + 1.95, 0.32, BLUE );
			R.part( 2.25, 2.4, gr + 1.95, gr + 2.3, 0.45, srgbToLinear( [ 0.12, 0.12, 0.12 ] ) );
			R.part( 2.27, 2.38, gr + 1.65, gr + 1.95, 0.45, srgbToLinear( [ 0.86, 0.84, 0.72 ] ) );

		}

		// the small round metal lid set in the setts near the climb's start
		{

			const x = 72.1, z = 107.5, y = T.heightAt( x, z ) + 0.02, n = 12;
			kit.vdata = [ 0, 0, 0.53, 4 ];
			for ( const [ r, up, c ] of [ [ 0.09, 0, [ 0.1, 0.1, 0.1 ] ], [ 0.06, 0.004, [ 0.3, 0.31, 0.3 ] ] ] ) {

				kit.color = srgbToLinear( c );
				for ( let i = 0; i < n; i ++ ) {

					const a0 = i / n * Math.PI * 2, a1 = ( i + 1 ) / n * Math.PI * 2;
					kit.tri( [ x, y + up, z ], [ x + Math.cos( a1 ) * r, y + up, z + Math.sin( a1 ) * r ], [ x + Math.cos( a0 ) * r, y + up, z + Math.sin( a0 ) * r ], [ [ 0, 0 ], [ 0, 0 ], [ 0, 0 ] ], [ 0, 1, 0 ] );

				}

			}

		}

		// the round sign by the curtain, on its post, seen from behind going down
		{

			const x = 71.1, z = 98.8, y = T.heightAt( x, z ), GREY = srgbToLinear( [ 0.36, 0.37, 0.37 ] ), r = 0.31, n = 6;
			kit.vdata = [ 0, 0, 0.53, 4 ];
			kit.color = GREY;
			kit.box( x, y + 1.15, z + 0.02, 0.07, 2.3, 0.07, 0, 'bottom' );
			const disc = ( cy, rad, dz, c ) => {

				kit.color = c;
				for ( let i = 0; i < n; i ++ ) {

					const v0 = - rad + 2 * rad * i / n, v1 = v0 + 2 * rad / n, vm = Math.max( Math.abs( v0 ), Math.abs( v1 ) ) * 0.85;
					kit.box( x, cy + ( v0 + v1 ) / 2, z + dz, 2 * Math.sqrt( Math.max( 0, rad * rad - vm * vm ) ), v1 - v0, 0.02, 0, 'bottom' );

				}

			};
			disc( y + 2, r, 0.05, GREY );
			disc( y + 2, r, - 0.01, srgbToLinear( [ 0.75, 0.1, 0.08 ] ) );
			disc( y + 2, r * 0.76, - 0.03, srgbToLinear( [ 0.1, 0.28, 0.72 ] ) );
			this.colliders.addBox( new Vector3( x, y + 1.15, z ), new Vector3( 0.06, 1.15, 0.06 ), 0, { walkable: false, tag: 'sign' } );

		}

	}

	// a line of small pale stones set in the street, lying on its slope
	_stoneLine( pts, width = 0.3 ) {

		const T = this.terrain, kit = this.walls, rand = mulberry32( 4392 );
		for ( let i = 0; i + 1 < pts.length; i ++ ) {

			const a = pts[ i ], b = pts[ i + 1 ];
			const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ), ux = ( b[ 0 ] - a[ 0 ] ) / L, uz = ( b[ 1 ] - a[ 1 ] ) / L;
			for ( let d = 0; d < L - 0.1; ) {

				const len = Math.min( 0.28 + rand() * 0.22, L - d ), hw = width / 2 * ( 0.85 + rand() * 0.3 ), off = ( rand() - 0.5 ) * 0.05, v = 0.6 + rand() * 0.14;
				const P = ( t, s ) => {

					const x = a[ 0 ] + ux * ( d + t ) - uz * ( off + s ), z = a[ 1 ] + uz * ( d + t ) + ux * ( off + s );
					return [ x, T.heightAt( x, z ) + 0.025, z ];

				};
				kit.color = srgbToLinear( [ v, v * 0.96, v * 0.86 ] );
				kit.vdata = [ len, 1, 0.1 + rand() * 0.2, 0 ]; // no windows
				kit.quadFacing( P( 0.02, - hw ), P( len - 0.02, - hw ), P( len - 0.02, hw ), P( 0.02, hw ), [ 0, 1, 0 ], [ [ 0, 0 ], [ len, 0 ], [ len, 0.3 ], [ 0, 0.3 ] ] );
				d += len;

			}

		}

	}

	// a whitewashed wall along pts (the Casa da Música's terrace), with a painted base band, from below the
	// ground up to `top`
	_parapet( { pts, top, thick }, paint ) {

		const T = this.terrain, kit = this.walls;
		kit.color = srgbToLinear( paint );
		for ( let i = 0; i + 1 < pts.length; i ++ ) {

			const a = pts[ i ], c = pts[ i + 1 ];
			const L = Math.hypot( c[ 0 ] - a[ 0 ], c[ 1 ] - a[ 1 ] );
			const ux = ( c[ 0 ] - a[ 0 ] ) / L, uz = ( c[ 1 ] - a[ 1 ] ) / L;
			const nx = - uz * thick / 2, nz = ux * thick / 2; // across the wall
			const g = Math.min( T.heightAt( a[ 0 ], a[ 1 ] ), T.heightAt( c[ 0 ], c[ 1 ] ) );
			const base = g - 0.8;
			kit.vdata = [ L, 1, 0.71 + i, 0 ]; // no windows
			for ( const s of [ - 1, 1 ] ) {

				const A = [ a[ 0 ] + nx * s, a[ 1 ] + nz * s ], C = [ c[ 0 ] + nx * s, c[ 1 ] + nz * s ];
				kit.quadFacing( [ A[ 0 ], base, A[ 1 ] ], [ C[ 0 ], base, C[ 1 ] ], [ C[ 0 ], top, C[ 1 ] ], [ A[ 0 ], top, A[ 1 ] ], [ nx * s, 0, nz * s ],
					[ [ 0, base - g ], [ L, base - g ], [ L, top - g ], [ 0, top - g ] ] );

			}

			kit.quadFacing( [ a[ 0 ] - nx, top, a[ 1 ] - nz ], [ c[ 0 ] - nx, top, c[ 1 ] - nz ], [ c[ 0 ] + nx, top, c[ 1 ] + nz ], [ a[ 0 ] + nx, top, a[ 1 ] + nz ], [ 0, 1, 0 ] );
			for ( const [ e, f ] of [ [ a, - 1 ], [ c, 1 ] ] ) kit.quadFacing( [ e[ 0 ] - nx, base, e[ 1 ] - nz ], [ e[ 0 ] + nx, base, e[ 1 ] + nz ], [ e[ 0 ] + nx, top, e[ 1 ] + nz ], [ e[ 0 ] - nx, top, e[ 1 ] - nz ], [ ux * f, 0, uz * f ] );
			this.colliders.addBox( new Vector3( ( a[ 0 ] + c[ 0 ] ) / 2, ( base + top ) / 2, ( a[ 1 ] + c[ 1 ] ) / 2 ), new Vector3( L / 2, ( top - base ) / 2, thick / 2 ), Math.atan2( - uz, ux ), { walkable: false, tag: 'wall' } );

		}

	}

	_building( f, rand ) {

		const T = this.terrain;
		const { b, poly } = f;
		const isChurch = b.building === 'church' || b.building === 'chapel' || b.amenity === 'place_of_worship';
		const isTower = b.man_made === 'tower';
		const inTown = T.isInsideTown( f.cx, f.cz );
		let gMin = Infinity, gMax = - Infinity;
		for ( const [ x, z ] of poly ) {

			const g = T.heightAt( x, z );
			gMin = Math.min( gMin, g ); gMax = Math.max( gMax, g );

		}

		const gC = T.heightAt( f.cx, f.cz );
		gMin = Math.min( gMin, gC ); gMax = Math.max( gMax, gC );
		// storeys: tagged, or by size (small houses 1-2, bigger 2-3); churches by area
		const tagged = STOREYS[ b.id ] ?? Number( b[ 'building:levels' ] );
		let storeys = tagged > 0 ? tagged : f.area < 60 ? 1 + ( rand() < 0.6 ? 1 : 0 ) : f.area < 160 ? 2 : 2 + ( rand() < 0.3 ? 1 : 0 );
		if ( ! inTown && tagged <= 0 && rand() < 0.3 ) storeys = Math.max( 1, storeys - 1 );
		// the eave from the mean ground (on a slope the downhill side shows a little more wall)
		// (a footprint reaching over the drop at the wall's foot doesn't make the house taller)
		const gLow = Math.max( gMin, gMax - 3.5 );
		let eave = Math.max( ( gLow + gMax ) / 2 + storeys * STOREY + 0.2, gMax + 2.7 );
		if ( isChurch ) eave = gMax + Math.min( 13, 6 + Math.sqrt( f.area ) * 0.5 );
		if ( isTower ) eave = gMax + 16;
		if ( EAVE[ b.id ] ) eave = EAVE[ b.id ];
		const base = gMin - 1.2;

		// roof: gable along the oriented box, ridge through its centre
		const obb = orientedBox( poly );
		const ux = obb.ux, uz = obb.uz; // ridge direction
		const vx = - uz, vz = ux; // across
		const halfW = obb.hz;
		const rise = Math.min( halfW * PITCH, isTower ? 4 : MAX_RISE );
		const flat = halfW - rise / PITCH; // half width of a flat ridge strip (0 normally)
		const local = ( x, z ) => [ ( x - obb.cx ) * ux + ( z - obb.cz ) * uz, ( x - obb.cx ) * vx + ( z - obb.cz ) * vz ];
		const roofH = ( x, z ) => {

			const a = Math.abs( local( x, z )[ 1 ] );
			return eave + Math.max( 0, Math.min( rise, ( halfW - a ) * PITCH ) );

		};

		f.roofH = roofH; // (for a front built over this wall: Town._ornelasFronts)
		f.base = base;

		// split the outline where it crosses a roof crease (the ridge, the flat strip's edges)
		const creases = flat > 0.05 ? [ - flat, flat ] : [ 0 ];
		let outline = poly;
		for ( const c of creases ) outline = splitAt( outline, ( q ) => local( q[ 0 ], q[ 1 ] )[ 1 ] - c );

		// paint
		const tr = rand();
		let acc = 0, trim = TRIMS[ 0 ][ 1 ];
		for ( const [ w, c ] of TRIMS ) {

			acc += w;
			if ( tr < acc ) {

				trim = c;
				break;

			}

		}

		this.walls.color = srgbToLinear( PAINT[ b.id ] || trim );
		const seed = rand();

		// walls
		const kit = this.walls;
		for ( let i = 0; i < outline.length; i ++ ) {

			const a = outline[ i ], c = outline[ ( i + 1 ) % outline.length ];
			const L = Math.hypot( c[ 0 ] - a[ 0 ], c[ 1 ] - a[ 1 ] );
			if ( L < 0.05 ) continue;
			const nx = ( c[ 1 ] - a[ 1 ] ) / L, nz = - ( c[ 0 ] - a[ 0 ] ) / L; // outward for a CCW (x, z) polygon
			const mx = ( a[ 0 ] + c[ 0 ] ) / 2, mz = ( a[ 1 ] + c[ 1 ] ) / 2;
			// a party wall (another house right against it) gets no windows
			const party = this._inOther( mx + nx * 0.8, mz + nz * 0.8, f );
			const ga = T.heightAt( a[ 0 ], a[ 1 ] ), gc = T.heightAt( c[ 0 ], c[ 1 ] ), gEdge = Math.min( ga, gc );
			const facade = ! party && L > 1.6 ? 1 : 0;
			// openings: in storeys above the lowest ground at this edge; the ground's slope along it rides
			// in w (see TownMaterials) so the base band and the street-level doors follow the street
			const st = isChurch ? 1 : Math.max( 1, Math.round( ( eave - gEdge ) / STOREY ) );
			const slope = Math.max( - 0.95, Math.min( 0.95, ( gc - ga ) / L ) );
			kit.vdata = [ L, st, seed + i * 0.137, facade + slope * 0.4 ];
			const ha = roofH( a[ 0 ], a[ 1 ] ), hc = roofH( c[ 0 ], c[ 1 ] );
			kit.quadFacing( [ a[ 0 ], base, a[ 1 ] ], [ c[ 0 ], base, c[ 1 ] ], [ c[ 0 ], hc, c[ 1 ] ], [ a[ 0 ], ha, a[ 1 ] ], [ nx, 0, nz ],
				[ [ 0, base - gEdge ], [ L, base - gEdge ], [ L, hc - gEdge ], [ 0, ha - gEdge ] ] );
			// collider along the edge (not where the house runs under the wall walk: the walk stays clear)
			const onWalk = this.wallsRef && this.wallsRef._nearestWalk( mx, mz, 2.2 );
			// a street running through the footprint passes under the house (Óbidos' arched passages)
			const passage = this._crossesStreet( a, c );
			if ( ! onWalk && ! passage ) this.colliders.addBox( new Vector3( mx - nx * 0.2, ( base + eave ) / 2, mz - nz * 0.2 ), new Vector3( L / 2 + 0.05, ( eave - base ) / 2, 0.2 ), Math.atan2( - ( c[ 1 ] - a[ 1 ] ), c[ 0 ] - a[ 0 ] ), { walkable: false, tag: 'house' } );

		}

		// roof planes: the outline clipped into the strips between creases, each triangulated
		const roof = this.roofs;
		roof.color = [ 1, 1, 1 ];
		roof.vdata = [ seed, inTown ? 0.4 + rand() * 0.5 : rand() * 0.4, 0, 0 ];
		const bands = flat > 0.05 ? [ [ - Infinity, - flat ], [ - flat, flat ], [ flat, Infinity ] ] : [ [ - Infinity, 0 ], [ 0, Infinity ] ];
		const slopeLen = Math.sqrt( 1 + PITCH * PITCH );
		for ( const [ lo, hi ] of bands ) {

			let part = clipBand( outline, ( q ) => local( q[ 0 ], q[ 1 ] )[ 1 ], lo, hi );
			if ( part.length < 3 ) continue;
			const tris = earcut( part );
			for ( const [ i0, i1, i2 ] of tris ) {

				const P = [ part[ i0 ], part[ i1 ], part[ i2 ] ].map( ( q ) => [ q[ 0 ], roofH( q[ 0 ], q[ 1 ] ) + 0.02, q[ 1 ] ] );
				const uv = [ part[ i0 ], part[ i1 ], part[ i2 ] ].map( ( q ) => {

					const [ lx, lz ] = local( q[ 0 ], q[ 1 ] );
					return [ lx, ( Math.abs( lz ) - ( halfW - rise / PITCH ) ) * slopeLen ];

				} );
				// up-facing (the earcut winding follows the outline: counter-clockwise in x, z)
				const n = triNormal( P[ 0 ], P[ 1 ], P[ 2 ] );
				if ( n[ 1 ] < 0 ) roof.tri( P[ 0 ], P[ 2 ], P[ 1 ], [ uv[ 0 ], uv[ 2 ], uv[ 1 ] ], [ - n[ 0 ], - n[ 1 ], - n[ 2 ] ] );
				else roof.tri( P[ 0 ], P[ 1 ], P[ 2 ], uv, n );

			}

		}

		// eaves: a thin tile edge course round the outline, 0.25 m out (the shadow line under the roof)
		for ( let i = 0; i < outline.length; i ++ ) {

			const a = outline[ i ], c = outline[ ( i + 1 ) % outline.length ];
			const L = Math.hypot( c[ 0 ] - a[ 0 ], c[ 1 ] - a[ 1 ] );
			if ( L < 0.05 ) continue;
			const nx = ( c[ 1 ] - a[ 1 ] ) / L, nz = - ( c[ 0 ] - a[ 0 ] ) / L;
			const ha = roofH( a[ 0 ], a[ 1 ] ) + 0.02, hc = roofH( c[ 0 ], c[ 1 ] ) + 0.02;
			const o = 0.28, d = 0.14;
			kit.color = [ 0.93, 0.92, 0.9 ];
			kit.vdata = [ L, 0, 0, 0 ];
			// soffit (white, under the overhang) and the tile edge
			roof.quadFacing( [ a[ 0 ], ha, a[ 1 ] ], [ c[ 0 ], hc, c[ 1 ] ], [ c[ 0 ] + nx * o, hc - d, c[ 1 ] + nz * o ], [ a[ 0 ] + nx * o, ha - d, a[ 1 ] + nz * o ], [ nx * 0.3, 1, nz * 0.3 ],
				[ [ 0, 0 ], [ L, 0 ], [ L, o ], [ 0, o ] ] );
			kit.quadFacing( [ a[ 0 ] + nx * o, ha - d - 0.1, a[ 1 ] + nz * o ], [ c[ 0 ] + nx * o, hc - d - 0.1, c[ 1 ] + nz * o ], [ c[ 0 ], hc - 0.1, c[ 1 ] ], [ a[ 0 ], ha - 0.1, a[ 1 ] ], [ 0, - 1, 0 ],
				[ [ 0, 9 ], [ L, 9 ], [ L, 9 ], [ 0, 9 ] ] );
			roof.quadFacing( [ a[ 0 ] + nx * o, ha - d - 0.1, a[ 1 ] + nz * o ], [ c[ 0 ] + nx * o, hc - d - 0.1, c[ 1 ] + nz * o ], [ c[ 0 ] + nx * o, hc - d, c[ 1 ] + nz * o ], [ a[ 0 ] + nx * o, ha - d, a[ 1 ] + nz * o ], [ nx, 0, nz ],
				[ [ 0, 0 ], [ L, 0 ], [ L, 0.1 ], [ 0, 0.1 ] ] );

		}

		// a chimney on some houses
		if ( ! isChurch && ! isTower && f.area > 25 && rand() < 0.45 ) {

			const t = ( rand() - 0.5 ) * obb.hx * 1.2, s2 = ( rand() - 0.5 ) * halfW * 0.8;
			const x = obb.cx + ux * t + vx * s2, z = obb.cz + uz * t + vz * s2;
			if ( pointInPolygon( x, z, poly ) ) {

				const h0 = roofH( x, z );
				kit.color = [ 0.93, 0.92, 0.89 ];
				kit.vdata = [ 0.6, 0, seed, 0 ];
				const yaw = Math.atan2( - uz, ux );
				kit.box( x, h0 + 0.5, z, 0.55, 1.6, 0.55, yaw, 'bottom' );
				roof.vdata = [ seed, 0.6, 0, 0 ];
				roof.box( x, h0 + 1.38, z, 0.75, 0.12, 0.75, yaw, 'bottom' );

			}

		}

		this.buildings.push( { x: f.cx, z: f.cz, eave, base, storeys, church: isChurch, name: b.name, id: b.id } );

	}

}

// a building's footprints: its outline, or, where a street passes under it (PASSAGES), the two wings either
// side of the passage (the outline clipped to each side of it), the passage noted for _passageBody
Town.prototype._pieces = function ( b ) {

	const outline = OUTLINE[ b.id ] || b.pts, P = PASSAGES[ b.id ];
	const st = P && OSM.streets.find( ( s ) => s.id === P.street );
	if ( ! st ) return [ outline ];
	const [ A, B ] = st.pts, L = Math.hypot( B[ 0 ] - A[ 0 ], B[ 1 ] - A[ 1 ] );
	const u = [ ( B[ 0 ] - A[ 0 ] ) / L, ( B[ 1 ] - A[ 1 ] ) / L ], n = [ u[ 1 ], - u[ 0 ] ];
	const c = ( A[ 0 ] + B[ 0 ] ) / 2 * n[ 0 ] + ( A[ 1 ] + B[ 1 ] ) / 2 * n[ 1 ];
	this.passages.push( { id: b.id, A, B, u, n, half: P.half } );
	const pts = outline[ 0 ][ 0 ] === outline[ outline.length - 1 ][ 0 ] && outline[ 0 ][ 1 ] === outline[ outline.length - 1 ][ 1 ] ? outline.slice( 0, - 1 ) : outline;
	return [ clipHalf( pts, n, c - P.half, - 1 ), clipHalf( pts, n, c + P.half, 1 ) ].filter( ( q ) => q.length >= 3 );

};

// the body over a passage (PASSAGES): from a little over head height up to the lower wing's eave, across
// the passage between the wings and a little past its ends, its two faces arched over it, the soffit
// following the arch, a gabled tiled roof along it
Town.prototype._passageBody = function ( p, rand ) {

	const T = this.terrain, kit = this.walls, roof = this.roofs;
	const wings = this.buildings.filter( ( b ) => b.id === p.id );
	if ( wings.length < 2 ) return;
	const g = Math.max( T.heightAt( ...p.A ), T.heightAt( ...p.B ) );
	const R = p.half, spring = g + 2.5, OVER = 0.3;
	// (up to the lower wing's eave, and at least a storey's worth over the arch)
	const top = Math.max( Math.min( ...wings.map( ( b ) => b.eave ) ), spring + R + 1.4 );
	const c = [ ( p.A[ 0 ] + p.B[ 0 ] ) / 2, ( p.A[ 1 ] + p.B[ 1 ] ) / 2 ], L = Math.hypot( p.B[ 0 ] - p.A[ 0 ], p.B[ 1 ] - p.A[ 1 ] ) + 2 * OVER;
	const at = ( s, a ) => [ c[ 0 ] + p.u[ 0 ] * s + p.n[ 0 ] * a, c[ 1 ] + p.u[ 1 ] * s + p.n[ 1 ] * a ];
	const archY = ( a ) => spring + Math.sqrt( Math.max( 0, R * R - a * a ) );
	kit.color = srgbToLinear( [ 0.93, 0.92, 0.89 ] );
	kit.vdata = [ L, 1, 0.31, 0 ];
	const SUB = 8;
	for ( const [ s, dir ] of [ [ - L / 2, - 1 ], [ L / 2, 1 ] ] ) {

		// a face: from the arch up to the top, in slices across the passage
		for ( let k = 0; k < SUB; k ++ ) {

			const a0 = - R + 2 * R * k / SUB, a1 = a0 + 2 * R / SUB, P0 = at( s, a0 ), P1 = at( s, a1 );
			kit.quadFacing( [ P0[ 0 ], archY( a0 ), P0[ 1 ] ], [ P1[ 0 ], archY( a1 ), P1[ 1 ] ], [ P1[ 0 ], top, P1[ 1 ] ], [ P0[ 0 ], top, P0[ 1 ] ], [ p.u[ 0 ] * dir, 0, p.u[ 1 ] * dir ],
				[ [ a0 + R, archY( a0 ) - g ], [ a1 + R, archY( a1 ) - g ], [ a1 + R, top - g ], [ a0 + R, top - g ] ] );

		}

	}

	for ( let k = 0; k < SUB; k ++ ) {

		// the soffit
		const a0 = - R + 2 * R * k / SUB, a1 = a0 + 2 * R / SUB;
		const P0 = at( - L / 2, a0 ), P1 = at( - L / 2, a1 ), Q0 = at( L / 2, a0 ), Q1 = at( L / 2, a1 );
		kit.quadFacing( [ P0[ 0 ], archY( a0 ), P0[ 1 ] ], [ P1[ 0 ], archY( a1 ), P1[ 1 ] ], [ Q1[ 0 ], archY( a1 ), Q1[ 1 ] ], [ Q0[ 0 ], archY( a0 ), Q0[ 1 ] ], [ 0, - 1, 0 ] );

	}

	// its roof: a gable along the passage, eaves over the wings' walls
	roof.color = [ 1, 1, 1 ];
	roof.vdata = [ rand(), 0.5, 0, 0 ];
	const RISE = 1.0, ridge = [ at( - L / 2, 0 ), at( L / 2, 0 ) ];
	for ( const side of [ - 1, 1 ] ) {

		const e0 = at( - L / 2, side * ( R + 0.35 ) ), e1 = at( L / 2, side * ( R + 0.35 ) );
		roof.quadFacing( [ ridge[ 0 ][ 0 ], top + RISE, ridge[ 0 ][ 1 ] ], [ ridge[ 1 ][ 0 ], top + RISE, ridge[ 1 ][ 1 ] ], [ e1[ 0 ], top - 0.1, e1[ 1 ] ], [ e0[ 0 ], top - 0.1, e0[ 1 ] ],
			[ p.n[ 0 ] * side * 0.7, 1, p.n[ 1 ] * side * 0.7 ], [ [ 0, 0 ], [ L, 0 ], [ L, R + 0.6 ], [ 0, R + 0.6 ] ] );

	}

	const mid = at( 0, 0 );
	this.colliders.addBox( new Vector3( mid[ 0 ], ( spring + top ) / 2, mid[ 1 ] ), new Vector3( L / 2, ( top - spring ) / 2, R ), Math.atan2( - p.u[ 1 ], p.u[ 0 ] ), { walkable: false, tag: 'house' } );

};

// the part of polygon pts on one side (sign -1: n·p <= c, +1: n·p >= c) of the line n·p = c (Sutherland-Hodgman)
function clipHalf( pts, n, c, sign ) {

	const out = [], f = ( q ) => sign * ( q[ 0 ] * n[ 0 ] + q[ 1 ] * n[ 1 ] - c );
	for ( let i = 0; i < pts.length; i ++ ) {

		const a = pts[ i ], b = pts[ ( i + 1 ) % pts.length ], fa = f( a ), fb = f( b );
		if ( fa >= 0 ) out.push( a );
		if ( ( fa >= 0 ) !== ( fb >= 0 ) ) {

			const t = fa / ( fa - fb );
			out.push( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ] );

		}

	}

	if ( out.length ) out.push( out[ 0 ] );
	return out;

}

Town.prototype._crossesStreet = function ( a, b ) {

	const k = Math.floor( ( a[ 0 ] + b[ 0 ] ) / 40 ) * 73856093 ^ Math.floor( ( a[ 1 ] + b[ 1 ] ) / 40 ) * 19349663;
	for ( const [ p, q ] of this.streetSegs.get( k ) || [] ) {

		const d = ( b[ 0 ] - a[ 0 ] ) * ( q[ 1 ] - p[ 1 ] ) - ( b[ 1 ] - a[ 1 ] ) * ( q[ 0 ] - p[ 0 ] );
		if ( Math.abs( d ) < 1e-9 ) continue;
		const t = ( ( p[ 0 ] - a[ 0 ] ) * ( q[ 1 ] - p[ 1 ] ) - ( p[ 1 ] - a[ 1 ] ) * ( q[ 0 ] - p[ 0 ] ) ) / d;
		const u = ( ( p[ 0 ] - a[ 0 ] ) * ( b[ 1 ] - a[ 1 ] ) - ( p[ 1 ] - a[ 1 ] ) * ( b[ 0 ] - a[ 0 ] ) ) / d;
		if ( t >= 0 && t <= 1 && u >= 0 && u <= 1 ) return true;

	}

	return false;

};

// drop the closing duplicate and near-duplicate vertices
function cleanPolygon( pts ) {

	const out = [];
	for ( const p of pts ) {

		const q = out[ out.length - 1 ];
		if ( ! q || Math.hypot( p[ 0 ] - q[ 0 ], p[ 1 ] - q[ 1 ] ) > 0.15 ) out.push( [ p[ 0 ], p[ 1 ] ] );

	}

	while ( out.length > 2 ) {

		const a = out[ 0 ], b = out[ out.length - 1 ];
		if ( Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ] ) <= 0.15 ) out.pop();
		else break;

	}

	return out;

}

// insert vertices where f() changes sign along the edges
function splitAt( poly, f ) {

	const out = [];
	for ( let i = 0; i < poly.length; i ++ ) {

		const a = poly[ i ], b = poly[ ( i + 1 ) % poly.length ];
		out.push( a );
		const fa = f( a ), fb = f( b );
		if ( ( fa < 0 && fb > 0 ) || ( fa > 0 && fb < 0 ) ) {

			const t = fa / ( fa - fb );
			out.push( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ] );

		}

	}

	return out;

}

// Sutherland-Hodgman against lo <= f(q) <= hi (f linear)
function clipBand( poly, f, lo, hi ) {

	const clip = ( P, g ) => {

		const out = [];
		for ( let i = 0; i < P.length; i ++ ) {

			const a = P[ i ], b = P[ ( i + 1 ) % P.length ];
			const ga = g( a ), gb = g( b );
			if ( ga >= 0 ) out.push( a );
			if ( ( ga >= 0 ) !== ( gb >= 0 ) ) {

				const t = ga / ( ga - gb );
				out.push( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ] );

			}

		}

		return out;

	};

	let P = poly;
	if ( lo > - Infinity ) P = clip( P, ( q ) => f( q ) - lo );
	if ( hi < Infinity ) P = clip( P, ( q ) => hi - f( q ) );
	return cleanPolygon( P );

}

// ear clipping for a simple polygon (any winding); returns index triples
export function earcut( poly ) {

	const n = poly.length;
	if ( n < 3 ) return [];
	const area = polygonArea( poly );
	const ccw = area > 0;
	const idx = [];
	for ( let i = 0; i < n; i ++ ) idx.push( i );
	const tris = [];
	const cross = ( a, b, c ) => ( b[ 0 ] - a[ 0 ] ) * ( c[ 1 ] - a[ 1 ] ) - ( b[ 1 ] - a[ 1 ] ) * ( c[ 0 ] - a[ 0 ] );
	const inside = ( p, a, b, c ) => {

		const d1 = cross( a, b, p ), d2 = cross( b, c, p ), d3 = cross( c, a, p );
		return ccw ? ( d1 >= 0 && d2 >= 0 && d3 >= 0 ) : ( d1 <= 0 && d2 <= 0 && d3 <= 0 );

	};

	let guard = 0;
	while ( idx.length > 3 && guard ++ < 4 * n * n ) {

		let found = false;
		for ( let k = 0; k < idx.length; k ++ ) {

			const i0 = idx[ ( k - 1 + idx.length ) % idx.length ], i1 = idx[ k ], i2 = idx[ ( k + 1 ) % idx.length ];
			const a = poly[ i0 ], b = poly[ i1 ], c = poly[ i2 ];
			const cr = cross( a, b, c );
			if ( ccw ? cr <= 1e-9 : cr >= - 1e-9 ) continue; // reflex or degenerate
			let ok = true;
			for ( const j of idx ) {

				if ( j === i0 || j === i1 || j === i2 ) continue;
				if ( inside( poly[ j ], a, b, c ) ) {

					ok = false;
					break;

				}

			}

			if ( ! ok ) continue;
			tris.push( [ i0, i1, i2 ] );
			idx.splice( k, 1 );
			found = true;
			break;

		}

		if ( ! found ) {

			// degenerate leftovers: fan the rest
			for ( let k = 1; k + 1 < idx.length; k ++ ) tris.push( [ idx[ 0 ], idx[ k ], idx[ k + 1 ] ] );
			return tris;

		}

	}

	if ( idx.length === 3 ) tris.push( [ idx[ 0 ], idx[ 1 ], idx[ 2 ] ] );
	return tris;

}

function triNormal( a, b, c ) {

	const ux = b[ 0 ] - a[ 0 ], uy = b[ 1 ] - a[ 1 ], uz = b[ 2 ] - a[ 2 ];
	const vx = c[ 0 ] - a[ 0 ], vy = c[ 1 ] - a[ 1 ], vz = c[ 2 ] - a[ 2 ];
	const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
	const l = Math.hypot( nx, ny, nz ) || 1;
	return [ nx / l, ny / l, nz / l ];

}
