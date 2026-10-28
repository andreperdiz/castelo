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
// fountain, not a house (Walls._portaEste)
const SKIP_ID = new Set( [ 1276312776, 1276312777, 475653566 ] );
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
	299064166: [ 0.27, 0.27, 0.28 ] };
const STOREYS = { 298902328: 2 };

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
		// the Passo da Porta da Vila's dressed stone (Walls._passoPortal): smooth, pale cream
		if ( walls?.passo ) {

			this.walls.color = srgbToLinear( [ 0.93, 0.88, 0.76 ] );
			for ( const b of walls.passo ) {

				this.walls.vdata = [ b.sx, 1, 0.37, 0 ]; // no windows
				this.walls.box( b.x, b.y, b.z, b.sx, b.sy, b.sz, b.yaw, 'bottom' );

			}

		}

		if ( walls?.casaTerrace ) for ( const pts of walls.casaTerrace.lines ) this._parapet( { ...walls.casaTerrace, pts }, PAINT[ 298902328 ] );
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
	// the photo): about a metre wide, each slab 0.5-0.9 m long, nudged a little left or right of the line.
	_slabPath( pts ) {

		const T = this.terrain, kit = this.walls, rand = mulberry32( 2207 );
		kit.color = srgbToLinear( [ 0.82, 0.8, 0.74 ] );
		for ( let i = 0; i + 1 < pts.length; i ++ ) {

			const a = pts[ i ], b = pts[ i + 1 ];
			const L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ), ux = ( b[ 0 ] - a[ 0 ] ) / L, uz = ( b[ 1 ] - a[ 1 ] ) / L;
			const yaw = Math.atan2( - uz, ux );
			for ( let d = 0; d < L - 0.3; ) {

				const len = Math.min( 0.5 + rand() * 0.4, L - d ), w = 0.85 + rand() * 0.3, off = ( rand() - 0.5 ) * 0.3;
				const x = a[ 0 ] + ux * ( d + len / 2 ) - uz * off, z = a[ 1 ] + uz * ( d + len / 2 ) + ux * off;
				const y = T.heightAt( x, z );
				kit.vdata = [ len, 1, rand(), 0 ]; // no windows
				kit.box( x, y - 0.05, z, len - 0.03, 0.14, w, yaw, 'bottom' );
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
