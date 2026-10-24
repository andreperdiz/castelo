import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3, Group } from '../../engine/index.js';
import { standard } from '../../materials/Materials.js';
import { terrainShadingModule, srgb } from '../terrain/TerrainShading.js';
import { OSM, pointInPolygon } from './Geo.js';
import { mulberry32, Noise2D } from '../../util/Noise.js';

// The trees of Óbidos: Italian cypresses (the dark spires in every view of the town), olives (low,
// silvery, gnarled), umbrella pines on the slopes and round citrus / fig trees in the gardens inside
// the walls. One instanced mesh per species: a trunk and a crown of noise-displaced lobes, flat-shaded
// by a foliage material (clumped normals from the shared detail noise, darker inside the crown, a
// little translucency against the light). Placed from the OSM trees, the scrub and woodland mask round
// the walls (within RADIUS of the town) and the open ground of the gardens inside the walls; and the
// trees Walls asks for where a photo shows them (walls.extraTrees: the plane trees inside Porta Este).
const RADIUS = 650;

const SPECIES = {
	cypress: { colour: srgb( 0.11, 0.16, 0.08 ), colour2: srgb( 0.16, 0.21, 0.1 ) },
	olive: { colour: srgb( 0.33, 0.37, 0.27 ), colour2: srgb( 0.4, 0.43, 0.32 ) },
	pine: { colour: srgb( 0.16, 0.22, 0.1 ), colour2: srgb( 0.22, 0.28, 0.13 ) },
	garden: { colour: srgb( 0.13, 0.22, 0.08 ), colour2: srgb( 0.2, 0.3, 0.11 ) },
	plane: { colour: srgb( 0.33, 0.43, 0.18 ), colour2: srgb( 0.5, 0.58, 0.26 ) },
};

export class Trees {

	constructor( { scene, terrain, town = null, walls = null, seed = 77 } ) {

		this.terrain = terrain;
		this.group = new Group();
		this.group.name = 'Trees';
		const rand = mulberry32( seed );
		const noise = new Noise2D( seed );
		const sites = { cypress: [], olive: [], pine: [], garden: [], plane: [] };
		for ( const t of ( walls && walls.extraTrees ) || [] ) sites[ t.kind ].push( t );
		const T = terrain;

		const blocked = ( x, z, clear = 2.5 ) => {

			const k = T.idx( x, z );
			if ( k < 0 ) return true;
			if ( T.path[ k ] > 60 ) return true;
			if ( town && town._inOther( x, z, null ) ) return true;
			if ( walls && walls._nearestWalk( x, z, clear + 1.4 ) ) return true;
			return false;

		};

		// OSM trees
		for ( const [ x, z ] of OSM.trees ) {

			if ( blocked( x, z, 1 ) ) continue;
			const r = rand();
			sites[ r < 0.4 ? 'cypress' : r < 0.7 ? 'olive' : 'pine' ].push( { x, z } );

		}

		// scrub and woodland round the town, and gardens inside the walls
		const step = 6;
		for ( let z = - RADIUS; z <= RADIUS; z += step ) for ( let x = - RADIUS; x <= RADIUS; x += step ) {

			const px = x + ( rand() - 0.5 ) * step * 0.9, pz = z + ( rand() - 0.5 ) * step * 0.9;
			const k = T.idx( px, pz );
			if ( k < 0 ) continue;
			const d = Math.hypot( px, pz * 0.6 );
			if ( d > RADIUS ) continue;
			const scrub = T.gully[ k ] / 255;
			const inside = T.inside[ k ];
			const n = noise.fbm( px / 60, pz / 60, 2 ) * 0.5 + 0.5;
			let p = 0, kind = null;
			if ( inside ) {

				// gardens and yards: open ground among the houses
				p = 0.045 + 0.08 * smooth( 0.55, 0.75, n );
				const r = rand();
				kind = r < 0.35 ? 'cypress' : r < 0.6 ? 'olive' : 'garden';

			} else if ( scrub > 0.3 ) {

				p = ( 0.12 + 0.35 * n ) * scrub;
				const r = rand();
				kind = r < 0.42 ? 'olive' : r < 0.72 ? 'pine' : r < 0.86 ? 'cypress' : 'garden';

			} else if ( T.scarp[ k ] > 120 ) {

				// gardens of the houses outside the walls
				p = 0.06;
				const r = rand();
				kind = r < 0.4 ? 'cypress' : r < 0.6 ? 'olive' : 'garden';

			} else if ( T.sand[ k ] > 120 ) {

				// lone trees and lines along the field edges
				p = 0.008 + 0.03 * smooth( 0.65, 0.8, n );
				kind = rand() < 0.7 ? 'olive' : 'cypress';

			}

			if ( ! kind || rand() > p ) continue;
			if ( blocked( px, pz, inside ? 4 : 3 ) ) continue;
			sites[ kind ].push( { x: px, z: pz } );

		}

		this.counts = {};
		const m = new Matrix4(), q = new Quaternion(), s = new Vector3(), pos = new Vector3(), up = new Vector3( 0, 1, 0 );
		for ( const [ kind, list ] of Object.entries( sites ) ) {

			if ( list.length === 0 ) continue;
			const geo = buildSpecies( kind, rand );
			const mat = foliageMaterial( kind );
			const mesh = new InstancedMesh( geo, mat, list.length );
			list.forEach( ( p, i ) => {

				const sc = p.scale ?? ( kind === 'cypress' ? 0.75 + rand() * 0.5 : 0.7 + rand() * 0.55 );
				s.set( sc * ( 0.9 + rand() * 0.2 ), sc, sc * ( 0.9 + rand() * 0.2 ) );
				q.setFromAxisAngle( up, rand() * Math.PI * 2 );
				pos.set( p.x, T.heightAt( p.x, p.z ) - 0.15, p.z );
				m.compose( pos, q, s );
				mesh.setMatrixAt( i, m );

			} );
			mesh.name = 'trees-' + kind;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.frustumCulled = false;
			this.group.add( mesh );
			this.counts[ kind ] = list.length;

		}

		scene.add( this.group );

	}

}

const smooth = ( a, b, x ) => {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

// ---------------------------------------------------------------- geometry

// accumulates smooth-shaded parts; vdata.x = 0 trunk, 1 foliage; vdata.y = height in the crown 0..1
class Parts {

	constructor() {

		this.pos = []; this.nrm = []; this.data = []; this.idx = []; this.n = 0;

	}

	// lat-long ellipsoid lobe centred at c with radii r, displaced by noise along the normal
	lobe( c, r, rand, { rings = 7, segs = 10, bump = 0.22, crownY = [ 0, 1 ] } = {} ) {

		const base = this.n;
		const ph = rand() * 10;
		for ( let i = 0; i <= rings; i ++ ) {

			const v = i / rings, th = v * Math.PI;
			for ( let j = 0; j <= segs; j ++ ) {

				const u = j / segs, phi = u * Math.PI * 2;
				let nx = Math.sin( th ) * Math.cos( phi ), ny = Math.cos( th ), nz = Math.sin( th ) * Math.sin( phi );
				const k = 1 + bump * ( Math.sin( phi * 3 + ph ) * Math.sin( th * 4 + ph * 0.7 ) * 0.6 + Math.sin( phi * 7 - ph ) * Math.sin( th * 6 ) * 0.4 );
				const x = c[ 0 ] + nx * r[ 0 ] * k, y = c[ 1 ] + ny * r[ 1 ] * k, z = c[ 2 ] + nz * r[ 2 ] * k;
				// ellipsoid normal
				const gx = nx / r[ 0 ], gy = ny / r[ 1 ], gz = nz / r[ 2 ], gl = Math.hypot( gx, gy, gz ) || 1;
				this.pos.push( x, y, z );
				this.nrm.push( gx / gl, gy / gl, gz / gl );
				this.data.push( 1, Math.min( 1, Math.max( 0, ( y - crownY[ 0 ] ) / ( crownY[ 1 ] - crownY[ 0 ] ) ) ), 0, 0 );
				this.n ++;

			}

		}

		for ( let i = 0; i < rings; i ++ ) for ( let j = 0; j < segs; j ++ ) {

			const a = base + i * ( segs + 1 ) + j, b = a + segs + 1;
			this.idx.push( a, a + 1, b, a + 1, b + 1, b );

		}

	}

	// tapered cylinder from y0 to y1, bent by lean (x, z offset at the top), its foot at foot (x, z)
	trunk( r0, r1, y0, y1, lean = [ 0, 0 ], segs = 6, rings = 3, foot = [ 0, 0 ] ) {

		const base = this.n;
		for ( let i = 0; i <= rings; i ++ ) {

			const v = i / rings, y = y0 + ( y1 - y0 ) * v, r = r0 + ( r1 - r0 ) * v;
			const ox = foot[ 0 ] + lean[ 0 ] * v * v, oz = foot[ 1 ] + lean[ 1 ] * v * v;
			for ( let j = 0; j <= segs; j ++ ) {

				const a = j / segs * Math.PI * 2;
				const nx = Math.cos( a ), nz = Math.sin( a );
				this.pos.push( ox + nx * r, y, oz + nz * r );
				this.nrm.push( nx, 0, nz );
				this.data.push( 0, 0, 0, 0 );
				this.n ++;

			}

		}

		for ( let i = 0; i < rings; i ++ ) for ( let j = 0; j < segs; j ++ ) {

			const a = base + i * ( segs + 1 ) + j, b = a + segs + 1;
			this.idx.push( a, b, a + 1, a + 1, b, b + 1 );

		}

	}

	build() {

		const g = new BufferGeometry();
		g.setAttribute( 'position', new Float32BufferAttribute( this.pos, 3 ) );
		g.setAttribute( 'normal', new Float32BufferAttribute( this.nrm, 3 ) );
		g.setAttribute( 'vdata', new Float32BufferAttribute( this.data, 4 ) );
		g.setIndex( new Uint32BufferAttribute( this.idx, 1 ) );
		g.computeBoundingBox();
		g.computeBoundingSphere();
		return g;

	}

}

function buildSpecies( kind, rand ) {

	const P = new Parts();
	if ( kind === 'cypress' ) {

		// a narrow spire ~11 m: stacked lobes tapering to a point
		const H = 10 + rand() * 2;
		P.trunk( 0.18, 0.12, - 0.3, 1.2 );
		const n = 7;
		for ( let i = 0; i < n; i ++ ) {

			const t = i / ( n - 1 );
			const y = 1.0 + t * ( H - 2.2 );
			const r = 1.05 * Math.sin( Math.min( 1, ( 1 - t ) * 1.25 + 0.15 ) * Math.PI * 0.5 ) * ( 1 - t * 0.55 ) + 0.12;
			P.lobe( [ ( rand() - 0.5 ) * 0.15, y, ( rand() - 0.5 ) * 0.15 ], [ r, 1.6, r ], rand, { rings: 6, segs: 9, bump: 0.18, crownY: [ 0.5, H ] } );

		}

	} else if ( kind === 'olive' ) {

		// gnarled, leaning trunk, a broad uneven crown of 4 lobes ~4.5 m tall
		const lean = [ ( rand() - 0.5 ) * 0.8, ( rand() - 0.5 ) * 0.8 ];
		P.trunk( 0.32, 0.2, - 0.3, 2.0, lean, 7, 4 );
		for ( let i = 0; i < 4; i ++ ) {

			const a = i / 4 * Math.PI * 2 + rand();
			const d = 0.6 + rand() * 0.6;
			P.lobe( [ lean[ 0 ] + Math.cos( a ) * d, 2.7 + rand() * 0.9, lean[ 1 ] + Math.sin( a ) * d ], [ 1.4 + rand() * 0.5, 1.0 + rand() * 0.3, 1.4 + rand() * 0.5 ], rand, { bump: 0.3, crownY: [ 1.6, 4.4 ] } );

		}

	} else if ( kind === 'pine' ) {

		// umbrella pine: tall bare trunk, a wide flat crown ~10 m up
		const lean = [ ( rand() - 0.5 ) * 1.2, ( rand() - 0.5 ) * 1.2 ];
		P.trunk( 0.3, 0.18, - 0.3, 8.5, lean, 6, 4 );
		for ( let i = 0; i < 5; i ++ ) {

			const a = i / 5 * Math.PI * 2 + rand();
			const d = i === 0 ? 0 : 1.6 + rand() * 0.8;
			P.lobe( [ lean[ 0 ] + Math.cos( a ) * d, 9.2 + rand() * 0.6, lean[ 1 ] + Math.sin( a ) * d ], [ 2.4 + rand() * 0.6, 1.0, 2.4 + rand() * 0.6 ], rand, { bump: 0.25, crownY: [ 8.2, 10.6 ] } );

		}

	} else if ( kind === 'plane' ) {

		// London plane, old and big: a thick trunk forking at ~3.5 m into leaning limbs, a high broad
		// crown ~14 m up and as much across
		P.trunk( 0.6, 0.42, - 0.3, 3.6, [ 0.15, 0 ], 9, 3 );
		const limbs = 4;
		for ( let i = 0; i < limbs; i ++ ) {

			const a = i / limbs * Math.PI * 2 + rand() * 0.8, out = 2.2 + rand() * 1.4;
			const lean = [ Math.cos( a ) * out, Math.sin( a ) * out ];
			P.trunk( 0.3, 0.14, 3.3, 8.5 + rand() * 1.5, lean, 7, 4, [ 0.15, 0 ] );

		}

		// clumps of leaves round the limbs' ends and over the middle, open between them
		for ( let i = 0; i < 14; i ++ ) {

			const a = i / 14 * Math.PI * 2 * 3 + rand(), d = i < 2 ? rand() * 1.5 : 2.4 + rand() * 2.8;
			const y = 7.5 + rand() * 4.5 + ( d < 2 ? 2 : 0 );
			const r = 1.7 + rand() * 1.0;
			P.lobe( [ Math.cos( a ) * d, y, Math.sin( a ) * d ], [ r, r * 0.75, r ], rand, { rings: 6, segs: 9, bump: 0.35, crownY: [ 6, 14 ] } );

		}

	} else {

		// garden tree (orange, lemon, fig): a short trunk and a round crown ~4 m
		P.trunk( 0.16, 0.11, - 0.3, 1.4 );
		for ( let i = 0; i < 3; i ++ ) {

			const a = i / 3 * Math.PI * 2 + rand();
			P.lobe( [ Math.cos( a ) * 0.5, 2.6 + rand() * 0.5, Math.sin( a ) * 0.5 ], [ 1.3, 1.2, 1.3 ], rand, { bump: 0.25, crownY: [ 1.4, 4.0 ] } );

		}

	}

	return P.build();

}

// ---------------------------------------------------------------- material

function foliageMaterial( kind ) {

	const sp = SPECIES[ kind ];
	const m = standard( {
		name: 'Trees-' + kind,
		roughness: 0.85, metalness: 0,
		side: 'double',
		attributes: { vdata: 'vec4f' },
		varyings: { vData: 'vec4f', vSeed: 'f32' },
		vertex: /* wgsl */`
	o.vData = v.vdata;
	o.vSeed = fract( f32( v.instance ) * 0.61803398875 );
	// the crowns sway a little in the wind (more at the top)
	let sway = sin( frame.time * 1.1 + f32( v.instance ) * 1.7 ) * 0.04 + sin( frame.time * 2.3 + f32( v.instance ) ) * 0.015;
	let k = v.vdata.x * max( v.position.y, 0.0 ) * 0.06;
	v.worldOffset = vec3f( frame.windDir.x, 0.0, frame.windDir.y ) * sway * k * ( 0.5 + frame.windSpeed * 0.1 );
`,
	} );
	m.modules = [ terrainShadingModule() ];
	m.surface = /* wgsl */`
	let d = in.vs.vData;
	let seed = in.vs.vSeed;
	let P = in.P;
	// (sampled in uniform control flow)
	let bark = textureSample( terrainDetailTex, smpAniso4Repeat, vec2f( atan2( P.x, P.z ) * 0.3, P.y * 0.8 ) ).y;
	let n1 = textureSample( terrainDetailTex, smpAniso4Repeat, P.xz * 0.9 + P.y * 0.45 + seed ).w;
	let n2 = textureSample( terrainDetailTex, smpAniso4Repeat, P.zy * 2.3 + P.x * 0.7 + seed * 3.0 ).w;
	if ( d.x < 0.5 ) {
		s.albedo = ${ srgb( 0.3, 0.26, 0.22 ) } * ( bark * 0.5 + 0.6 );
		${ kind === 'plane' ? `// plane bark: flaking in patches of cream, grey-green and olive
		let flake = textureSample( terrainDetailTex, smpAniso4Repeat, vec2f( P.x * 0.9 + P.z * 0.7, P.y * 0.6 + P.z * 0.5 ) * 0.7 + seed ).w;
		s.albedo = mix( ${ srgb( 0.5, 0.47, 0.37 ) }, ${ srgb( 0.72, 0.68, 0.55 ) }, smoothstep( 0.38, 0.68, flake ) );
		s.albedo = mix( s.albedo, ${ srgb( 0.45, 0.45, 0.32 ) }, smoothstep( 0.6, 0.8, bark ) * 0.5 );` : '' }
		s.roughness = 0.9;
	} else {
		// foliage: leaf clumps from two scales of the detail noise, darker deep in the crown and low down
		let clump = smoothstep( 0.35, 0.7, n1 * 0.6 + n2 * 0.4 );
		var col = mix( ${ sp.colour }, ${ sp.colour2 }, clump );
		col = col * ( 0.8 + seed * 0.35 );
		col = col * mix( 0.55, 1.0, smoothstep( 0.0, 0.7, d.y ) );
		s.albedo = col;
		s.roughness = 0.8;
		s.normal = normalize( in.N + ( vec3f( n1, n2, n1 * n2 ) - 0.4 ) * 0.9 );
		s.ao = mix( 0.55, 1.0, clump ) * mix( 0.6, 1.0, d.y );
	}
`;
	return m;

}

export { SPECIES };
